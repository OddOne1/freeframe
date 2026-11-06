"""SocialSnippet search and suggest: the reads behind the clip browser.

Called by routers/snippet.py; no HTTP here. Postgres only: the matching
uses the generated `transcript_segments.search_vector` (and its GIN index),
`unnest` over `snippets.topics`, and `pg_trgm` where the database has it.

── The read rule ───────────────────────────────────────────────────────────
Every query over an asset-bound table goes through `Model.live(db)` /
`Model.live_clause()` (models/snippet.py), which is the one implementation
of "leave out the rows of a soft-deleted asset". The project scope is a
separate IN over the project's media files and says nothing about
deletion. No outer query here joins `media_files`, `asset_versions` or
`assets`: the live clause is an EXISTS over exactly those three, and an
outer join on them would let SQLAlchemy auto-correlate it away.

── How a search is answered ────────────────────────────────────────────────
1. The matching snippets, with every filter applied in SQL. When there is a
   query, a snippet matches on its title, quote, topics or speaker name, OR
   on transcript text inside its own range (a segment of the same file that
   overlaps it and matches `plainto_tsquery('simple', q)`).
2. With a query, the transcript hits no snippet covers become "moments":
   the matching sentence, padded with whole neighbouring sentences to 8-30 s.
3. Both are sorted and grouped in Python over their key columns, the page
   is cut, and only then are the page's files looked up -- one query.

Step 3 is in Python because a moment's length -- which the duration filter
and the length sorts need -- only exists once its sentence has been padded
from the words, and that is not SQL. The scan is capped (SNIPPET_SCAN_CAP,
MOMENT_HIT_CAP), which bounds the cost far beyond a project of interviews;
`capped` in the result says when a cap was reached.
"""
from __future__ import annotations

import math
import re
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

from sqlalchemy import exists, func, literal, or_, select, text, true, tuple_

from ..models.asset import Asset, AssetType, AssetVersion, MediaFile
from ..models.snippet import (
    Snippet, SnippetSpeaker, SnippetStatus, TranscriptSegment, TranscriptWord,
)
from .search import LIKE_ESCAPE, like_contains
from .snippet_detect import MAX_INTERNAL_GAP_MS, build_sentences, join_words

#: A moment is padded to at least this long, with whole sentences...
MOMENT_MIN_MS = 8_000
#: ...and never longer than this.
MOMENT_MAX_MS = 30_000
#: Segments either side of a hit that are read for padding. Whisper
#: segments run 2-10 s, so four each way reaches past MOMENT_MAX_MS.
CONTEXT_SEGMENTS = 4

#: Most matching snippets read for one search.
SNIPPET_SCAN_CAP = 5_000
#: Most transcript hits turned into moments for one search, best first.
MOMENT_HIT_CAP = 300

#: Suggest returns at most this many names and this many topics.
SUGGEST_LIMIT = 6
#: pg_trgm's own default `similarity_threshold`.
TRIGRAM_THRESHOLD = 0.3

#: Snippets a default search shows; "rejected" only when asked for.
DEFAULT_STATUSES = (SnippetStatus.suggested, SnippetStatus.approved)

#: Between topics when the topic list is matched as one string. A control
#: character nobody types, so a query cannot match across two topics.
_TOPIC_SEP = "\x1f"

#: Relevance weights. A title hit beats a topic or a name, which beat the
#: quote; transcript text ranks by ts_rank (about 0.01-0.1) scaled so a
#: strong transcript hit sits between a quote hit and a title hit.
_W_TITLE, _W_TOPIC, _W_SPEAKER, _W_QUOTE, _W_TEXT = 3.0, 2.0, 2.0, 1.0, 10.0


# ── Small helpers ──────────────────────────────────────────────────────────


def is_postgres(db) -> bool:
    return db.get_bind().dialect.name == "postgresql"


def has_trigram(db) -> bool:
    """Is `pg_trgm` installed in THIS database? Asked every time, never assumed:
    the migration created its trigram index only where the extension already
    existed, and an operator can add it later."""
    if not is_postgres(db):
        return False
    return db.execute(
        text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
    ).first() is not None


