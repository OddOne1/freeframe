"""SocialSnippet clip detection: which spans of a transcript are worth cutting.

No model, no network, no database -- plain functions over plain data, like
services/snippet_transcribe.py, so every rule can be tested without a
transcript in a table. The database side (loading words, writing
`snippets` rows, the replace rules) lives in tasks/transcribe_tasks.py and
in scripts/snippet_detect.py.

There is no AI model here and there is not meant to be one. This is
"keyword-v2": every candidate window is checked against hard rules (one
complete thought, inside one speaker's turn) and then SCORED by counting
things in its words -- first-person stories, strong claims, numbers and
names, retake talk, fillers -- with every weight a named constant below.
The score goes to `snippets.quality_score` on a 0.0 to 1.0 scale (the same
range scripts/snippet_import.py accepts for imported scores), and
`generator` is "keyword-v2" so these rows are told apart from the older
"tfidf-v1" ones. `viral_score` stays NULL: nothing here predicts reach.
The previous detector is kept, frozen, in services/snippet_detect_v1.py
for scripts/snippet_detect_compare.py and nothing else.

Data shapes
-----------
A word, as `transcript_words` stores it -- times in MILLISECONDS, absolute
within the track (`transcript_segments` is where the track lives, so the
caller groups by it)::

    {"start_ms": 1200, "end_ms": 1600, "word": " Hallo"}

``words_by_track`` is ``{track_index: [word, ...]}``, each list in time
order. ONE TRACK IS ONE SPEAKER (models/snippet.py), which is why a window
never spans tracks: a clip that cuts across two mics has two people
talking over each other. Other tracks are still read, to see where a
speaker's turn ends and whether a window answers somebody's question.

The "media file" `detect_snippets` takes is a plain dict, not an ORM row::

    {"media_file_id": "<uuid as str>",       # carried through untouched
     "duration_ms": 3420000 | None,          # for the per-file cap
     "tracks": {0: {"speaker": "Anna Example" | None,
                    "speaker_id": "<uuid as str>" | None,
                    "words": [word, ...]}}}

Track keys may be ``int`` or ``str``: the same dict comes back from JSON in
the scripts, where keys are strings.

Reason codes
------------
Every scored window carries `reasons`, a list of short codes, so a person
(scripts/snippet_detect.py --dry-run, snippet_detect_compare.py) can see
WHY it scored as it did: ``+code`` raised the score, ``-code`` lowered it,
``!code`` rejected the window outright. The codes are the REASON_* and
REJECT_* names below.
"""

from __future__ import annotations

import bisect
import math
import re
from collections import Counter
from typing import Iterable, Optional

# ── The window rules ─────────────────────────────────────────────────────────
#
# Module constants rather than pydantic settings: adding a setting means
# documenting it in .env.example. The length rules and the selection limits
# are also keyword arguments on build_candidates/detect_snippets, so a
# caller can override them without editing this file.

#: Under 15 s a clip rarely holds a whole thought with its point.
MIN_DURATION_MS = 15_000
#: Over 45 s it stops being a social clip.
MAX_DURATION_MS = 45_000
#: The lengths most short-form platforms still show in full; inside it a
#: window gets SCORE_IDEAL_LENGTH.
IDEAL_MIN_MS = 20_000
IDEAL_MAX_MS = 35_000
#: 15 s at a slow two words a second is 30 words; 25 leaves room for a slow
#: speaker and still rejects a window that is mostly silence.
MIN_WORDS = 25
#: A pause longer than this inside a window is a cut, not a breath.
MAX_INTERNAL_GAP_MS = 2_000
#: A NEW suggestion may share at most this much of the shorter span with a
#: clip a re-run keeps (approved, rejected, imported, hand-made, edited).
#: Unchanged from v1 -- see drop_overlapping.
MAX_OVERLAP_RATIO = 0.30

#: `snippets.quote` is TEXT, so this is an editorial limit, not a column one.
QUOTE_MAX_CHARS = 300
#: `snippets.title` is String(255); 60 is what a card can show.
TITLE_MAX_CHARS = 60
#: Topics stored per clip; a title uses the first two or three.
TOPIC_COUNT = 4

#: Written to every row this module produces, so v2 rows are told apart
#: from the "tfidf-v1" ones already stored.
GENERATOR = "keyword-v2"
#: models/snippet.py SNIPPET_SOURCES. Unchanged, so replaceable_snippets
#: still finds (and may replace) the v1 rows.
SOURCE = "keyword"
STATUS_SUGGESTED = "suggested"

#: A bigram is a topic only if it occurs at least this often -- twice in
#: the window, or in two sentences of the file. Once, it is two words that
#: happened to touch ("dropped everywhere"); twice, it is a phrase the
#: speaker uses ("social media").
BIGRAM_MIN_OCCURRENCES = 2
#: A bigram is preferred over its own words when it scores at least this
#: share of the better one. "social media" beating 0.8 x "media" is a real
#: phrase; below that the single word is carrying the meaning.
BIGRAM_PREFERENCE = 0.80

#: A topic term the speaker wrote with a capital letter mid-sentence counts
#: this much more: in English that is a name ("Vienna"), in German a noun
#: ("Weinberg") rather than a verb or an adjective.
TOPIC_CAPITALISED_WEIGHT = 1.5

#: Between topics in a generated title.
TITLE_SEPARATOR = " · "

# ── Turns ────────────────────────────────────────────────────────────────────

#: A silence at least this long after a window's last word means the
#: speaker stopped there: the thought ended rather than being cut.
THOUGHT_PAUSE_MS = 700
#: A silence at least this long BETWEEN two sentences inside a window is
#: the speaker finishing one thought and starting the next: the window
#: holds two thoughts (see PENALTY_THOUGHT_BREAK).
THOUGHT_BREAK_MS = 1_000
#: Another speaker's words closer together than this are ONE interjection.
INTERJECTION_GAP_MS = 1_000
#: An interjection longer than this is the other person taking the turn,
#: so a window containing one is not inside a single speaker's turn.
#: "Yeah, totally, right" stays a backchannel; "wait, what did you mean
#: by that" is a new turn.
INTERJECTION_MAX_WORDS = 4
#: This many interjections inside one window is fast back-and-forth: two
#: people talking, not one person making a point.
RAPID_INTERJECTIONS = 2
#: A window that starts within this long after ANOTHER speaker's question
#: ended is that question's answer -- the clip keeps only the answer.
ANSWER_LEAD_MS = 10_000
#: Whisper capitalises sentence starts; a track where fewer than this share
#: of sentences start with a capital letter is transcribed without case,
#: and the mid-sentence check (a lower-case start) is skipped for it.
CAPITALISED_TRACK_SHARE = 0.50

# ── Selection ────────────────────────────────────────────────────────────────

#: A window scoring below this is never offered. A window with nothing for
#: or against it scores SCORE_BASE (0.35); it needs +0.15 of real substance
#: -- a dense topic and a story, or a claim with specifics -- net of its
#: faults to clear this.
MIN_QUALITY_SCORE = 0.50
#: Every file may offer at least this many clips, however short.
MIN_CLIPS_PER_FILE = 3
#: ...and one more for every this many minutes: a 57-minute interview
#: gets 15, not the hundreds of windows that pass the rules.
MINUTES_PER_CLIP = 4
#: Two clips' STARTS are at least this far apart, across the whole file,
#: so the list is spread over the conversation rather than bunched up.
MIN_START_SPACING_MS = 20_000

# ── Scoring: base, boosts, penalties ─────────────────────────────────────────
#
# score = SCORE_BASE + boosts - penalties, clamped to 0..1. Each boost or
# penalty grows linearly from its "free" level to its "full" level and is
# capped there, so one feature can never dominate. Rates are per word, so
# a long window does not win just by having more words.

#: Where a window with nothing for or against it sits: below the bar, so
#: being a well-formed sentence run is not enough on its own. Every boost
#: together is 0.73, so only a window strong on almost every count reaches
#: 1.0 and the top of the ranking still separates.
SCORE_BASE = 0.35

