"""SocialSnippet clip detection: which spans of a transcript are worth cutting.

No model, no network, no database -- plain functions over plain data, like
services/snippet_transcribe.py, so the window rules and the topic scoring
can be tested without a transcript in a table. The database side (loading
words, writing `snippets` rows, the replace rules) lives in
tasks/transcribe_tasks.py and in scripts/snippet_detect.py.

There is no AI model here and there is not meant to be one. `generator` is
written as "tfidf-v1" so a row's origin is visible, and
`snippets.quality_score` / `.viral_score` are left NULL: counting words is
not scoring a clip, and 0.0 would claim it scored badly rather than "not
scored". A model-backed generator can fill them later without touching
these rows -- see models/snippet.py on SNIPPET_SOURCES.

Data shapes
-----------
A word, as `transcript_words` stores it -- times in MILLISECONDS, absolute
within the track (`transcript_segments` is where the track lives, so the
caller groups by it)::

    {"start_ms": 1200, "end_ms": 1600, "word": " Hallo"}

``words_by_track`` is ``{track_index: [word, ...]}``, each list in time
order. ONE TRACK IS ONE SPEAKER (models/snippet.py), which is why a window
never spans tracks: a clip that cuts across two mics has two people
talking over each other.

The "media file" `detect_snippets` takes is a plain dict, not an ORM row::

    {"media_file_id": "<uuid as str>",       # carried through untouched
     "tracks": {0: {"speaker": "Anna Example" | None,
                    "speaker_id": "<uuid as str>" | None,
                    "words": [word, ...]}}}

Track keys may be ``int`` or ``str``: the same dict comes back from JSON in
the scripts, where keys are strings.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable, Optional

# ── The window rules ─────────────────────────────────────────────────────────
#
# Module constants rather than pydantic settings: adding a setting means
# documenting it in .env.example, and this change was asked to leave .env
# files alone. Every one of them is also a keyword argument on
# build_candidates/detect_snippets, so a caller -- or a future
# `settings.snippet_detect_*` -- can override any of them without editing
# this file.

#: Under 8 s there is no thought in it; over 45 s it is not a social clip.
MIN_DURATION_MS = 8_000
MAX_DURATION_MS = 45_000
#: What the selector aims for when several windows are valid. About 20 s is
#: the length most short-form platforms still show in full.
TARGET_DURATION_MS = 20_000
#: Twelve words at a normal speaking rate is roughly five seconds of speech,
#: so this rejects a window that is mostly silence yet long enough to pass
#: MIN_DURATION_MS.
MIN_WORDS = 12
#: A pause longer than this inside a window is a cut, not a breath.
MAX_INTERNAL_GAP_MS = 2_000
#: Two kept windows may share at most this much of the shorter one. Zero
#: would be ideal, and loses the second-best moment whenever two good
#: sentences share one; 30% keeps both while stopping near-duplicates.
MAX_OVERLAP_RATIO = 0.30

#: `snippets.quote` is TEXT, so this is an editorial limit, not a column one.
QUOTE_MAX_CHARS = 300
#: `snippets.title` is String(255); 60 is what a card can show.
TITLE_MAX_CHARS = 60
TOPIC_COUNT = 4

#: Written to every row this module produces. Bump the version when the
#: scoring changes, so old rows stay identifiable.
GENERATOR = "tfidf-v1"
#: models/snippet.py SNIPPET_SOURCES.
SOURCE = "keyword"
STATUS_SUGGESTED = "suggested"

#: A bigram is preferred over its own words when it scores at least this
#: share of the better one. "social media" beating 0.8 x "media" is a real
#: phrase; below that the single word is carrying the meaning.
BIGRAM_PREFERENCE = 0.80

#: Between topics in a generated title.
TITLE_SEPARATOR = " · "


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
    selector more places to start and stop.
    """
    stripped = (text or "").strip().rstrip(_TRAILING)
    return bool(stripped) and stripped[-1] in _TERMINAL


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
    of every file.
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


# ── Windows ──────────────────────────────────────────────────────────────────