def project_media_files(project_id):
    """SELECT of every media file id of the project's assets.

    Scope only: it does NOT leave out deleted assets, the live clause does.
    """
    return (
        select(MediaFile.id)
        .join(AssetVersion, AssetVersion.id == MediaFile.version_id)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .where(Asset.project_id == project_id)
    )


def query_terms(q: Optional[str]) -> list:
    """What `plainto_tsquery('simple', q)` keeps, near enough: lowercased runs
    of letters and digits. Used to find the matching sentence in Python."""
    return re.findall(r"\w+", (q or "").lower())


def _topics_unnest():
    return func.unnest(Snippet.topics).table_valued("topic").render_derived(name="tt")


def _starts_word(name: str, prefix: str) -> bool:
    """`prefix` starts the name or any word of it ("exa" finds "Anna Example")."""
    name = name.lower()
    return name.startswith(prefix) or any(w.startswith(prefix) for w in name.split())


# ── File info, for clip URLs ───────────────────────────────────────────────


@dataclass
class FileInfo:
    media_file_id: uuid.UUID
    asset_id: uuid.UUID
    asset_name: str
    asset_type: AssetType
    s3_key_processed: Optional[str]
    s3_key_raw: Optional[str]
    s3_key_thumbnail: Optional[str]
    duration_seconds: Optional[float]


def file_infos(db, media_file_ids) -> dict:
    """{media_file_id: FileInfo}, in one query.

    No live filter: every id handed in came from a row that was already
    read through the live rule.
    """
    ids = list(set(media_file_ids))
    if not ids:
        return {}
    rows = (
        db.query(
            MediaFile.id, Asset.id, Asset.name, Asset.asset_type,
            MediaFile.s3_key_processed, MediaFile.s3_key_raw, MediaFile.s3_key_thumbnail,
            MediaFile.duration_seconds,
        )
        .join(AssetVersion, AssetVersion.id == MediaFile.version_id)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .filter(MediaFile.id.in_(ids))
        .all()
    )
    return {r[0]: FileInfo(*r) for r in rows}


def roster(db, project_id) -> dict:
    """{speaker_id: name} for the project. A roster is a handful of people."""
    return {
        sid: name for sid, name in
        db.query(SnippetSpeaker.id, SnippetSpeaker.name)
        .filter(SnippetSpeaker.project_id == project_id)
        .all()
    }


# ── Suggest ────────────────────────────────────────────────────────────────


def _usable_snippets(project_id) -> tuple:
    """Criteria: live snippets of the project that suggest counts (suggested or approved)."""
    return (
        Snippet.live_clause(),
        Snippet.media_file_id.in_(project_media_files(project_id)),
        Snippet.status.in_(DEFAULT_STATUSES),
    )


def _similarities(db, values: list, q: str) -> dict:
    """{value: similarity(value, q)} from pg_trgm, in one round trip."""
    rows = db.execute(
        text("SELECT v, similarity(v, :q) FROM unnest(CAST(:vals AS text[])) AS v"),
        {"q": q, "vals": values},
    ).all()
    return {v: s for v, s in rows}