#: First person ("I", "we", "my", "ich", "wir"): someone speaking from
#: their own experience, which is what makes a clip personal.
SCORE_FIRST_PERSON = 0.10
#: One first-person word in sixteen is ordinary storytelling density.
FIRST_PERSON_FULL_RATE = 0.06
#: Past-tense narrative ("we went", "I was", "damals"): a story.
SCORE_STORY = 0.08
#: One past-tense word in twenty-five is a story being told.
STORY_FULL_RATE = 0.04
#: Opinions and strong claims ("never", "the biggest", "the reason"):
#: the line people share.
SCORE_OPINION = 0.10
#: Two such claims make a point; more is not more.
OPINION_FULL_HITS = 2
#: Numbers and named things (a figure, a brand, a place): specifics are
#: what make a clip concrete.
SCORE_SPECIFICS = 0.08
#: Three specifics is a concrete clip.
SPECIFICS_FULL_HITS = 3
#: Emotional intensity: exclamations, superlatives, "love", "insane".
SCORE_EMOTION = 0.06
#: Two markers is a clip with energy; more is shouting.
EMOTION_FULL_HITS = 2
#: Topic density: distinct meaningful terms per word. Many different
#: content words means the clip is ABOUT something.
SCORE_DENSITY = 0.10
#: Below this share of distinct content words there is no density bonus...
DENSITY_FREE_RATE = 0.15
#: ...and at this share it is full.
DENSITY_FULL_RATE = 0.35
#: Answers another speaker's question: the interview's natural clip shape.
SCORE_ANSWER = 0.08
#: Between IDEAL_MIN_MS and IDEAL_MAX_MS long. Deliberately smaller than
#: SCORE_CLEAN_END: stopping where the thought stops beats padding a
#: window out to the ideal length.
SCORE_IDEAL_LENGTH = 0.03
#: Ends where the speaker paused or handed over (THOUGHT_PAUSE_MS): the
#: end of a thought, not the middle of the next one.
SCORE_CLEAN_END = 0.06
#: Starts after a pause of THOUGHT_PAUSE_MS, after another speaker, or at
#: the start of the track: the beginning of a thought, not its middle.
SCORE_CLEAN_START = 0.04

#: Retake and production talk ("go again", "take two", "rolling",
#: "nochmal"), per phrase found. One incidental "sorry" costs a strong clip
#: a little; two or three sink anything.
PENALTY_RETAKE_PER_HIT = 0.15
PENALTY_RETAKE_MAX = 0.45
#: Fillers ("um", "you know", "äh", "halt"): a share of words this high
#: is somebody searching for words, not saying them.
PENALTY_FILLER = 0.25
#: Up to one word in twenty-five may be a filler at no cost...
FILLER_FREE_RATE = 0.04
#: ...and at one in seven the full penalty applies.
FILLER_FULL_RATE = 0.15
#: The same word twice in a row ("I I I think", "the the"): restarts.
PENALTY_REPEATS = 0.15
#: One doubled word per hundred is a slip; five is a speaker restarting.
REPEAT_FREE_RATE = 0.01
REPEAT_FULL_RATE = 0.05
#: Low lexical diversity (distinct words / words): repetitive chatter.
#: Ordinary speech over 40 to 110 words sits around 0.55 to 0.70.
PENALTY_LOW_DIVERSITY = 0.20
DIVERSITY_FREE_RATIO = 0.50
DIVERSITY_FULL_RATIO = 0.30
#: More than this share of the sentences are questions: an interviewer
#: asking, not someone saying something.
PENALTY_MOSTLY_QUESTIONS = 0.15
MOSTLY_QUESTIONS_SHARE = 0.50
#: The window ends on a question nobody answers inside it.
PENALTY_ENDS_ON_QUESTION = 0.08
#: Fast back-and-forth: per interjection from RAPID_INTERJECTIONS on, so
#: two cost 0.08 and four cost 0.24 (capped), the more cut-up the window
#: the lower it sinks.
PENALTY_RAPID_TURNS_PER_INTERJECTION = 0.08
PENALTY_RAPID_TURNS_MAX = 0.30
#: Fewer distinct content terms than this: nothing to title, little said.
PENALTY_THIN = 0.15
MIN_CONTENT_TERMS = 5
#: Per thought break (THOUGHT_BREAK_MS) inside the window: one clip, one
#: thought. Two thoughts in a row are sometimes fine, so this lowers the
#: score rather than rejecting -- but a window that stops at the first
#: thought's end beats one padded with the next.
PENALTY_THOUGHT_BREAK = 0.06
PENALTY_THOUGHT_BREAK_MAX = 0.18
#: The last sentence is a tag with no content ("You know?", "Yeah."):
#: the thought ended one sentence earlier.
PENALTY_WEAK_END = 0.08
WEAK_END_MAX_WORDS = 4

# ── Reason codes (see the module docstring) ──────────────────────────────────

REASON_FIRST_PERSON = "first_person"
REASON_STORY = "story"
REASON_OPINION = "opinion"
REASON_SPECIFICS = "specifics"
REASON_EMOTION = "emotion"
REASON_DENSITY = "dense_topics"
REASON_ANSWER = "answers_question"
REASON_IDEAL_LENGTH = "ideal_length"
REASON_CLEAN_END = "clean_end"
REASON_CLEAN_START = "clean_start"
REASON_THOUGHT_BREAK = "two_thoughts"
REASON_RETAKE = "retake"
REASON_FILLER = "filler"
REASON_REPEATS = "repeats"
REASON_LOW_DIVERSITY = "low_diversity"
REASON_MOSTLY_QUESTIONS = "mostly_questions"
REASON_ENDS_ON_QUESTION = "ends_on_question"
REASON_RAPID_TURNS = "rapid_turns"
REASON_THIN = "thin"
REASON_WEAK_END = "weak_end"
#: Rejections: the window breaks a hard rule and is never offered.
REJECT_MID_SENTENCE_START = "starts_mid_sentence"
REJECT_FILLER_START = "starts_with_filler"
REJECT_MID_SENTENCE_END = "ends_mid_sentence"
REJECT_CROSSES_TURN = "crosses_turn"
REJECT_LOW_SCORE = "below_min_score"


# ── Word lists ───────────────────────────────────────────────────────────────
#
# English and German, both always on: the pipeline detects language per
# TRACK rather than per project, so the scorer is not told which to
# expect, and the lists barely collide. Lower case, apostrophes as "'".


def _words(text: str) -> frozenset:
    return frozenset(text.split())


def _phrases(text: str) -> frozenset:
    """Comma-separated phrases, each a tuple of words."""
    return frozenset(tuple(p.split()) for p in text.split(",") if p.strip())


#: What a clip may not START with: a filler or backchannel, or a
#: conjunction that continues the previous thought ("and", "but", "so").
FILLER_STARTS = _words("""
yeah yes yep yup okay ok so and um uh uhm umm erm er ah eh oh mhm hmm mm
like but or because cause anyway right
ja jo also und äh ähm öhm hm na naja genau aber oder weil gut
""")

#: Fillers, counted for the filler ratio. "like" is left out: it is far
#: more often the verb than the filler, and the two cannot be told apart
#: without a parser.
FILLERS = _words("""
um uh uhm umm erm er ah eh hmm mm mhm basically literally actually totally
kinda sorta
äh ähm öhm hm halt eben quasi sozusagen irgendwie
""")
FILLER_PHRASES = _phrases("""
you know, i mean, sort of, kind of, or something, and stuff, and everything,
sag ich mal, weißt du, oder so
""")

#: Words another speaker may say inside a window without taking the turn.
BACKCHANNEL = _words("""
yeah yes yep yup mhm mm hmm uh huh right okay ok wow sure exactly true
totally oh ah nice cool really absolutely
ja genau aha stimmt krass echt nee nein absolut richtig achso
""")

#: Retake and production talk.
RETAKE_PHRASES = _phrases("""
go again, going again, take two, take 2, take three, one more time,
rolling, we're rolling, are we rolling, cut, sorry, can we, is it recording,
are we recording, is this recording, mic, mics, microphone, check,
start again, start over, from the top, let me try that again,
let me start again, are you ready, you ready, ready when you are,
nochmal, noch mal, noch einmal, läuft es, kamera läuft, ton läuft,
läuft die kamera, nimmt es auf, aufnahme, entschuldigung, können wir,
mikro, mikrofon, von vorne, neu anfangen, schnitt, bist du bereit
""")

FIRST_PERSON = _words("""
i i'm i've i'll i'd me my mine myself we we're we've we'll we'd us our ours
ourselves
ich mich mir mein meine meinen meinem meiner meines wir uns unser unsere
unseren unserem unserer
""")