def _valid_windows(sentences: list, min_duration_ms, max_duration_ms,
                   min_words, max_internal_gap_ms) -> list:
    """Every run of consecutive sentences that satisfies all four rules.

    By construction a window starts where a sentence starts and ends where a
    sentence ends. The inner loop stops as soon as the run is too long,
    which also bounds the work: a run can only grow.
    """
    out = []
    for i in range(len(sentences)):
        words: list = []
        for j in range(i, len(sentences)):
            words = words + sentences[j]["words"]
            start = sentences[i]["start_ms"]
            end = sentences[j]["end_ms"]
            duration = end - start
            if duration > max_duration_ms:
                break
            if _max_gap(words) > max_internal_gap_ms:
                # A later j only adds words after these, so the gap already
                # seen stays however far the run grows. Stop this start.
                break
            if duration < min_duration_ms or len(words) < min_words:
                continue
            out.append({
                "start_ms": start,
                "end_ms": end,
                "duration_ms": duration,
                "word_count": len(words),
                "text": join_words(words),
                "sentence_span": (i, j),
            })
    return out


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


def select_windows(windows: list, max_overlap_ratio: float = MAX_OVERLAP_RATIO,
                   target_duration_ms: int = TARGET_DURATION_MS) -> list:
    """The windows to keep: closest to the target first, overlap capped.

    Greedy rather than optimal, and deterministic: windows are ranked by
    distance from the target, then by start and end, so the same transcript
    always yields the same clips. An "optimal" packing would be a different
    function with the same signature if it is ever wanted.
    """
    ranked = sorted(
        windows,
        key=lambda w: (abs(w["duration_ms"] - target_duration_ms), w["start_ms"], w["end_ms"]),
    )
    kept: list = []
    for window in ranked:
        if all(_overlap_ratio(window, other) <= max_overlap_ratio for other in kept):
            kept.append(window)
    return sorted(kept, key=lambda w: (w["start_ms"], w["end_ms"]))