def suggest(db, project_id, q: Optional[str]) -> dict:
    """{"names": [(id, name)], "topics": [(topic, count)]} for the search box.

    Only speakers and topics that a usable snippet carries: a name or topic
    that exists only on a trashed asset or a rejected clip would lead to an
    empty search. Prefix (of the name or of any word in it) first, most used
    first; then trigram matches when pg_trgm is installed. Empty q: the most
    used.
    """
    ql = " ".join((q or "").split()).lower()
    trgm = None  # looked up at most once, and only when needed

    # Names.
    usage = dict(
        db.query(Snippet.speaker_id, func.count())
        .filter(*_usable_snippets(project_id), Snippet.speaker_id.isnot(None))
        .group_by(Snippet.speaker_id)
        .all()
    )
    people = roster(db, project_id)
    in_use = sorted(
        ((sid, name) for sid, name in people.items() if usage.get(sid)),
        key=lambda p: (-usage[p[0]], p[1].lower()),
    )
    if not ql:
        names = in_use[:SUGGEST_LIMIT]
    else:
        names = [p for p in in_use if _starts_word(p[1], ql)][:SUGGEST_LIMIT]
        if len(names) < SUGGEST_LIMIT:
            trgm = has_trigram(db)
            taken = {sid for sid, _ in names}
            rest = [(sid, name) for sid, name in in_use if sid not in taken]
            if trgm and rest:
                sims = _similarities(db, sorted({name.lower() for _, name in rest}), ql)
                more = sorted(
                    (p for p in rest if sims.get(p[1].lower(), 0) >= TRIGRAM_THRESHOLD),
                    key=lambda p: (-sims[p[1].lower()], -usage[p[0]], p[1].lower()),
                )
                names += more[:SUGGEST_LIMIT - len(names)]

    # Topics: case-insensitively one topic, shown in its most used spelling.
    tt = _topics_unnest()
    counted = (
        db.query(tt.c.topic, func.count())
        .select_from(Snippet)
        .join(tt, true())
        .filter(*_usable_snippets(project_id))
        .group_by(tt.c.topic)
        .all()
    )
    totals: Counter = Counter()
    spellings: dict = {}
    for spelling, n in counted:
        clean = " ".join((spelling or "").split())
        if not clean:
            continue
        k = clean.lower()
        totals[k] += n
        spellings.setdefault(k, Counter())[clean] += n
    label = {k: min(c.items(), key=lambda kv: (-kv[1], kv[0]))[0] for k, c in spellings.items()}
    ranked = sorted(totals, key=lambda k: (-totals[k], k))
    if not ql:
        topics = ranked[:SUGGEST_LIMIT]
    else:
        topics = [k for k in ranked if _starts_word(k, ql)][:SUGGEST_LIMIT]
        if len(topics) < SUGGEST_LIMIT:
            if trgm is None:
                trgm = has_trigram(db)
            taken = set(topics)
            rest = [k for k in ranked if k not in taken]
            if trgm and rest:
                sims = _similarities(db, rest, ql)
                more = sorted(
                    (k for k in rest if sims.get(k, 0) >= TRIGRAM_THRESHOLD),
                    key=lambda k: (-sims[k], -totals[k], k),
                )
                topics += more[:SUGGEST_LIMIT - len(topics)]

    return {
        "names": [{"id": sid, "name": name} for sid, name in names],
        "topics": [{"topic": label[k], "count": totals[k]} for k in topics],
    }


# ── Search ─────────────────────────────────────────────────────────────────


@dataclass
class SearchParams:
    q: Optional[str] = None
    speaker_ids: list = field(default_factory=list)
    topics: list = field(default_factory=list)
    min_ms: Optional[int] = None
    max_ms: Optional[int] = None
    sources: list = field(default_factory=list)
    #: Empty = DEFAULT_STATUSES. Any explicit status leaves moments out:
    #: a moment has no review status to match.
    statuses: list = field(default_factory=list)
    sort: str = "relevance"
    group: str = "none"
    page: int = 1
    page_size: int = 24


@dataclass
class Hit:
    """One search result before it becomes a Clip."""

    kind: str  # "snippet" | "moment"
    media_file_id: uuid.UUID
    start_ms: int
    end_ms: int
    speaker_id: Optional[uuid.UUID]
    rank: float
    quality: Optional[float] = None
    viral: Optional[float] = None
    topics: list = field(default_factory=list)
    snippet: Optional[Snippet] = None
    #: Moments only: the padded text.
    text: Optional[str] = None

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms

    @property
    def id(self) -> str:
        if self.snippet is not None:
            return str(self.snippet.id)
        return f"moment:{self.media_file_id}:{self.start_ms}"


@dataclass
class SearchResult:
    total: int
    #: [(key, label, [Hit])] for this page only, in display order.
    groups: list
    #: {media_file_id: FileInfo} for the page's hits.
    files: dict
    #: {speaker_id: name}, the project roster.
    speakers: dict
    capped: bool = False