#: Past tense that no suffix rule finds.
PAST_TENSE = _words("""
was were had went said told came got did made took saw knew thought found
left became began felt heard met ran sat stood brought bought built caught
fell gave grew held kept lost paid put read sent spent taught understood
won wrote
war waren warst hatte hatten hattest wurde wurden ging gingen kam kamen
sagte dachte wusste damals früher plötzlich gemacht gesagt gedacht gesehen
gegangen gekommen gelernt gemerkt gewusst gehabt gewesen gefunden gespielt
gearbeitet gekauft gebaut gestartet geschafft gefragt getroffen verloren
angefangen erlebt erzählt entschieden bekommen passiert geworden gesprochen
""")
#: "-ed" words that are not a past tense.
_ED_EXCEPTIONS = _words("""
need feed seed bed red shed speed indeed hundred weed breed proceed exceed
succeed embed sled bled fled bred shred sacred naked wicked
""")
_ED_RE = re.compile(r"^[a-z]{3,}ed$")

OPINION_WORDS = _words("""
never always best worst biggest greatest most truth honestly believe mistake
mistakes secret nobody everyone everybody wrong important problem key
nie niemals immer beste besten schlimmste schlimmsten größte größten
wichtigste wichtigsten wahrheit ehrlich fehler geheimnis niemand jeder
falsch
""")
OPINION_PHRASES = _phrases("""
the reason, the problem, the truth, the key, the secret, the thing is,
no one, i believe, i'm convinced, have to, has to,
der grund, das problem, die wahrheit, das wichtigste, ich glaube,
ich bin überzeugt
""")

EMOTION_WORDS = _words("""
love hate amazing incredible insane crazy unbelievable terrible awful
beautiful fantastic scared afraid angry proud cried laughed wow brilliant
liebe hasse wahnsinn wahnsinnig unglaublich schrecklich furchtbar
wunderschön angst stolz geweint gelacht geil irre
""")
#: "-est" words that are not a superlative.
_EST_EXCEPTIONS = _words("""
honest interest forest harvest suggest request invest protest contest
earnest modest manifest digest arrest guest chest nest rest test west
""")
_EST_RE = re.compile(r"^[a-z]{3,}est$")

NUMBER_WORDS = _words("""
ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen
nineteen twenty thirty forty fifty sixty seventy eighty ninety
hundred hundreds thousand thousands million millions billion billions
percent dozen half
zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn
neunzehn zwanzig dreißig vierzig fünfzig sechzig siebzig achtzig
neunzig hundert hunderte tausend tausende million millionen milliarde
milliarden prozent dutzend hälfte
""")

#: Swear words, matched whole.
_PROFANE_WORDS = _words("""
damn damned dammit goddamn goddamned bitch bitches bastard bastards ass asses
asshole assholes arse arsehole crap crappy dick dicks piss pissed wtf
arsch verdammt verdammte verdammter verdammten kacke hure huren
""")
#: ...and matched anywhere inside a word, so "fucking", "bullshit" and
#: "scheißegal" are caught without listing every form.
_PROFANE_PARTS = ("fuck", "shit", "cunt", "motherf", "scheiß", "scheiss",
                  "fick", "wichs", "fotze", "hurensohn", "arschloch")


def is_profane(word: str) -> bool:
    """Is this word a swear word? Allowed in a quote, never in a title or topic."""
    w = (word or "").lower().strip("'")
    return w in _PROFANE_WORDS or any(part in w for part in _PROFANE_PARTS)


# ── Sentences ────────────────────────────────────────────────────────────────

#: What ends a sentence. Closing quotes and brackets are stripped first, so
#: `welt."` counts.
_TERMINAL = ".!?…"
_TRAILING = "\"'»”’)]}"


def _ends_sentence(text: str) -> bool:
    """Does this word end a sentence?

    Punctuation only -- no abbreviation list. "z.B." and "Dr." therefore end
    a sentence early, which costs a boundary rather than a window: windows
    are built from CONSECUTIVE sentences, so an extra split only gives the
    selector more places to start and stop. (v2 then refuses to START at
    the lower-case word after "z.B.", which is the right answer anyway.)
    """
    stripped = (text or "").strip().rstrip(_TRAILING)
    return bool(stripped) and stripped[-1] in _TERMINAL


def _ends_thought(text: str) -> bool:
    """Does this sentence END a thought: ".", "!" or "?" -- not "..."?

    Whisper writes a trailing-off sentence with an ellipsis, and leaves the
    last one of a file unpunctuated; both are a thought that was cut, not
    finished, so a clip may not end on them.
    """
    stripped = (text or "").strip().rstrip(_TRAILING)
    if not stripped or stripped[-1] not in ".!?":
        return False
    return not stripped.endswith("..")


def join_words(words: Iterable[dict]) -> str:
    """The readable text of a run of words.

    Whisper emits words with a leading space (" Hallo"); each is stripped
    and rejoined with exactly one space, so the text does not depend on how
    the model spaced its tokens.
    """
    return " ".join(
        part for part in ((w.get("word") or "").strip() for w in words) if part
    )


def _usable(words) -> list:
    """Words with the two times this module needs, in time order."""
    out = []
    for w in words or []:
        try:
            start = int(w["start_ms"])
            end = int(w["end_ms"])
        except (KeyError, TypeError, ValueError):
            continue
        out.append({"start_ms": start, "end_ms": max(start, end), "word": w.get("word") or ""})
    out.sort(key=lambda w: (w["start_ms"], w["end_ms"]))
    return out


def build_sentences(words) -> list:
    """Consecutive words joined into sentences at terminal punctuation.

    A trailing run with no terminal punctuation is still a sentence: Whisper
    often leaves the last one unfinished, and dropping it would lose the end
    of every file. (v2 never ENDS a clip on it -- see _ends_thought.)
    """
    sentences, current = [], []
    for word in _usable(words):
        current.append(word)
        if _ends_sentence(word["word"]):
            sentences.append(_sentence(current))
            current = []
    if current:
        sentences.append(_sentence(current))
    return sentences


def _sentence(words: list) -> dict:
    return {
        "start_ms": words[0]["start_ms"],
        "end_ms": words[-1]["end_ms"],
        "text": join_words(words),
        "word_count": len(words),
        "words": list(words),
    }


def _max_gap(words: list) -> int:
    """The longest silence between two consecutive words, 0 for one word.

    Measured across the whole window rather than between sentences, so a
    pause inside one long sentence counts too.
    """
    return max(
        (b["start_ms"] - a["end_ms"] for a, b in zip(words, words[1:])),
        default=0,
    )


# ── Tokens ───────────────────────────────────────────────────────────────────

#: A word: letters joined by apostrophes ("we've", "gibt's"), or a number
#: ("2024", "16:9", "2.8"). An apostrophe never splits a word -- v1 split
#: "I've" into "ve", which then turned up as a topic.
_WORD_RE = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)*|\d+(?:[.,:]\d+)*", re.UNICODE)
#: Whisper sometimes emits a contraction as its own word (" we", " 've"):
#: glue the suffix back on before splitting into words.
_CONTRACTION_GLUE_RE = re.compile(
    r"(?<=[^\W\d_])\s+(?=(?:'(?:s|m|d|t|ll|ve|re)|n't)\b)", re.UNICODE | re.IGNORECASE,
)


def _fold(text: str) -> str:
    """Typographic apostrophes as "'", contraction suffixes glued back on."""
    text = (text or "").replace("’", "'").replace("ʼ", "'")
    return _CONTRACTION_GLUE_RE.sub("", text)


def raw_words(text: str) -> list:
    """Every word and number in `text`, case kept."""
    return _WORD_RE.findall(_fold(text))


def tokenize(text: str) -> list:
    """Lower-case letter tokens of two characters or more, for topics.

    Numbers are dropped (so "2024" and "16:9" never become topics), as are
    one-letter words. A possessive "'s" is cut off ("anna's" -> "anna")
    unless the whole word is a stopword ("it's", "that's").
    """
    out = []
    for word in raw_words(text):
        token = word.lower()
        if token[0].isdigit():
            continue
        if token.endswith("'s") and token not in STOPWORDS:
            token = token[:-2]
        if len(token) >= 2:
            out.append(token)
    return out


