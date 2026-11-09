"""The "tfidf-v1" clip detector, frozen -- for comparison only.

This is the detector services/snippet_detect.py ran before "keyword-v2",
copied unchanged (window rules, stoplists, tokenizer, titles) at commit
54371c1. Nothing in the pipeline calls it and nothing it returns is ever
written to the database: scripts/snippet_detect_compare.py runs it beside
v2 so a person can see what the new rules changed on a real file.

Do not fix bugs here. Its known faults -- "I've" tokenised to "ve",
retakes and chatter offered as clips, profanity in titles -- are exactly
what the comparison is meant to show. The helpers v2 kept unchanged
(sentences, joining words, overlap, cutting on a word boundary) are
imported from there rather than copied, so they cannot drift apart.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Iterable, Optional

from .snippet_detect import (
    QUOTE_MAX_CHARS, SOURCE, STATUS_SUGGESTED, TITLE_MAX_CHARS, TITLE_SEPARATOR,
    _max_gap, _overlap_ratio, _title_case, build_sentences, cut_on_word_boundary,
    join_words,
)

MIN_DURATION_MS = 8_000
MAX_DURATION_MS = 45_000
TARGET_DURATION_MS = 20_000
MIN_WORDS = 12
MAX_INTERNAL_GAP_MS = 2_000
MAX_OVERLAP_RATIO = 0.30
TOPIC_COUNT = 4
GENERATOR = "tfidf-v1"
BIGRAM_PREFERENCE = 0.80

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