def _matching_snippets(db, project_id, p: SearchParams, terms, speakers) -> tuple:
    """([(Snippet, transcript_rank or None)], capped)."""
    query = Snippet.live(db).filter(Snippet.media_file_id.in_(project_media_files(project_id)))
    statuses = [SnippetStatus(s) for s in p.statuses] or list(DEFAULT_STATUSES)
    query = query.filter(Snippet.status.in_(statuses))
    if p.speaker_ids:
        query = query.filter(Snippet.speaker_id.in_(p.speaker_ids))
    if p.sources:
        query = query.filter(Snippet.source.in_(p.sources))
    if p.topics:
        tt = _topics_unnest()
        wanted = sorted({" ".join(t.split()).lower() for t in p.topics if t.strip()})
        query = query.filter(
            exists(select(literal(1)).select_from(tt).where(func.lower(tt.c.topic).in_(wanted)))
        )
    duration = Snippet.end_ms - Snippet.start_ms
    if p.min_ms is not None:
        query = query.filter(duration >= p.min_ms)
    if p.max_ms is not None:
        query = query.filter(duration <= p.max_ms)

    q = (p.q or "").strip()
    text_rank = None
    if q:
        pattern = like_contains(q)
        conditions = [
            Snippet.title.ilike(pattern, escape=LIKE_ESCAPE),
            Snippet.quote.ilike(pattern, escape=LIKE_ESCAPE),
            func.array_to_string(Snippet.topics, _TOPIC_SEP).ilike(pattern, escape=LIKE_ESCAPE),
        ]
        named = [sid for sid, name in speakers.items() if q.lower() in name.lower()]
        if named:
            conditions.append(Snippet.speaker_id.in_(named))
        if terms:
            tsq = func.plainto_tsquery("simple", q)
            conditions.append(
                func.to_tsvector(
                    "simple",
                    func.coalesce(Snippet.title, "") + " " + func.coalesce(Snippet.quote, ""),
                ).op("@@")(tsq)
            )
            seg = TranscriptSegment
            text_rank = (
                select(func.max(func.ts_rank(seg.search_vector, tsq)))
                .where(
                    seg.media_file_id == Snippet.media_file_id,
                    seg.start_ms < Snippet.end_ms,
                    seg.end_ms > Snippet.start_ms,
                    seg.search_vector.op("@@")(tsq),
                )
                .correlate(Snippet)
                .scalar_subquery()
            )
            conditions.append(text_rank.isnot(None))
        query = query.filter(or_(*conditions))

    query = query.add_columns(text_rank if text_rank is not None else literal(None))
    rows = query.limit(SNIPPET_SCAN_CAP + 1).all()
    return rows[:SNIPPET_SCAN_CAP], len(rows) > SNIPPET_SCAN_CAP


def _snippet_rank(s: Snippet, text_rank, q: str, speakers) -> float:
    if not q:
        return 0.0
    ql = q.lower()
    rank = 0.0
    if s.title and ql in s.title.lower():
        rank += _W_TITLE
    if any(ql in (t or "").lower() for t in (s.topics or [])):
        rank += _W_TOPIC
    if s.speaker_id is not None and ql in (speakers.get(s.speaker_id) or "").lower():
        rank += _W_SPEAKER
    if s.quote and ql in s.quote.lower():
        rank += _W_QUOTE
    return rank + _W_TEXT * float(text_rank or 0.0)


def _pick_sentence(sentences, hit_start, hit_end, terms) -> int:
    """Index of the sentence the hit is about: the one inside the hit segment
    sharing the most query terms (earliest on a tie); else the nearest."""
    terms = set(terms)
    inside = [
        i for i, s in enumerate(sentences)
        if s["start_ms"] < hit_end and s["end_ms"] > hit_start
    ] or [i for i, s in enumerate(sentences) if hit_start <= s["start_ms"] <= hit_end]
    if not inside:
        return min(range(len(sentences)), key=lambda i: abs(sentences[i]["start_ms"] - hit_start))
    return max(inside, key=lambda i: (len(terms & set(query_terms(sentences[i]["text"]))), -i))


def _matched_span(sentence, terms) -> tuple:
    """(start_ms, end_ms) from the first to the last word of the sentence that
    carries a query term; the whole sentence when none does (the database
    matched on a token this tokenizer splits differently)."""
    terms = set(terms)
    hit = [w for w in sentence["words"] if terms & set(query_terms(w["word"]))]
    if not hit:
        return sentence["start_ms"], sentence["end_ms"]
    return hit[0]["start_ms"], hit[-1]["end_ms"]