def _count_phrases(tokens: list, phrases: frozenset) -> int:
    """How many times any phrase occurs, longest match first, no overlaps."""
    if not phrases:
        return 0
    longest = max(len(p) for p in phrases)
    count, i = 0, 0
    while i < len(tokens):
        for size in range(min(longest, len(tokens) - i), 0, -1):
            if tuple(tokens[i:i + size]) in phrases:
                count += 1
                i += size
                break
        else:
            i += 1
    return count


# ── Topics' stoplists ────────────────────────────────────────────────────────
#
# German handling is deliberately simple: stoplists and nothing else. There
# is NO stemming and no compound splitting, so "Kamera" and "Kameras" are
# two terms. A German stemmer is a dependency, and this module is
# stdlib-only; the cost is a less tidy topic list, not a wrong one. The
# same applies to English: "camera" and "cameras" do not merge.

_STOPWORDS_EN = frozenset("""
a about above after again against all am an and any are aren as at be because
been before being below between both but by can cannot could couldn did didn
do does doesn doing don down during each few for from further had hadn has
hasn have haven having he her here hers herself him himself his how if in
into is isn it its itself just me more most mustn my myself no nor not now of
off on once only or other ought our ours ourselves out over own re same shan
she should shouldn so some such than that the their theirs them themselves
then there these they this those through to too under until up very was wasn
we were weren what when where which while who whom why will with won would
wouldn you your yours yourself yourselves got get going really actually
basically kind sort lot lots thing things way ways okay yeah yes maybe quite
much many also well said say says like know think thought one two three
""".split())

#: Contractions, whole: the tokenizer keeps "we've" as one word now, so
#: the stoplist has to know it. The bare suffixes are listed too, for a
#: transcript that splits them some way the glue rule does not catch.
_CONTRACTIONS_EN = frozenset("""
i'm i've i'll i'd you're you've you'll you'd he's he'll he'd she's she'll
she'd it's it'll it'd we're we've we'll we'd they're they've they'll they'd
that's that'll there's there'll here's what's what're who's who'll let's
don't doesn't didn't can't won't wouldn't shouldn't couldn't isn't aren't
wasn't weren't haven't hasn't hadn't ain't mustn't needn't y'all
gonna wanna gotta kinda sorta ve ll re
""".split())

#: Fillers, backchannel and words too general to be a topic.
_GENERIC_EN = frozenset("""
um uh uhm umm erm er ah eh oh hmm mm mhm huh wow ok yep yup nope
go goes going gone went get gets getting good great nice fine right sure
moment moments stuff guess mean means meant want wants wanted need needs
little bit something anything everything nothing someone somebody anyone
everyone everybody people guy guys time times day today now come comes came
coming look looks looking see sees saw seen make makes made making take
takes took put let tell told talk talking ask asked happen happened start
started literally totally definitely probably obviously whatever anyway
honestly simply exactly absolutely especially usually already almost
everywhere anywhere somewhere nowhere thinking believe remember remembered
thirteen fourteen fifteen sixteen seventeen eighteen nineteen
again back still even ever every another able done doing gotten lot sorry
yeah okay thing things really
four five six seven eight nine ten eleven twelve twenty thirty forty fifty
hundred hundreds thousand thousands million millions first second third
last next half
""".split())

_STOPWORDS_DE = frozenset("""
aber alle allem allen aller alles als also am andere anderem anderen anderer
anderes auch auf aus bei bin bis bist da damit dann der den des dem die das
dass derselbe denn derer dessen dich dir du dies diese diesem diesen dieser
dieses doch dort durch ein eine einem einen einer eines einig einige er ihn
ihm es etwas euer eure für gegen gewesen hab habe haben hat hatte hatten hier
hin hinter ich mich mir ihr ihre ihrem ihren ihrer ihres euch im in indem ins
ist jede jedem jeden jeder jedes jene jetzt kann kein keine keinem keinen
keiner keines können könnte machen man manche mein meine mit muss musste nach
nicht nichts noch nun nur ob oder ohne sehr sein seine seinem seinen seiner
seines selbst sich sie ihnen sind so solche soll sollte sondern sonst über um
und uns unsere unter viel vom von vor während war waren warst was weg weil
weiter welche welchem welchen welcher welches wenn werde werden wie wieder
will wir wird wirst wo wollen wollte würde würden zu zum zur zwar zwischen ja
halt eben mal schon ganz immer gut gesagt sagen sagt denke glaube eigentlich
vielleicht einfach wirklich etwa eins zwei drei
""".split())

#: German contractions and colloquial forms, as for English.
_CONTRACTIONS_DE = frozenset("""
gibt's geht's hab's hat's war's ist's wie's was's so'n nen nem ner isses
gibts gehts haste biste kannste weißte
""".split())

#: Fillers, backchannel and words too general to be a topic.
_GENERIC_DE = frozenset("""
äh ähm öhm hm mhm aha naja na ne nee nein okay ok genau quasi sozusagen
irgendwie echt voll total super toll cool krass
gut gute guten geht gehen ging macht gemacht sache sachen ding dinge zeug
moment leute zeit tag heute dann hier da dort wieder nochmal bisschen
ziemlich richtig kommt kommen sag weiß weißt wissen finde findest gibt
vier fünf sechs sieben acht neun zehn elf zwölf zwanzig dreißig hundert
tausend erste ersten erster zweite zweiten dritte letzte letzten nächste
hälfte unserer unseren unserem eurer deren jemals trotzdem fast direkt
dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn
""".split())

#: All lists at once: a transcript can be either language (see "Word
#: lists"), and a word that is a stopword in one language is not a topic
#: in the other either.
STOPWORDS = (_STOPWORDS_EN | _CONTRACTIONS_EN | _GENERIC_EN
             | _STOPWORDS_DE | _CONTRACTIONS_DE | _GENERIC_DE)

#: Only for telling the two languages apart in a window (see _features).
_ONLY_EN = _STOPWORDS_EN - _STOPWORDS_DE
_ONLY_DE = _STOPWORDS_DE - _STOPWORDS_EN


def _is_topic_word(token: str) -> bool:
    return token not in STOPWORDS and not is_profane(token)


# ── Scoring one sentence ─────────────────────────────────────────────────────


def _clamp01(value: float) -> float:
    return 0.0 if value <= 0 else 1.0 if value >= 1 else value


def _ramp(value: float, free: float, full: float) -> float:
    """0 at `free`, 1 at `full`, linear between and capped -- either direction."""
    if full == free:
        return 1.0 if value >= full else 0.0
    return _clamp01((value - free) / (full - free))


def _features(sentence: dict) -> dict:
    """What the scorer counts in one sentence. Summed per window later."""
    text = sentence["text"]
    raw = raw_words(text)
    low = [w.lower() for w in raw]
    alpha = [w for w in raw if not w[0].isdigit()]

    story = sum(
        1 for t in low
        if t in PAST_TENSE or (_ED_RE.match(t) and t not in _ED_EXCEPTIONS)
    )
    superlatives = sum(
        1 for t in low
        if len(t) >= 6 and _EST_RE.match(t) and t not in _EST_EXCEPTIONS
    )
    numbers = sum(1 for t in low if t[0].isdigit() or t in NUMBER_WORDS)
    # Named things. Acronyms ("BMW") and inner capitals ("YouTube") count in
    # any language; a plain capitalised word mid-sentence counts only in
    # English, because in German every noun is capitalised.
    named_any = named_en = 0
    for index, word in enumerate(raw):
        if index == 0 or word[0].isdigit() or word.lower() in FIRST_PERSON:
            continue
        if (len(word) >= 2 and word.isupper()) or any(c.isupper() for c in word[1:]):
            named_any += 1
            named_en += 1
        elif word[0].isupper():
            named_en += 1

    stripped = text.strip().rstrip(_TRAILING)
    return {
        "n": len(low),
        "distinct": set(low),
        "content": {t for t in tokenize(text) if len(t) >= 3 and _is_topic_word(t)},
        "first_word": low[0] if low else "",
        "capitalised": bool(alpha) and alpha[0][:1].isupper(),
        "ends_thought": _ends_thought(text),
        "question": stripped.endswith("?"),
        "first_person": sum(1 for t in low if t in FIRST_PERSON),
        "story": story,
        "opinion": (sum(1 for t in low if t in OPINION_WORDS)
                    + _count_phrases(low, OPINION_PHRASES)),
        "numbers": numbers,
        "named_any": named_any,
        "named_en": named_en,
        "emotion": text.count("!") + superlatives + sum(1 for t in low if t in EMOTION_WORDS),
        "filler": (sum(1 for t in low if t in FILLERS)
                   + _count_phrases(low, FILLER_PHRASES)),
        "retake": _count_phrases(low, RETAKE_PHRASES),
        "repeats": sum(1 for a, b in zip(low, low[1:]) if a == b and not a[0].isdigit()),
        "en": sum(1 for t in low if t in _ONLY_EN),
        "de": sum(1 for t in low if t in _ONLY_DE),
    }