def drop_overlapping(rows: list, kept: list,
                     max_overlap_ratio: float = MAX_OVERLAP_RATIO) -> tuple:
    """(rows to create, how many were dropped).

    A candidate is dropped when it shares more than `max_overlap_ratio` of
    the shorter of the two with any clip in `kept` -- the clips a re-run
    leaves alone (approved, rejected, imported, hand-made, edited by a
    person). The same limit `select_windows` holds candidates to among
    themselves, so a kept clip counts as one more window already chosen:
    a rejected clip is not suggested again, and an edited one does not get
    an untrimmed twin beside it.

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


def build_candidates(
    words_by_track,
    *,
    min_duration_ms: int = MIN_DURATION_MS,
    max_duration_ms: int = MAX_DURATION_MS,
    target_duration_ms: int = TARGET_DURATION_MS,
    min_words: int = MIN_WORDS,
    max_internal_gap_ms: int = MAX_INTERNAL_GAP_MS,
    max_overlap_ratio: float = MAX_OVERLAP_RATIO,
) -> list:
    """Candidate clip windows, per track and therefore per speaker.

    Each window carries `track_index`; the caller turns that into a
    speaker_id. Sorted by (track, start, end), so the result is stable.
    """
    out = []
    for key in sorted(words_by_track, key=lambda k: int(k)):
        track = int(key)
        sentences = build_sentences(words_by_track[key])
        windows = _valid_windows(
            sentences, min_duration_ms, max_duration_ms, min_words, max_internal_gap_ms,
        )
        for window in select_windows(windows, max_overlap_ratio, target_duration_ms):
            out.append({**window, "track_index": track})
    return sorted(out, key=lambda w: (w["track_index"], w["start_ms"], w["end_ms"]))


# ── Topics ───────────────────────────────────────────────────────────────────
#
# German handling is deliberately simple: a stopword list and nothing else.
# There is NO stemming and no compound splitting, so "Kamera" and "Kameras"
# are two terms, and "Lichtsetzung" is never split into "Licht" + "Setzung".
# A German stemmer is a dependency, and this module is stdlib-only; the cost
# is a less tidy topic list, not a wrong one. The same applies to English:
# "camera" and "cameras" do not merge.

#: Letters only -- so "2024" and "16:9" never become topics (numbers are
#: dropped), and a one-letter token cannot either.
_TOKEN_RE = re.compile(r"[^\W\d_]{2,}(?:['’][^\W\d_]+)*", re.UNICODE)

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

#: Both lists at once: a transcript can be either language, and the pipeline
#: detects language per TRACK rather than per project, so the scorer is not
#: told which one to expect. The two lists barely collide ("so", "in",
#: "war", "will", "man", "hat"), and a word that is a stopword in the other
#: language is not a topic in this one either.
STOPWORDS = _STOPWORDS_EN | _STOPWORDS_DE


def tokenize(text: str) -> list:
    """Lowercase letter-only tokens of two characters or more."""
    return _TOKEN_RE.findall((text or "").lower())


def _terms(text: str) -> Counter:
    """Unigrams and bigrams of one window, counted.

    A bigram is two ADJACENT tokens that are both content words, so "social
    media" survives while "of the" and "media of" never form. That keeps the
    bigram list to real phrases without needing a grammar.
    """
    tokens = tokenize(text)
    counts = Counter(t for t in tokens if t not in STOPWORDS)
    for first, second in zip(tokens, tokens[1:]):
        if first not in STOPWORDS and second not in STOPWORDS:
            counts[f"{first} {second}"] += 1
    return counts


def extract_topics(windows, top_n: int = TOPIC_COUNT,
                   corpus: Optional[Iterable[str]] = None) -> list:
    """The top terms of each window, by TF-IDF across all of them.

    `windows` is the list build_candidates returned (or any list of dicts
    with a "text"). Document frequency is counted over those windows plus
    `corpus`, which is how a project-wide corpus gets in: the pipeline
    passes only the file's own windows today, and a caller holding every
    window of the project can pass the rest as `corpus` without this
    function changing.

    Returns one list of terms per window, in the same order. Fully
    deterministic: every ranking breaks ties on the term itself.
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

    out = []
    for counts in own:
        total_terms = sum(counts.values())
        if total_terms == 0:
            out.append([])
            continue
        # Smoothed, so a term in every window still scores above zero and a
        # one-window corpus does not collapse to all zeroes.
        scores = {
            term: (count / total_terms)
                  * (math.log((total_docs + 1) / (document_frequency[term] + 1)) + 1.0)
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
        key=lambda pair: (-pair[1], pair[0]),
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


def make_title(topics, quote: str = "", max_chars: int = TITLE_MAX_CHARS) -> str:
    """A short title from the top topics, or from the quote's first words.

    Two or three topics, title-cased and joined by a middle dot -- a topic
    list is what this is, and pretending it is a sentence would read worse.
    With fewer than two topics there is nothing to join, so the quote's
    first six words stand in.
    """
    usable = [t for t in (topics or []) if (t or "").strip()]
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
    words = " ".join((quote or "").split()[:6])
    return cut_on_word_boundary(words, max_chars)


# ── The whole job ────────────────────────────────────────────────────────────


def detect_snippets(media_file, *, top_n: int = TOPIC_COUNT,
                    corpus: Optional[Iterable[str]] = None, **limits) -> list:
    """Ready-to-store `snippets` rows for one media file.

    `media_file` is the plain dict described at the top of this module, not
    an ORM row. `limits` is passed through to build_candidates, so a caller
    can widen the length rules without a second function.

    Every row carries source="keyword", generator="tfidf-v1",
    status="suggested", and quality_score/viral_score None -- see the module
    docstring on why those two are not filled.
    """
    tracks = (media_file or {}).get("tracks") or {}
    words_by_track = {int(key): (value.get("words") or []) for key, value in tracks.items()}
    by_track = {int(key): value for key, value in tracks.items()}

    windows = build_candidates(words_by_track, **limits)
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
            "quality_score": None,
            "viral_score": None,
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