def _pad(sentences, i: int, terms, duration_ms: Optional[int]) -> tuple:
    """(start_ms, end_ms, text) of the moment around sentence i.

    1. Whole neighbouring sentences are added, the next one first, until it
       is MOMENT_MIN_MS long -- never past MOMENT_MAX_MS, and never across a
       pause over MAX_INTERNAL_GAP_MS (snippet_detect's rule: a pause that
       long is a cut, and the sentence on the far side is another thought).
    2. A single sentence over MOMENT_MAX_MS is cut at word boundaries: its
       first MOMENT_MAX_MS when the first matching word falls inside them,
       else its last MOMENT_MAX_MS when the word falls inside those, else
       the MOMENT_MAX_MS starting at the word. Every option keeps the word.
    3. Still under MOMENT_MIN_MS (an isolated short remark): widened into
       the silence either side, evenly where there is room, never into a
       neighbouring sentence or outside the file. Under MOMENT_MIN_MS only
       when the file itself leaves no more room.
    """
    lo = hi = i

    def span(a, b):
        return sentences[b]["end_ms"] - sentences[a]["start_ms"]

    def joins(a, b):  # sentence a directly followed by sentence b
        return sentences[b]["start_ms"] - sentences[a]["end_ms"] <= MAX_INTERNAL_GAP_MS

    while span(lo, hi) < MOMENT_MIN_MS:
        if hi + 1 < len(sentences) and joins(hi, hi + 1) and span(lo, hi + 1) <= MOMENT_MAX_MS:
            hi += 1
        elif lo > 0 and joins(lo - 1, lo) and span(lo - 1, hi) <= MOMENT_MAX_MS:
            lo -= 1
        else:
            break

    words = [w for s in sentences[lo:hi + 1] for w in s["words"]]
    if span(lo, hi) < MOMENT_MIN_MS:
        start, end = sentences[lo]["start_ms"], sentences[hi]["end_ms"]
        floor = sentences[lo - 1]["end_ms"] if lo > 0 else 0
        ceiling = sentences[hi + 1]["start_ms"] if hi + 1 < len(sentences) else (
            max(duration_ms, end) if duration_ms else end + MOMENT_MIN_MS
        )
        need = MOMENT_MIN_MS - (end - start)
        before = min(start - floor, need // 2)
        after = min(ceiling - end, need - before)
        before = min(start - floor, need - after)
        return start - before, end + after, join_words(words)
    if span(lo, hi) > MOMENT_MAX_MS:
        terms = set(terms)
        anchor = next(
            (k for k, w in enumerate(words) if terms & set(query_terms(w["word"]))), 0
        )
        first = 0
        if words[anchor]["end_ms"] - words[0]["start_ms"] > MOMENT_MAX_MS:
            tail = next(k for k, w in enumerate(words)
                        if words[-1]["end_ms"] - w["start_ms"] <= MOMENT_MAX_MS)
            first = tail if tail <= anchor else anchor
        limit = words[first]["start_ms"] + MOMENT_MAX_MS
        last = first
        while last + 1 < len(words) and words[last + 1]["end_ms"] <= limit:
            last += 1
        words = words[first:last + 1]
    return words[0]["start_ms"], words[-1]["end_ms"], join_words(words)


def _moments(db, project_id, p: SearchParams, terms) -> tuple:
    """([Hit], capped): transcript hits that no snippet covers.

    None at all when the search filters on something a moment does not
    have (topic, source, status): it could never match.
    """
    q = (p.q or "").strip()
    if not q or not terms or p.topics or p.sources or p.statuses:
        return [], False
    seg = TranscriptSegment
    tsq = func.plainto_tsquery("simple", q)
    ts_rank = func.ts_rank(seg.search_vector, tsq).label("rank")
    hits_q = (
        seg.live(db)
        .with_entities(seg.id, seg.media_file_id, seg.track_index, seg.seq,
                       seg.start_ms, seg.end_ms, seg.speaker_id, seg.text_current, ts_rank)
        .filter(seg.media_file_id.in_(project_media_files(project_id)),
                seg.search_vector.op("@@")(tsq))
    )
    if p.speaker_ids:
        hits_q = hits_q.filter(seg.speaker_id.in_(p.speaker_ids))
    hits = (
        hits_q.order_by(ts_rank.desc(), seg.media_file_id, seg.start_ms)
        .limit(MOMENT_HIT_CAP + 1)
        .all()
    )
    capped = len(hits) > MOMENT_HIT_CAP
    hits = hits[:MOMENT_HIT_CAP]
    if not hits:
        return [], capped

    # The neighbouring segments of every hit, then their words: two queries.
    pairs = sorted({(h.media_file_id, h.track_index) for h in hits}, key=str)
    by_pair: dict = {}
    for row in (
        seg.live(db)
        .with_entities(seg.id, seg.media_file_id, seg.track_index, seg.seq)
        .filter(tuple_(seg.media_file_id, seg.track_index).in_(pairs))
        .all()
    ):
        by_pair.setdefault((row.media_file_id, row.track_index), []).append(row)
    windows: dict = {}
    wanted_ids: set = set()
    for h in hits:
        rows = sorted(
            (r for r in by_pair.get((h.media_file_id, h.track_index), [])
             if abs(r.seq - h.seq) <= CONTEXT_SEGMENTS),
            key=lambda r: r.seq,
        )
        windows[h.id] = [r.id for r in rows]
        wanted_ids.update(windows[h.id])
    words_by_segment: dict = {}
    for w in (
        TranscriptWord.live(db)
        .filter(TranscriptWord.segment_id.in_(list(wanted_ids)))
        .order_by(TranscriptWord.segment_id, TranscriptWord.idx)
        .all()
    ):
        words_by_segment.setdefault(w.segment_id, []).append(
            {"start_ms": w.start_ms, "end_ms": w.end_ms, "word": w.word}
        )

    hit_files = list({h.media_file_id for h in hits})
    durations = {
        mf_id: (int(math.ceil(seconds * 1000)) if seconds and seconds > 0 else None)
        for mf_id, seconds in
        db.query(MediaFile.id, MediaFile.duration_seconds).filter(MediaFile.id.in_(hit_files)).all()
    }

    # Any stored clip on the file, whatever its status, covers what it spans.
    covering: dict = {}
    for mf_id, start, end in (
        Snippet.live(db)
        .with_entities(Snippet.media_file_id, Snippet.start_ms, Snippet.end_ms)
        .filter(Snippet.media_file_id.in_(hit_files))
        .all()
    ):
        covering.setdefault(mf_id, []).append((start, end))

    out: list = []
    kept: dict = {}
    for h in hits:
        words = [w for sid in windows[h.id] for w in words_by_segment.get(sid, [])]
        sentences = build_sentences(words)
        if sentences:
            i = _pick_sentence(sentences, h.start_ms, h.end_ms, terms)
            matched = _matched_span(sentences[i], terms)
            start, end, body = _pad(sentences, i, terms, durations.get(h.media_file_id))
        else:
            # No word timings: the segment is the best boundary there is.
            matched = (h.start_ms, h.end_ms)
            start, end = h.start_ms, min(h.end_ms, h.start_ms + MOMENT_MAX_MS)
            body = " ".join((h.text_current or "").split())
        # Covered = a stored clip contains the words that matched. Not the
        # whole sentence: a 35 s sentence would otherwise be "covered" by a
        # clip of its first few seconds that never says the word.
        if any(s < matched[1] and e > matched[0] for s, e in covering.get(h.media_file_id, [])):
            continue
        key = (h.media_file_id, h.track_index)
        if any(s < end and e > start for s, e in kept.get(key, [])):
            continue  # a better-ranked hit already made this moment
        duration = end - start
        if p.min_ms is not None and duration < p.min_ms:
            continue
        if p.max_ms is not None and duration > p.max_ms:
            continue
        kept.setdefault(key, []).append((start, end))
        out.append(Hit(
            kind="moment", media_file_id=h.media_file_id, start_ms=start, end_ms=end,
            speaker_id=h.speaker_id, rank=_W_TEXT * float(h.rank or 0.0), text=body,
        ))
    return out, capped


_NONE_KEY = "none"


def _group_entries(hits, group: str, speakers) -> list:
    """[(key, label, hit)]. A clip with several topics is in each of their
    groups; one with none (and every moment) is in "none"."""
    if group == "none":
        return [("all", "All", h) for h in hits]
    entries = []
    if group == "speaker":
        for h in hits:
            if h.speaker_id is not None and h.speaker_id in speakers:
                entries.append((str(h.speaker_id), speakers[h.speaker_id], h))
            else:
                entries.append((_NONE_KEY, "No speaker", h))
        return entries
    spellings: dict = {}
    keyed = []
    for h in hits:
        seen = set()
        for t in h.topics or []:
            clean = " ".join((t or "").split())
            k = clean.lower()
            if not k or k in seen:
                continue
            seen.add(k)
            spellings.setdefault(k, Counter())[clean] += 1
            keyed.append((k, h))
        if not seen:
            keyed.append((_NONE_KEY, h))
    # A group is labelled with its most used spelling (alphabetical on a tie),
    # so the label does not depend on which row the database returned first.
    label = {k: min(c.items(), key=lambda kv: (-kv[1], kv[0]))[0] for k, c in spellings.items()}
    label[_NONE_KEY] = "No topic"
    return [(k, label[k], h) for k, h in keyed]


def _sort_key(sort: str, files):
    def place(h):
        info = files.get(h.media_file_id)
        return (info.asset_name.lower() if info else "", h.start_ms, h.id)

    def nulls_last_desc(v):
        return (v is None, -(v or 0.0))

    if sort == "quality":
        return lambda h: (nulls_last_desc(h.quality), -h.rank, place(h))
    if sort == "viral":
        return lambda h: (nulls_last_desc(h.viral), -h.rank, place(h))
    if sort == "length_asc":
        return lambda h: (h.duration_ms, place(h))
    if sort == "length_desc":
        return lambda h: (-h.duration_ms, place(h))
    # relevance. With no query every rank is 0, so this is best-scored first.
    return lambda h: (-h.rank, nulls_last_desc(h.quality), place(h))


def search(db, project_id, p: SearchParams) -> SearchResult:
    """One page of results. Groups are ordered by label ("none" last), items
    within a group by `p.sort`; the page is cut from that one flat order, so
    a group can continue on the next page and `total` counts entries (with
    group=topic a clip counts once per topic)."""
    terms = query_terms(p.q)
    speakers = roster(db, project_id)
    rows, capped_s = _matching_snippets(db, project_id, p, terms, speakers)
    q = (p.q or "").strip()
    hits = [
        Hit(kind="snippet", media_file_id=s.media_file_id, start_ms=s.start_ms, end_ms=s.end_ms,
            speaker_id=s.speaker_id, rank=_snippet_rank(s, text_rank, q, speakers),
            quality=s.quality_score, viral=s.viral_score, topics=list(s.topics or []), snippet=s)
        for s, text_rank in rows
    ]
    moments, capped_m = _moments(db, project_id, p, terms)
    hits += moments

    files = file_infos(db, [h.media_file_id for h in hits])
    key_fn = _sort_key(p.sort, files)
    by_group: dict = {}
    for k, label, h in _group_entries(hits, p.group, speakers):
        by_group.setdefault(k, (label, []))[1].append(h)
    order = sorted(by_group, key=lambda k: (k == _NONE_KEY, by_group[k][0].lower(), k))
    flat = [(k, by_group[k][0], h) for k in order for h in sorted(by_group[k][1], key=key_fn)]

    start = (p.page - 1) * p.page_size
    page = flat[start:start + p.page_size]
    groups: list = []
    for k, label, h in page:
        if not groups or groups[-1][0] != k:
            groups.append((k, label, []))
        groups[-1][2].append(h)
    if p.group == "none" and not groups:
        groups = [("all", "All", [])]

    page_files = {h.media_file_id for _, _, h in page}
    return SearchResult(
        total=len(flat), groups=groups,
        files={k: v for k, v in files.items() if k in page_files},
        speakers=speakers, capped=capped_s or capped_m,
    )