# ── Turns: what the other tracks say ─────────────────────────────────────────


class _Others:
    """Every track's words and sentences, for asking about the OTHER tracks.

    Built once per file. `interjections` and `question_before` are what a
    window on track t needs to know about everyone except t.
    """

    def __init__(self, sentences_by_track: dict):
        self.words = sorted(
            (w["start_ms"], w["end_ms"], track)
            for track, sentences in sentences_by_track.items()
            for s in sentences for w in s["words"]
        )
        self.starts = [w[0] for w in self.words]
        self.sentence_ends = sorted(
            (s["end_ms"], track, s["text"].strip().rstrip(_TRAILING).endswith("?"))
            for track, sentences in sentences_by_track.items()
            for s in sentences
        )
        self.end_times = [s[0] for s in self.sentence_ends]

    def interjections(self, track, start_ms: int, end_ms: int) -> list:
        """Other speakers' word clusters starting inside a span, as word counts."""
        lo = bisect.bisect_left(self.starts, start_ms)
        hi = bisect.bisect_left(self.starts, end_ms)
        clusters, last_end = [], None
        for w_start, w_end, w_track in self.words[lo:hi]:
            if w_track == track:
                continue
            if last_end is None or w_start - last_end > INTERJECTION_GAP_MS:
                clusters.append(0)
            clusters[-1] += 1
            last_end = w_end
        return clusters

    def question_before(self, track, start_ms: int) -> bool:
        """Did ANOTHER speaker's last sentence before `start_ms` ask a question,
        ending at most ANSWER_LEAD_MS before it?"""
        index = bisect.bisect_right(self.end_times, start_ms) - 1
        while index >= 0:
            end, other, is_question = self.sentence_ends[index]
            if start_ms - end > ANSWER_LEAD_MS:
                return False
            if other != track:
                return is_question
            index -= 1
        return False


# ── Windows ──────────────────────────────────────────────────────────────────


def _windows_of_track(sentences: list, min_duration_ms, max_duration_ms,
                      min_words, max_internal_gap_ms):
    """Every run of consecutive sentences within the length and gap rules.

    Yields (i, j, word_count). By construction a window starts where a
    sentence starts and ends where a sentence ends. The inner loop stops as
    soon as the run is too long or crosses a long silence: a run can only
    grow, so neither can be undone by adding sentences.
    """
    inner_gaps = [_max_gap(s["words"]) for s in sentences]
    for i in range(len(sentences)):
        count = 0
        for j in range(i, len(sentences)):
            gap = inner_gaps[j]
            if j > i:
                gap = max(gap, sentences[j]["start_ms"] - sentences[j - 1]["end_ms"])
            if gap > max_internal_gap_ms:
                break
            count += sentences[j]["word_count"]
            duration = sentences[j]["end_ms"] - sentences[i]["start_ms"]
            if duration > max_duration_ms:
                break
            if duration < min_duration_ms or count < min_words:
                continue
            yield i, j, count


def _score_window(feats: list, ctx: dict) -> tuple:
    """(score 0..1, reasons) for one window's sentence features.

    `ctx` carries what the sentences alone cannot say: duration, the pause
    after the window, interjections, and whether it answers a question.
    """
    n = max(1, sum(f["n"] for f in feats))
    total: Counter = Counter()
    for f in feats:
        total.update({k: f[k] for k in (
            "first_person", "story", "opinion", "numbers", "named_any", "named_en",
            "emotion", "filler", "retake", "repeats", "en", "de",
        )})
    distinct = set().union(*(f["distinct"] for f in feats))
    content = set().union(*(f["content"] for f in feats))
    german = total["de"] > total["en"]
    specifics = total["numbers"] + (total["named_any"] if german else total["named_en"])
    questions = sum(1 for f in feats if f["question"])

    parts = [
        (REASON_FIRST_PERSON, SCORE_FIRST_PERSON
         * _ramp(total["first_person"] / n, 0.0, FIRST_PERSON_FULL_RATE)),
        (REASON_STORY, SCORE_STORY * _ramp(total["story"] / n, 0.0, STORY_FULL_RATE)),
        (REASON_OPINION, SCORE_OPINION * _ramp(total["opinion"], 0, OPINION_FULL_HITS)),
        (REASON_SPECIFICS, SCORE_SPECIFICS * _ramp(specifics, 0, SPECIFICS_FULL_HITS)),
        (REASON_EMOTION, SCORE_EMOTION * _ramp(total["emotion"], 0, EMOTION_FULL_HITS)),
        (REASON_DENSITY, SCORE_DENSITY
         * _ramp(len(content) / n, DENSITY_FREE_RATE, DENSITY_FULL_RATE)),
        (REASON_ANSWER, SCORE_ANSWER if ctx["answers_question"] else 0.0),
        (REASON_IDEAL_LENGTH, SCORE_IDEAL_LENGTH
         if IDEAL_MIN_MS <= ctx["duration_ms"] <= IDEAL_MAX_MS else 0.0),
        (REASON_CLEAN_END, SCORE_CLEAN_END if ctx["clean_end"] else 0.0),
        (REASON_CLEAN_START, SCORE_CLEAN_START if ctx["clean_start"] else 0.0),
        (REASON_THOUGHT_BREAK, -min(PENALTY_THOUGHT_BREAK_MAX,
                                    PENALTY_THOUGHT_BREAK * ctx["thought_breaks"])),
        (REASON_RETAKE, -min(PENALTY_RETAKE_MAX, PENALTY_RETAKE_PER_HIT * total["retake"])),
        (REASON_FILLER, -PENALTY_FILLER
         * _ramp(total["filler"] / n, FILLER_FREE_RATE, FILLER_FULL_RATE)),
        (REASON_REPEATS, -PENALTY_REPEATS
         * _ramp(total["repeats"] / n, REPEAT_FREE_RATE, REPEAT_FULL_RATE)),
        (REASON_LOW_DIVERSITY, -PENALTY_LOW_DIVERSITY
         * _ramp(len(distinct) / n, DIVERSITY_FREE_RATIO, DIVERSITY_FULL_RATIO)),
        (REASON_MOSTLY_QUESTIONS, -PENALTY_MOSTLY_QUESTIONS
         if questions / len(feats) > MOSTLY_QUESTIONS_SHARE else 0.0),
        (REASON_ENDS_ON_QUESTION, -PENALTY_ENDS_ON_QUESTION if feats[-1]["question"] else 0.0),
        (REASON_RAPID_TURNS, -min(
            PENALTY_RAPID_TURNS_MAX,
            PENALTY_RAPID_TURNS_PER_INTERJECTION
            * max(0, ctx["interjections"] - RAPID_INTERJECTIONS + 1),
        )),
        (REASON_THIN, -PENALTY_THIN if len(content) < MIN_CONTENT_TERMS else 0.0),
        (REASON_WEAK_END, -PENALTY_WEAK_END
         if len(feats) > 1 and feats[-1]["n"] <= WEAK_END_MAX_WORDS
         and not feats[-1]["content"] else 0.0),
    ]
    score = SCORE_BASE + sum(value for _, value in parts)
    reasons = [("+" if value > 0 else "-") + code for code, value in parts if value]
    return round(_clamp01(score), 3), reasons


def evaluate_windows(
    words_by_track,
    *,
    min_duration_ms: int = MIN_DURATION_MS,
    max_duration_ms: int = MAX_DURATION_MS,
    min_words: int = MIN_WORDS,
    max_internal_gap_ms: int = MAX_INTERNAL_GAP_MS,
    min_score: float = MIN_QUALITY_SCORE,
) -> list:
    """EVERY window that passes the length and gap rules, scored or rejected.

    Each carries `score`, `reasons` and `rejected` (True when any "!" reason
    applies, including a score under `min_score`). build_candidates picks
    from the ones not rejected; the scripts show the rest to explain what
    was left out. Ordered by (track, start, end).
    """
    sentences_by_track = {
        int(key): build_sentences(words_by_track[key])
        for key in sorted(words_by_track, key=lambda k: int(k))
    }
    others = _Others(sentences_by_track)

    out = []
    for track, sentences in sentences_by_track.items():
        if not sentences:
            continue
        feats = [_features(s) for s in sentences]
        cased = sum(f["capitalised"] for f in feats) / len(feats) >= CAPITALISED_TRACK_SHARE
        for i, j, count in _windows_of_track(
            sentences, min_duration_ms, max_duration_ms, min_words, max_internal_gap_ms,
        ):
            start, end = sentences[i]["start_ms"], sentences[j]["end_ms"]
            rejects = []
            if cased and not feats[i]["capitalised"]:
                rejects.append(REJECT_MID_SENTENCE_START)
            if feats[i]["first_word"] in FILLER_STARTS:
                rejects.append(REJECT_FILLER_START)
            if not feats[j]["ends_thought"]:
                rejects.append(REJECT_MID_SENTENCE_END)
            clusters = others.interjections(track, start, end)
            if any(size > INTERJECTION_MAX_WORDS for size in clusters):
                rejects.append(REJECT_CROSSES_TURN)

            next_start = sentences[j + 1]["start_ms"] if j + 1 < len(sentences) else None
            prev_end = sentences[i - 1]["end_ms"] if i > 0 else None
            ctx = {
                "duration_ms": end - start,
                "clean_end": next_start is None or next_start - end >= THOUGHT_PAUSE_MS,
                "clean_start": prev_end is None or start - prev_end >= THOUGHT_PAUSE_MS,
                "thought_breaks": sum(
                    1 for k in range(i + 1, j + 1)
                    if sentences[k]["start_ms"] - sentences[k - 1]["end_ms"] >= THOUGHT_BREAK_MS
                ),
                "interjections": len(clusters),
                "answers_question": others.question_before(track, start),
            }
            score, reasons = _score_window(feats[i:j + 1], ctx)
            if score < min_score:
                rejects.append(REJECT_LOW_SCORE)
            window_words = [w for s in sentences[i:j + 1] for w in s["words"]]
            out.append({
                "track_index": track,
                "start_ms": start,
                "end_ms": end,
                "duration_ms": end - start,
                "word_count": count,
                "text": join_words(window_words),
                "sentence_span": (i, j),
                "score": score,
                "reasons": ["!" + r for r in rejects] + reasons,
                "rejected": bool(rejects),
            })
    return out


def max_clips_for(duration_ms) -> int:
    """max(MIN_CLIPS_PER_FILE, ceil(minutes / MINUTES_PER_CLIP))."""
    minutes = max(0, int(duration_ms or 0)) / 60_000
    return max(MIN_CLIPS_PER_FILE, math.ceil(minutes / MINUTES_PER_CLIP))


def _overlap_ratio(a: dict, b: dict) -> float:
    """Shared time as a share of the SHORTER window.

    Against the shorter one on purpose: a 10 s window wholly inside a 40 s
    one shares only a quarter of the longer, and is still a duplicate of
    the short one.
    """
    overlap = min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"])
    if overlap <= 0:
        return 0.0
    shortest = min(a["duration_ms"], b["duration_ms"])
    return overlap / shortest if shortest > 0 else 1.0


def select_clips(windows: list, *, max_clips: int,
                 min_start_spacing_ms: int = MIN_START_SPACING_MS) -> list:
    """The best windows, none overlapping, starts spaced, at most `max_clips`.

    Greedy by score -- ties broken on start, track and end, so the same
    transcript always yields the same clips. Overlap and spacing are
    checked across tracks: a clip is a span of the FILE, and two spans of
    one file overlap whoever is speaking in them. Returned in playback
    order.
    """
    ranked = sorted(
        (w for w in windows if not w.get("rejected")),
        key=lambda w: (-w["score"], w["start_ms"], w["track_index"], w["end_ms"]),
    )
    kept: list = []
    for window in ranked:
        if len(kept) >= max_clips:
            break
        if any(_overlap_ratio(window, other) > 0 for other in kept):
            continue
        if any(abs(window["start_ms"] - other["start_ms"]) < min_start_spacing_ms
               for other in kept):
            continue
        kept.append(window)
    return sorted(kept, key=lambda w: (w["start_ms"], w["track_index"], w["end_ms"]))


def drop_overlapping(rows: list, kept: list,
                     max_overlap_ratio: float = MAX_OVERLAP_RATIO) -> tuple:
    """(rows to create, how many were dropped).

    A candidate is dropped when it shares more than `max_overlap_ratio` of
    the shorter of the two with any clip in `kept` -- the clips a re-run
    leaves alone (approved, rejected, imported, hand-made, edited by a
    person). So a rejected clip is not suggested again, and an edited one
    does not get an untrimmed twin beside it.

    Time only, across tracks: a clip is a span of the file, and two spans
    of the same file overlap whoever is speaking in them. Each item needs
    `start_ms` and `end_ms`.
    """
    def _span(item):
        start, end = int(item["start_ms"]), int(item["end_ms"])
        return {"start_ms": start, "end_ms": end, "duration_ms": end - start}

    spans = [_span(k) for k in kept]
    out = [r for r in rows
           if all(_overlap_ratio(_span(r), k) <= max_overlap_ratio for k in spans)]
    return out, len(rows) - len(out)


def _file_duration_ms(words_by_track, duration_ms) -> int:
    """The file's length: as given, else where its last word ends."""
    if duration_ms:
        return int(duration_ms)
    return max((w["end_ms"] for words in words_by_track.values() for w in _usable(words)),
               default=0)


def build_candidates(
    words_by_track,
    *,
    duration_ms: Optional[int] = None,
    min_duration_ms: int = MIN_DURATION_MS,
    max_duration_ms: int = MAX_DURATION_MS,
    min_words: int = MIN_WORDS,
    max_internal_gap_ms: int = MAX_INTERNAL_GAP_MS,
    min_score: float = MIN_QUALITY_SCORE,
    max_clips: Optional[int] = None,
    min_start_spacing_ms: int = MIN_START_SPACING_MS,
) -> list:
    """The clips to suggest for one file: scored, filtered, capped.

    Each carries `track_index` (the caller turns it into a speaker_id),
    `score` (0..1) and `reasons`. `max_clips` defaults to
    max_clips_for(duration), with the duration taken from `duration_ms`
    or, without it, from the last word. Returned in playback order.
    """
    windows = evaluate_windows(
        words_by_track, min_duration_ms=min_duration_ms, max_duration_ms=max_duration_ms,
        min_words=min_words, max_internal_gap_ms=max_internal_gap_ms, min_score=min_score,
    )
    if max_clips is None:
        max_clips = max_clips_for(_file_duration_ms(words_by_track, duration_ms))
    return select_clips(windows, max_clips=max_clips,
                        min_start_spacing_ms=min_start_spacing_ms)


# ── Topics ───────────────────────────────────────────────────────────────────


def _topic_tokens(text: str) -> list:
    """One entry per word of `text`: its topic token, or None.

    None keeps the word's PLACE, so two topic words with a stopword, a
    number or a one-letter word between them are not adjacent -- v1 made
    "believe bakery" out of "believe a bakery".
    """
    out = []
    for word in raw_words(text):
        token = word.lower()
        if token[0].isdigit():
            out.append(None)
            continue
        if token.endswith("'s") and token not in STOPWORDS:
            token = token[:-2]
        out.append(token if len(token) >= 2 and _is_topic_word(token) else None)
    return out


def _terms(text: str) -> Counter:
    """Unigrams and bigrams of one window, counted.

    A bigram is two ADJACENT words that are both topic words, so "social
    media" survives while "of the" and "media of" never form. Stopwords,
    numbers and swear words are never part of either.
    """
    tokens = _topic_tokens(text)
    counts = Counter(t for t in tokens if t)
    for first, second in zip(tokens, tokens[1:]):
        if first and second:
            counts[f"{first} {second}"] += 1
    return counts


_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?…])\s+")


def _capitalised_terms(text: str) -> set:
    """Lower-case forms of the words written with a capital mid-sentence."""
    out = set()
    for sentence in _SENTENCE_SPLIT_RE.split(text or ""):
        for index, word in enumerate(raw_words(sentence)):
            if index and word[0].isupper():
                out.add(word.lower())
    return out


def extract_topics(windows, top_n: int = TOPIC_COUNT,
                   corpus: Optional[Iterable[str]] = None) -> list:
    """The top terms of each window, by TF-IDF across all of them.

    `windows` is the list build_candidates returned (or any list of dicts
    with a "text"). Document frequency is counted over those windows plus
    `corpus`; detect_snippets passes every sentence of the file there, so
    a word the whole conversation keeps using scores lower than one this
    clip is about.

    A term written with a capital mid-sentence weighs
    TOPIC_CAPITALISED_WEIGHT more (a name, or a German noun). Returns one
    list of terms per window, in the same order. Fully deterministic: equal
    scores go to the LONGER term (more specific: "cellar flood" before
    "bag"), then alphabetically.
    """
    windows = list(windows)
    own = [_terms(w.get("text") or "") for w in windows]
    extra = [_terms(text) for text in (corpus or [])]

    documents = own + extra
    total_docs = len(documents)
    if not windows or total_docs == 0:
        return [[] for _ in windows]

    document_frequency: Counter = Counter()
    for counts in documents:
        document_frequency.update(set(counts))
    # How often each bigram occurs in the file: over the corpus when there
    # is one (it is every sentence), else over the windows themselves.
    occurrences: Counter = Counter()
    for counts in (extra or own):
        occurrences.update({t: c for t, c in counts.items() if " " in t})

    out = []
    for window, counts in zip(windows, own):
        capitalised = _capitalised_terms(window.get("text") or "")
        counts = Counter({
            term: count for term, count in counts.items()
            if " " not in term
            or max(count, occurrences[term]) >= BIGRAM_MIN_OCCURRENCES
        })
        total_terms = sum(counts.values())
        if total_terms == 0:
            out.append([])
            continue
        # Smoothed, so a term in every window still scores above zero and a
        # one-window corpus does not collapse to all zeroes.
        scores = {
            term: (count / total_terms)
                  * (math.log((total_docs + 1) / (document_frequency[term] + 1)) + 1.0)
                  * (TOPIC_CAPITALISED_WEIGHT
                     if any(part in capitalised for part in term.split(" ")) else 1.0)
            for term, count in counts.items()
        }
        out.append(_pick_terms(scores, top_n))
    return out


def _pick_terms(scores: dict, top_n: int) -> list:
    """Top terms, with a bigram allowed to swallow its own two words."""
    swallowed = set()
    for term, score in scores.items():
        if " " not in term:
            continue
        parts = term.split(" ")
        best_part = max((scores.get(p, 0.0) for p in parts), default=0.0)
        if best_part > 0.0 and score >= BIGRAM_PREFERENCE * best_part:
            swallowed.update(parts)

    ranked = sorted(
        ((term, score) for term, score in scores.items() if term not in swallowed),
        key=lambda pair: (-round(pair[1], 9), -len(pair[0]), pair[0]),
    )
    return [term for term, _ in ranked[:top_n]]


# ── Titles and quotes ────────────────────────────────────────────────────────


def _title_case(term: str) -> str:
    """Capitalise each word, leaving the rest of it alone.

    `str.title()` is not used: it lowercases the tail and breaks on
    apostrophes, turning "don't" into "Don'T".
    """
    return " ".join(part[:1].upper() + part[1:] for part in term.split(" ") if part)


def cut_on_word_boundary(text: str, max_chars: int, ellipsis: str = "…") -> str:
    """`text` shortened to at most `max_chars`, never mid-word.

    The ellipsis counts towards the limit, so the result really is within
    it. A single word longer than the limit is cut hard -- there is no
    boundary to use.
    """
    text = " ".join((text or "").split())
    if len(text) <= max_chars:
        return text
    room = max_chars - len(ellipsis)
    if room <= 0:
        return text[:max_chars]
    head = text[:room + 1]
    cut = head.rfind(" ")
    return (head[:cut].rstrip() if cut > 0 else text[:room]) + ellipsis


def _clean_topic(term: str) -> bool:
    return bool((term or "").strip()) and not any(is_profane(p) for p in term.split())


def make_title(topics, quote: str = "", max_chars: int = TITLE_MAX_CHARS) -> str:
    """A short title from the top topics, or from the quote's first words.

    Two or three topics, title-cased and joined by a middle dot -- a topic
    list is what this is, and pretending it is a sentence would read worse.
    With fewer than two topics there is nothing to join, so the quote's
    first six words stand in. Never a swear word: a profane topic is
    skipped, and so is a profane word of the quote. (The quote itself keeps
    them -- it is what was said.)
    """
    usable = [t for t in (topics or []) if _clean_topic(t)]
    for count in (3, 2):
        if len(usable) >= count:
            title = TITLE_SEPARATOR.join(_title_case(t) for t in usable[:count])
            if len(title) <= max_chars:
                return title
    if len(usable) >= 2:
        # Even two were too long: keep them and cut, rather than dropping to
        # the quote, because the topics are still the better title.
        return cut_on_word_boundary(
            TITLE_SEPARATOR.join(_title_case(t) for t in usable[:2]), max_chars,
        )
    words = [w for w in (quote or "").split()
             if not any(is_profane(part) for part in raw_words(w))]
    return cut_on_word_boundary(" ".join(words[:6]), max_chars)


# ── The whole job ────────────────────────────────────────────────────────────


def detect_snippets(media_file, *, top_n: int = TOPIC_COUNT,
                    corpus: Optional[Iterable[str]] = None, **limits) -> list:
    """Ready-to-store `snippets` rows for one media file.

    `media_file` is the plain dict described at the top of this module, not
    an ORM row; its `duration_ms` sets the per-file cap. `limits` is passed
    through to build_candidates.

    Every row carries source="keyword", generator="keyword-v2",
    status="suggested", `quality_score` = the window's score (0..1) and
    viral_score None. `reasons` rides along for the scripts; the database
    does not store it.
    """
    tracks = (media_file or {}).get("tracks") or {}
    words_by_track = {int(key): (value.get("words") or []) for key, value in tracks.items()}
    by_track = {int(key): value for key, value in tracks.items()}

    windows = build_candidates(
        words_by_track, duration_ms=(media_file or {}).get("duration_ms"), **limits,
    )
    if corpus is None:
        corpus = [s["text"] for key in sorted(words_by_track)
                  for s in build_sentences(words_by_track[key])]
    topics_per_window = extract_topics(windows, top_n=top_n, corpus=corpus)

    rows = []
    for window, topics in zip(windows, topics_per_window):
        track = by_track.get(window["track_index"]) or {}
        quote = cut_on_word_boundary(window["text"], QUOTE_MAX_CHARS)
        rows.append({
            "media_file_id": (media_file or {}).get("media_file_id"),
            "track_index": window["track_index"],
            "speaker_id": track.get("speaker_id"),
            "speaker": track.get("speaker"),
            "start_ms": window["start_ms"],
            "end_ms": window["end_ms"],
            "title": make_title(topics, quote),
            "quote": quote,
            "topics": list(topics),
            "quality_score": window["score"],
            "viral_score": None,
            "reasons": list(window["reasons"]),
            "status": STATUS_SUGGESTED,
            "source": SOURCE,
            "generator": GENERATOR,
        })
    return rows


# ── Import ───────────────────────────────────────────────────────────────────
#
# scripts/snippet_import.py takes clips from somewhere else -- a model run
# by hand, a person with a spreadsheet -- and the checking lives here so it
# can be tested without a database. Nothing in this section reaches a
# network or a model either.

#: `snippets.topics` is text[] with no length limit; eight is an editorial
#: cap, and a payload with fifty is a mistake worth reporting.
MAX_IMPORT_TOPICS = 8
#: How far a given boundary may be moved to land on a real word edge. Half a
#: second is about one word: beyond that the caller meant a different place,
#: and guessing would silently shift the clip.
SNAP_TOLERANCE_MS = 500
#: `snippets.generator` is String(64).
GENERATOR_MAX_CHARS = 64
#: `snippets.title` is String(255).
TITLE_MAX_STORED_CHARS = 255


class ImportRefused(Exception):
    """The payload as a whole cannot be read (bad meta, not a list, ...).

    A problem with ONE snippet is not this: that item is refused with a
    reason and the rest are still imported.
    """


def _boundaries(words_by_track) -> tuple:
    """(sorted word start times, sorted word end times) across every track.

    Across tracks, not per track: an imported clip names a time in the file
    and need not say which microphone it came from.
    """
    starts, ends = set(), set()
    for words in (words_by_track or {}).values():
        for word in _usable(words):
            starts.add(word["start_ms"])
            ends.add(word["end_ms"])
    return sorted(starts), sorted(ends)


def snap(value: int, candidates, tolerance_ms: int = SNAP_TOLERANCE_MS):
    """The nearest candidate within `tolerance_ms`, or None.

    Ties go to the EARLIER candidate, so the same input always snaps the
    same way.
    """
    best = None
    for candidate in candidates:
        distance = abs(candidate - value)
        if distance > tolerance_ms:
            continue
        if best is None or distance < best[0]:
            best = (distance, candidate)
    return None if best is None else best[1]


def transcript_range(words_by_track) -> tuple:
    """(first word start, last word end), or (None, None) with no words."""
    starts, ends = _boundaries(words_by_track)
    if not starts or not ends:
        return None, None
    return starts[0], ends[-1]


def words_inside(words, start_ms: int, end_ms: int) -> list:
    """One track's words that lie WHOLLY inside a span.

    Wholly inside, so a word clipped by the boundary is left out rather
    than half-quoted.
    """
    return [w for w in _usable(words)
            if w["start_ms"] >= start_ms and w["end_ms"] <= end_ms]


def dominant_track(words_by_track, start_ms: int, end_ms: int):
    """The track that speaks most inside a span, or None if nobody does.

    Ties go to the lower track index, so the choice is deterministic.
    """
    best = None
    for key in sorted((words_by_track or {}), key=lambda k: int(k)):
        count = len(words_inside(words_by_track[key], start_ms, end_ms))
        if count and (best is None or count > best[0]):
            best = (count, key)
    return None if best is None else best[1]


def text_between(words_by_track, start_ms: int, end_ms: int, track=None) -> str:
    """The transcript inside a span, as ONE speaker said it.

    Used to fill a missing quote. Exactly one track is quoted -- by default
    the one that speaks most inside the span -- because one track is one
    speaker. Merging every track by timestamp instead would interleave two
    people into word salad ("Soft weich. light Weiches on Licht"), which is
    not a quote anybody said.
    """
    if track is None:
        track = dominant_track(words_by_track, start_ms, end_ms)
    if track is None:
        return ""
    return join_words(words_inside((words_by_track or {})[track], start_ms, end_ms))


def _score(value, name: str):
    """A score that is None, or a float in 0..1. Raises ValueError otherwise."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number between 0 and 1, got {value!r}")
    number = float(value)
    if not 0.0 <= number <= 1.0:
        raise ValueError(f"{name} must be between 0 and 1, got {number}")
    return number


def _topics(value):
    """At most MAX_IMPORT_TOPICS non-empty strings. Raises ValueError."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"topics must be a list, got {type(value).__name__}")
    if len(value) > MAX_IMPORT_TOPICS:
        raise ValueError(f"at most {MAX_IMPORT_TOPICS} topics, got {len(value)}")
    out = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError(f"every topic must be a string, got {type(item).__name__}")
        cleaned = " ".join(item.split())
        if cleaned:
            out.append(cleaned)
    return out


def _whole_ms(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a whole number of milliseconds, got {value!r}")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError(f"{name} must be a whole number of milliseconds, got {value}")
    return int(value)


def read_generator(meta) -> str:
    """`meta.generator`, checked. Raises ImportRefused."""
    if not isinstance(meta, dict):
        raise ImportRefused('"meta" must be an object with a "generator".')
    generator = meta.get("generator")
    if not isinstance(generator, str) or not generator.strip():
        raise ImportRefused('"meta.generator" must be a non-empty string, '
                            'for example "claude", "gpt" or "hand".')
    cleaned = " ".join(generator.split())
    if len(cleaned) > GENERATOR_MAX_CHARS:
        raise ImportRefused(
            f'"meta.generator" is longer than {GENERATOR_MAX_CHARS} characters.'
        )
    return cleaned


def validate_import(payload, words_by_track, *,
                    tolerance_ms: int = SNAP_TOLERANCE_MS) -> dict:
    """Check an import payload item by item.

    Returns::

        {"generator": "claude",
         "accepted": [row, ...],      # ready to store, source="import"
         "refused":  [{"index": 2, "reason": "...", "item": {...}}, ...],
         "snapped":  1}               # accepted rows that had a time moved

    One bad item never stops the others: it is refused with a reason naming
    the field, and the summary reports all three counts. The payload as a
    whole can still be unreadable -- see ImportRefused.
    """
    if not isinstance(payload, dict):
        raise ImportRefused("the file must contain a JSON object.")
    generator = read_generator(payload.get("meta"))
    items = payload.get("snippets")
    if not isinstance(items, list):
        raise ImportRefused('"snippets" must be a list.')

    starts, ends = _boundaries(words_by_track)
    range_start, range_end = transcript_range(words_by_track)
    if range_start is None:
        raise ImportRefused(
            "this media file has no transcript words, so there is nothing to "
            "snap imported times to. Transcribe it first."
        )

    accepted, refused, snapped_count = [], [], 0
    for index, item in enumerate(items):
        try:
            row, was_snapped = _validate_item(
                item, starts, ends, range_start, range_end, generator,
                words_by_track, tolerance_ms,
            )
        except ValueError as exc:
            refused.append({"index": index, "reason": str(exc), "item": item})
            continue
        accepted.append(row)
        snapped_count += 1 if was_snapped else 0

    return {
        "generator": generator,
        "accepted": accepted,
        "refused": refused,
        "snapped": snapped_count,
    }


def _validate_item(item, starts, ends, range_start, range_end, generator,
                   words_by_track, tolerance_ms) -> tuple:
    if not isinstance(item, dict):
        raise ValueError(f"must be an object, got {type(item).__name__}")

    start_ms = _whole_ms(item.get("start_ms"), "start_ms")
    end_ms = _whole_ms(item.get("end_ms"), "end_ms")
    if start_ms >= end_ms:
        raise ValueError(f"start_ms ({start_ms}) must be before end_ms ({end_ms})")
    if start_ms < range_start or end_ms > range_end:
        raise ValueError(
            f"{start_ms}-{end_ms} ms is outside the transcript, which runs "
            f"{range_start}-{range_end} ms"
        )

    title = item.get("title")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title must be a non-empty string")
    title = cut_on_word_boundary(title, TITLE_MAX_STORED_CHARS)

    topics = _topics(item.get("topics"))
    quality = _score(item.get("quality_score"), "quality_score")
    viral = _score(item.get("viral_score"), "viral_score")

    speaker = item.get("speaker")
    if speaker is not None and not isinstance(speaker, str):
        raise ValueError(f"speaker must be a name, got {type(speaker).__name__}")

    snapped_start = snap(start_ms, starts, tolerance_ms)
    if snapped_start is None:
        raise ValueError(
            f"start_ms {start_ms} is not within {tolerance_ms} ms of any word's start; "
            f"the nearest is {_nearest(start_ms, starts)} ms"
        )
    snapped_end = snap(end_ms, ends, tolerance_ms)
    if snapped_end is None:
        raise ValueError(
            f"end_ms {end_ms} is not within {tolerance_ms} ms of any word's end; "
            f"the nearest is {_nearest(end_ms, ends)} ms"
        )
    if snapped_start >= snapped_end:
        raise ValueError(
            f"after snapping to word boundaries the span would be "
            f"{snapped_start}-{snapped_end} ms, which is empty"
        )
    was_snapped = (snapped_start, snapped_end) != (start_ms, end_ms)

    quote = item.get("quote")
    if quote is not None and not isinstance(quote, str):
        raise ValueError(f"quote must be a string, got {type(quote).__name__}")
    if not (quote or "").strip():
        quote = text_between(words_by_track, snapped_start, snapped_end)
    quote = cut_on_word_boundary(quote, QUOTE_MAX_CHARS) or None

    row = {
        "start_ms": snapped_start,
        "end_ms": snapped_end,
        "title": title,
        "quote": quote,
        "topics": topics,
        "quality_score": quality,
        "viral_score": viral,
        "speaker": (" ".join(speaker.split()) or None) if isinstance(speaker, str) else None,
        "status": STATUS_SUGGESTED,
        "source": "import",
        "generator": generator,
    }
    return row, was_snapped


def _nearest(value: int, candidates) -> Optional[int]:
    if not candidates:
        return None
    return min(candidates, key=lambda c: (abs(c - value), c))
