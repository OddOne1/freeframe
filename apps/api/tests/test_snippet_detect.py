"""Clip detection, import and export.

Two halves, as elsewhere in SocialSnippet's tests:

* Pure logic, no database -- the window rules, the TF-IDF topics on an
  English and a German sample, the titles, and every import check. These
  are plain functions over plain dicts (services/snippet_detect.py), so
  they are tested as such.

* SQLite with foreign keys on and every model built by `create_all`, the
  setup test_snippet_pipeline.py uses -- the `detect` stage, what a re-run
  replaces and what it must never touch, and the scripts' output.

No ffmpeg and no Whisper here: detection reads `transcript_words` rows that
these tests write directly, so none of it depends on a model.
"""

import json
import uuid

import pytest

from apps.api.services import snippet_detect as sd


# ── words, by hand ───────────────────────────────────────────────────────
#
# Every pure test builds words with this, so a test says what it is about
# (sentence boundaries, a gap, a length) rather than restating timings.


def words(text, *, start_ms=0, word_ms=300, gap_ms=100, gaps=None):
    """Turn a sentence into word dicts at a steady rate.

    `gaps` is {index: extra silence in ms BEFORE that word}, for testing the
    internal-gap rule.
    """
    out, t = [], start_ms
    for index, token in enumerate(text.split()):
        t += (gaps or {}).get(index, 0)
        out.append({"start_ms": t, "end_ms": t + word_ms, "word": " " + token})
        t += word_ms + gap_ms
    return out


EN = (
    "We shot the whole interview on a single camera today. "
    "The camera moves very little and the light stays soft. "
    "Soft light on a face is what makes an interview readable. "
    "Our camera setup is two lenses and one soft light box."
)

DE = (
    "Wir haben das ganze Interview heute mit einer einzigen Kamera gedreht. "
    "Die Kamera bewegt sich kaum und das Licht bleibt weich. "
    "Weiches Licht im Gesicht macht ein Interview lesbar. "
    "Unser Kamera Aufbau sind zwei Objektive und eine weiche Lichtquelle."
)


# ── (a) sentences and windows ────────────────────────────────────────────


def test_sentences_split_on_terminal_punctuation_only():
    sentences = sd.build_sentences(words(EN))
    assert len(sentences) == 4
    assert sentences[0]["text"].endswith("camera today.")
    assert sentences[1]["text"].startswith("The camera moves")
    for sentence in sentences:
        assert sentence["start_ms"] == sentence["words"][0]["start_ms"]
        assert sentence["end_ms"] == sentence["words"][-1]["end_ms"]


def test_a_trailing_run_without_punctuation_is_still_a_sentence():
    """Whisper regularly leaves the last sentence unfinished; dropping it
    would lose the end of every file."""
    sentences = sd.build_sentences(words("One done. and then this trails off"))
    assert len(sentences) == 2
    assert sentences[1]["text"] == "and then this trails off"


def test_a_question_mark_and_a_closing_quote_both_end_a_sentence():
    sentences = sd.build_sentences(words('Is it ready? "Yes it is." And so we went'))
    assert [s["text"] for s in sentences][:2] == ['Is it ready?', '"Yes it is."']


def test_every_window_starts_at_a_sentence_start_and_ends_at_a_sentence_end():
    sentences = sd.build_sentences(words(EN))
    starts = {s["start_ms"] for s in sentences}
    ends = {s["end_ms"] for s in sentences}
    candidates = sd.build_candidates({0: words(EN)})
    assert candidates
    for window in candidates:
        assert window["start_ms"] in starts
        assert window["end_ms"] in ends


def test_a_window_shorter_than_the_minimum_is_not_offered():
    """Four words at 400 ms is 1.6 s: far too short, and far too few
    words."""
    assert sd.build_candidates({0: words("Short and sweet done.")}) == []


def test_the_maximum_length_is_respected():
    long_text = " ".join(["word"] * 59) + " end."
    candidates = sd.build_candidates({0: words(long_text, word_ms=900, gap_ms=100)})
    for window in candidates:
        assert window["duration_ms"] <= sd.MAX_DURATION_MS


def test_a_window_with_too_few_words_is_rejected_even_when_long_enough():
    """Ten words spread over twelve seconds passes the duration rule and
    still is not a clip -- MIN_WORDS is what rejects it."""
    sparse = words(" ".join(["word"] * 9) + " end.", word_ms=200, gap_ms=1_100)
    assert len(sparse) == 10
    assert sparse[-1]["end_ms"] - sparse[0]["start_ms"] > sd.MIN_DURATION_MS
    assert sd.build_candidates({0: sparse}) == []


def test_an_internal_silence_over_the_limit_splits_the_candidates():
    """A 3 s hole is a cut, not a breath: no window may span it."""
    text = (" ".join(["alpha"] * 20) + " first. " + " ".join(["beta"] * 20) + " second.")
    hole_at = 21
    with_gap = words(text, gaps={hole_at: 3_000})
    hole_start = with_gap[hole_at - 1]["end_ms"]
    hole_end = with_gap[hole_at]["start_ms"]
    assert hole_end - hole_start > sd.MAX_INTERNAL_GAP_MS

    for window in sd.build_candidates({0: with_gap}):
        spans_hole = window["start_ms"] <= hole_start and window["end_ms"] >= hole_end
        assert not spans_hole, window


def test_kept_windows_never_overlap_by_more_than_the_cap():
    text = " ".join("alpha number." for _ in range(40))
    candidates = sd.build_candidates({0: words(text)})
    assert len(candidates) >= 2
    for i, first in enumerate(candidates):
        for second in candidates[i + 1:]:
            assert sd._overlap_ratio(first, second) <= sd.MAX_OVERLAP_RATIO + 1e-9


def test_windows_never_span_two_tracks():
    """One track is one speaker: a clip across two mics is two people
    talking over each other."""
    candidates = sd.build_candidates({0: words(EN), 1: words(DE)})
    assert {w["track_index"] for w in candidates} == {0, 1}
    for window in candidates:
        source = words(EN) if window["track_index"] == 0 else words(DE)
        assert window["start_ms"] >= source[0]["start_ms"]
        assert window["end_ms"] <= source[-1]["end_ms"]


def test_the_length_rules_are_arguments_not_hard_coded():
    """The constants are overridable, which is what makes them settings
    rather than magic numbers."""
    tight = sd.build_candidates({0: words(EN)}, min_duration_ms=1_000,
                                max_duration_ms=6_000, min_words=3)
    assert tight
    for window in tight:
        assert 1_000 <= window["duration_ms"] <= 6_000


# ── (b) topics ───────────────────────────────────────────────────────────


def test_topics_on_an_english_sample_find_the_subject_not_the_glue():
    candidates = sd.build_candidates({0: words(EN)}, min_duration_ms=1_000, min_words=3)
    flat = {term for window in sd.extract_topics(candidates) for term in window}
    assert "camera" in flat
    assert "light" in flat
    for term in flat:
        for token in term.split(" "):
            assert token not in sd.STOPWORDS, term
            assert len(token) > 1, term
            assert not token.isdigit(), term


def test_topics_on_a_german_sample_use_the_german_stopword_list():
    """German is handled with a stopword list and nothing else -- no
    stemming -- so "Kamera" is found while "haben", "das" and "mit" are
    not."""
    candidates = sd.build_candidates({0: words(DE)}, min_duration_ms=1_000, min_words=3)
    flat = {term for window in sd.extract_topics(candidates) for term in window}
    assert "kamera" in flat
    assert "licht" in flat or "weiches licht" in flat
    for glue in ("haben", "das", "mit", "und", "die", "sich", "ein"):
        assert not any(glue in term.split(" ") for term in flat), glue


def test_no_stemming_is_claimed_german_or_english():
    """Documents the known limit rather than pretending it is handled:
    singular and plural are two different terms."""
    assert sd.tokenize("Kamera Kameras") == ["kamera", "kameras"]
    assert sd.tokenize("camera cameras") == ["camera", "cameras"]


def test_numbers_and_single_letters_are_dropped_before_scoring():
    assert sd.tokenize("In 2024 we shot 16:9 at f 2.8 on a camera") == [
        "in", "we", "shot", "at", "on", "camera",
    ]


def test_a_bigram_wins_when_it_scores_close_to_its_own_words():
    """"social media" appearing wherever "media" does should beat the bare
    word, and must then remove it so the list is not "social media, media,
    social"."""
    text = "social media strategy for the brand. social media pays the bills here."
    topics = sd.extract_topics([{"text": text}], top_n=4)[0]
    assert "social media" in topics
    assert "media" not in topics
    assert "social" not in topics


def test_topics_are_deterministic_and_order_is_stable():
    candidates = sd.build_candidates({0: words(EN)}, min_duration_ms=1_000, min_words=3)
    first = sd.extract_topics(candidates)
    for _ in range(5):
        assert sd.extract_topics(candidates) == first


def test_a_corpus_can_widen_the_document_frequency():
    """The pipeline passes only this file's windows; a caller with the whole
    project's can pass the rest, and a term common across the project then
    scores lower."""
    # Stopwords between the two content words on purpose: with no adjacent
    # pair there is no bigram to swallow them, so what is measured here is
    # the idf and nothing else.
    window = [{"text": "camera is the light of it"}]
    alone = sd.extract_topics(window, top_n=2)[0]
    with_corpus = sd.extract_topics(
        window, top_n=2, corpus=["camera everywhere", "camera again", "camera once more"],
    )[0]
    assert set(alone) == {"camera", "light"}
    # "camera" is in every corpus document, so "light" overtakes it.
    assert with_corpus[0] == "light"


def test_a_window_of_nothing_but_stopwords_has_no_topics():
    assert sd.extract_topics([{"text": "and the of it is to"}]) == [[]]


# ── (c) titles and quotes ────────────────────────────────────────────────


def test_a_title_is_the_top_topics_title_cased():
    assert sd.make_title(["camera", "soft light", "interview", "lens"]) == (
        "Camera · Soft Light · Interview"
    )


def test_a_title_falls_back_to_the_quote_with_fewer_than_two_topics():
    assert sd.make_title([], "the quick brown fox jumps over the lazy dog") == (
        "the quick brown fox jumps over"
    )
    assert sd.make_title(["camera"], "one two three four five six seven") == (
        "one two three four five six"
    )


def test_a_title_stays_under_the_limit_and_drops_to_two_topics_first():
    title = sd.make_title(["a" * 25, "b" * 25, "c" * 25])
    assert len(title) <= sd.TITLE_MAX_CHARS
    assert title.count(sd.TITLE_SEPARATOR) == 1


def test_a_title_never_exceeds_the_limit_even_with_two_huge_topics():
    assert len(sd.make_title(["x" * 50, "y" * 50])) <= sd.TITLE_MAX_CHARS


def test_a_quote_is_cut_on_a_word_boundary_within_the_limit():
    cut = sd.cut_on_word_boundary(" ".join(["word"] * 200), sd.QUOTE_MAX_CHARS)
    assert len(cut) <= sd.QUOTE_MAX_CHARS
    assert cut.endswith("…")
    assert all(part == "word" for part in cut[:-1].split())


def test_a_single_word_longer_than_the_limit_is_cut_hard():
    """There is no boundary to use, so the limit wins over the rule."""
    assert len(sd.cut_on_word_boundary("z" * 100, 20)) <= 20


# ── (d) detect_snippets, end to end on plain data ────────────────────────


def test_detect_snippets_marks_every_row_keyword_and_leaves_the_scores_null():
    rows = sd.detect_snippets({
        "media_file_id": "mf-1",
        "tracks": {0: {"speaker": "Anna Example", "speaker_id": "sp-1", "words": words(EN)}},
    })
    assert rows
    for row in rows:
        assert row["source"] == "keyword"
        assert row["generator"] == "tfidf-v1"
        assert row["status"] == "suggested"
        # Not scored is NULL, not 0.0 -- counting words is not scoring.
        assert row["quality_score"] is None
        assert row["viral_score"] is None
        assert row["media_file_id"] == "mf-1"
        assert row["speaker_id"] == "sp-1"
        assert row["start_ms"] < row["end_ms"]
        assert len(row["quote"]) <= sd.QUOTE_MAX_CHARS
        assert len(row["title"]) <= sd.TITLE_MAX_CHARS


def test_detect_snippets_is_deterministic():
    media_file = {
        "media_file_id": "mf-1",
        "tracks": {0: {"speaker": "A", "words": words(EN)},
                   1: {"speaker": "B", "words": words(DE)}},
    }
    first = sd.detect_snippets(media_file)
    for _ in range(5):
        assert sd.detect_snippets(media_file) == first


def test_detect_snippets_accepts_string_track_keys_as_json_gives_them():
    from_json = json.loads(json.dumps({
        "media_file_id": "mf-1",
        "tracks": {0: {"speaker": "A", "speaker_id": None, "words": words(EN)}},
    }))
    assert list(from_json["tracks"]) == ["0"]
    assert sd.detect_snippets(from_json)


def test_a_file_with_no_words_detects_nothing():
    assert sd.detect_snippets({"media_file_id": "mf", "tracks": {}}) == []
    assert sd.detect_snippets({"media_file_id": "mf", "tracks": {0: {"words": []}}}) == []


# ── (e) import validation, on plain data ─────────────────────────────────


@pytest.fixture
def import_words():
    return {0: words(EN)}


def _payload(*items, generator="claude"):
    return {"meta": {"generator": generator}, "snippets": list(items)}


def _item(**over):
    base = {"start_ms": 0, "end_ms": 4_000, "title": "A clip", "topics": ["camera"]}
    base.update(over)
    return base


def test_import_reads_the_generator_from_meta(import_words):
    end = import_words[0][-1]["end_ms"]
    result = sd.validate_import(_payload(_item(end_ms=end)), import_words)
    assert result["generator"] == "claude"
    assert result["accepted"][0]["generator"] == "claude"
    assert result["accepted"][0]["source"] == "import"
    assert result["accepted"][0]["status"] == "suggested"


def test_import_refuses_a_payload_without_a_usable_generator(import_words):
    for meta in ({}, {"generator": ""}, {"generator": "   "}, {"generator": 7}, None):
        with pytest.raises(sd.ImportRefused, match="meta"):
            sd.validate_import({"meta": meta, "snippets": []}, import_words)


def test_import_refuses_a_payload_that_is_not_the_right_shape(import_words):
    with pytest.raises(sd.ImportRefused, match="JSON object"):
        sd.validate_import([], import_words)
    with pytest.raises(sd.ImportRefused, match='"snippets" must be a list'):
        sd.validate_import({"meta": {"generator": "gpt"}}, import_words)


def test_import_refuses_everything_when_the_file_has_no_transcript():
    with pytest.raises(sd.ImportRefused, match="no transcript words"):
        sd.validate_import(_payload(_item()), {})


def test_import_snaps_both_times_to_the_nearest_word_boundary(import_words):
    word = import_words[0][5]
    later = import_words[0][20]
    result = sd.validate_import(
        _payload(_item(start_ms=word["start_ms"] + 120, end_ms=later["end_ms"] - 120)),
        import_words,
    )
    assert result["refused"] == []
    assert result["snapped"] == 1
    assert result["accepted"][0]["start_ms"] == word["start_ms"]
    assert result["accepted"][0]["end_ms"] == later["end_ms"]


def test_import_keeps_times_that_already_sit_on_a_boundary(import_words):
    word, later = import_words[0][2], import_words[0][18]
    result = sd.validate_import(
        _payload(_item(start_ms=word["start_ms"], end_ms=later["end_ms"])), import_words,
    )
    assert result["snapped"] == 0
    assert result["accepted"][0]["start_ms"] == word["start_ms"]


def test_import_refuses_a_time_too_far_from_any_word(import_words):
    """Beyond the tolerance the caller meant a different place, and moving
    it would silently shift the clip."""
    # A six-second hole after the fifth word; 4000 ms sits inside it, far
    # from any word's start. (On an unbroken grid every instant is within
    # 200 ms of a word, so there would be nothing to refuse.)
    holed = {0: words("alpha beta gamma delta epsilon. zeta eta theta iota kappa.",
                      gaps={5: 6_000})}
    assert holed[0][4]["end_ms"] < 4_000 < holed[0][5]["start_ms"]
    result = sd.validate_import(
        _payload(_item(start_ms=4_000, end_ms=holed[0][-1]["end_ms"])), holed,
    )
    assert result["accepted"] == []
    assert len(result["refused"]) == 1
    reason = result["refused"][0]["reason"]
    assert "not within 500 ms" in reason and "nearest" in reason


@pytest.mark.parametrize("over,expected", [
    ({"start_ms": 5_000, "end_ms": 5_000}, "must be before"),
    ({"start_ms": 9_000, "end_ms": 4_000}, "must be before"),
    ({"start_ms": -50_000}, "outside the transcript"),
    ({"end_ms": 9_999_000}, "outside the transcript"),
    ({"start_ms": 1.5}, "whole number"),
    ({"start_ms": "0"}, "whole number"),
    ({"title": ""}, "title must be a non-empty string"),
    ({"title": None}, "title must be a non-empty string"),
    ({"topics": "camera"}, "topics must be a list"),
    ({"topics": ["a"] * 9}, "at most 8 topics"),
    ({"topics": [1, 2]}, "every topic must be a string"),
    ({"quality_score": 1.5}, "between 0 and 1"),
    ({"quality_score": -0.1}, "between 0 and 1"),
    ({"quality_score": "high"}, "must be a number"),
    ({"viral_score": 2}, "between 0 and 1"),
    ({"speaker": 5}, "speaker must be a name"),
])
def test_import_refuses_each_invalid_field_with_a_reason_naming_it(
    import_words, over, expected,
):
    item = _item(end_ms=import_words[0][-1]["end_ms"])
    item.update(over)
    result = sd.validate_import(_payload(item), import_words)
    assert result["accepted"] == []
    assert len(result["refused"]) == 1
    assert expected in result["refused"][0]["reason"], result["refused"][0]["reason"]
    assert result["refused"][0]["index"] == 0


def test_one_refused_item_does_not_stop_the_others(import_words):
    end = import_words[0][-1]["end_ms"]
    result = sd.validate_import(
        _payload(
            _item(end_ms=end, title="good one"),
            _item(end_ms=end, topics=["x"] * 20, title="bad topics"),
            _item(end_ms=end, title="good two"),
        ),
        import_words,
    )
    assert [row["title"] for row in result["accepted"]] == ["good one", "good two"]
    assert [r["index"] for r in result["refused"]] == [1]


def test_import_fills_a_missing_quote_from_the_transcript(import_words):
    word, later = import_words[0][0], import_words[0][9]
    for missing in (None, "", "   "):
        item = _item(start_ms=word["start_ms"], end_ms=later["end_ms"], quote=missing)
        quote = sd.validate_import(_payload(item), import_words)["accepted"][0]["quote"]
        assert quote.startswith("We shot the whole interview")
        assert len(quote) <= sd.QUOTE_MAX_CHARS


def test_a_filled_quote_comes_from_one_speaker_not_every_track_interleaved():
    """Regression: two tracks merged by timestamp produced word salad
    ("Soft weich. light Weiches on Licht"), which is not a quote anybody
    said. One track is one speaker, so a quote is one track."""
    two = {0: words(EN), 1: words(DE)}
    item = _item(start_ms=0, end_ms=words(EN)[12]["end_ms"], quote=None)
    quote = sd.validate_import(_payload(item), two)["accepted"][0]["quote"]

    english = set(sd.tokenize(EN))
    german = set(sd.tokenize(DE))
    spoken = set(sd.tokenize(quote))
    # Whichever speaker was quoted, the other one's words are absent.
    only_german = (german - english)
    only_english = (english - german)
    assert spoken & only_english == set() or spoken & only_german == set(), quote
    assert quote.startswith("We shot the whole") or quote.startswith("Wir haben das"), quote


def test_the_dominant_track_of_a_span_is_the_one_that_speaks_most():
    busy = {0: words("one two three four five six seven eight."),
            1: words("quiet.")}
    assert sd.dominant_track(busy, 0, 99_999) == 0
    # Nobody inside the span at all.
    assert sd.dominant_track(busy, 500_000, 600_000) is None


def test_import_keeps_a_supplied_quote_and_caps_its_length(import_words):
    end = import_words[0][-1]["end_ms"]
    result = sd.validate_import(_payload(_item(end_ms=end, quote="x " * 400)), import_words)
    assert len(result["accepted"][0]["quote"]) <= sd.QUOTE_MAX_CHARS


def test_import_accepts_scores_at_the_edges_and_none(import_words):
    end = import_words[0][-1]["end_ms"]
    result = sd.validate_import(
        _payload(
            _item(end_ms=end, quality_score=0, viral_score=1),
            _item(end_ms=end, quality_score=None, viral_score=None),
        ),
        import_words,
    )
    assert result["refused"] == []
    assert result["accepted"][0]["quality_score"] == 0.0
    assert result["accepted"][0]["viral_score"] == 1.0
    assert result["accepted"][1]["quality_score"] is None


def test_import_refuses_a_boolean_score_rather_than_taking_it_as_one():
    """True is an int in Python; a score of True is a mistake, not 1.0."""
    result = sd.validate_import(
        _payload(_item(end_ms=15_000, quality_score=True)), {0: words(EN)},
    )
    assert "must be a number" in result["refused"][0]["reason"]


def test_snap_prefers_the_earlier_candidate_on_a_tie():
    assert sd.snap(150, [100, 200], tolerance_ms=500) == 100


# ═══════════════════════════════════════════════════════════════════════════
# The database half: the detect stage, the replace rules, the scripts.
#
# The SQLite harness from test_snippet_pipeline.py -- UUID as CHAR(36),
# JSONB as TEXT, foreign keys on, every table from `create_all`. There is
# no ffmpeg skip marker on this file: detection reads rows these tests
# write, so no model and no binary is involved.
# ═══════════════════════════════════════════════════════════════════════════


@pytest.fixture
def engine(tmp_path):
    from sqlalchemy import create_engine, event
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles

    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401  -- registers every table

    eng = create_engine(f"sqlite:///{tmp_path / 'detect.db'}")

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def Session(engine):
    from sqlalchemy.orm import sessionmaker
    return sessionmaker(bind=engine)


class World:
    """The ids of everything a test needs, read while the session is open.

    Captured as plain values on purpose: a commit expires the instances and
    a close detaches them, so reading `asset.id` afterwards raises
    DetachedInstanceError.
    """

    def __init__(self, **kw):
        self.__dict__.update(kw)


def _make_world(Session, *, text=EN, tracks=1, deleted=False, language="en"):
    """A project, an asset, a version, a media file and a transcript.

    The transcript is written directly: one segment per sentence with its
    words, which is the shape the `store` stage leaves behind.
    """
    from datetime import datetime, timezone

    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType,
        ProcessingStatus, TranscriptionStatus,
    )
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.snippet import (
        SegmentStatus, SnippetProjectSettings, SnippetSpeaker, TranscriptSegment,
        TranscriptWord,
    )

    db = Session()
    project = Project(id=uuid.uuid4(), name="Agency", project_type=ProjectType.personal,
                      transcription_default=True)
    db.add(project)
    db.flush()  # no declared relationship, so the order is ours to set
    db.add(SnippetProjectSettings(project_id=project.id, enabled=True))

    asset = Asset(id=uuid.uuid4(), project_id=project.id, name="Interview",
                  asset_type=AssetType.video, transcription_enabled=True,
                  deleted_at=datetime.now(timezone.utc) if deleted else None)
    db.add(asset)
    db.flush()
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.ready)
    db.add(version)
    db.flush()
    media_file = MediaFile(
        id=uuid.uuid4(), version_id=version.id, file_type=FileType.video,
        original_filename="interview.mp4", mime_type="video/mp4",
        file_size_bytes=1024, duration_seconds=60.0, s3_key_raw="raw/interview.mp4",
        transcription_status=TranscriptionStatus.ready, transcript_language=language,
    )
    db.add(media_file)
    db.flush()

    speaker_ids = {}
    for track in range(tracks):
        name = ["Anna Example", "Bruno Beispiel"][track]
        speaker = SnippetSpeaker(id=uuid.uuid4(), project_id=project.id, name=name)
        db.add(speaker)
        db.flush()
        speaker_ids[track] = speaker.id

        source_text = text if track == 0 else DE
        all_words = words(source_text)
        # One segment per sentence, so the stored shape matches `store`.
        seq = 0
        for sentence in sd.build_sentences(all_words):
            segment = TranscriptSegment(
                id=uuid.uuid4(), media_file_id=media_file.id, track_index=track,
                speaker_id=speaker.id, seq=seq,
                start_ms=sentence["start_ms"], end_ms=sentence["end_ms"],
                language=language, text_ai=sentence["text"],
                text_current=sentence["text"], status=SegmentStatus.ai,
            )
            db.add(segment)
            db.flush()
            for idx, word in enumerate(sentence["words"]):
                # (segment_id, idx) is the primary key -- no id column.
                db.add(TranscriptWord(
                    segment_id=segment.id, idx=idx,
                    start_ms=word["start_ms"], end_ms=word["end_ms"],
                    word=word["word"], probability=0.9,
                ))
            seq += 1

    db.commit()
    segment_count = (
        db.query(TranscriptSegment)
        .filter(TranscriptSegment.media_file_id == media_file.id)
        .count()
    )
    world = World(
        Session=Session, project_id=project.id, asset_id=asset.id,
        version_id=version.id, media_file_id=media_file.id,
        speaker_ids=speaker_ids, segment_count=segment_count,
    )
    db.close()
    return world


def _snippets(w):
    """Every snippet row of the world's media file, as plain tuples."""
    from apps.api.models.snippet import Snippet
    db = w.Session()
    try:
        return [
            (s.source, s.status.value, s.start_ms, s.end_ms, s.title, s.generator,
             list(s.topics or []), s.quality_score, s.viral_score)
            for s in db.query(Snippet)
            .filter(Snippet.media_file_id == w.media_file_id)
            .order_by(Snippet.source, Snippet.start_ms)
        ]
    finally:
        db.close()


def _jobs(w):
    from apps.api.models.snippet import SnippetJob
    db = w.Session()
    try:
        return {j.stage: (j.status.value, j.error)
                for j in db.query(SnippetJob)
                .filter(SnippetJob.media_file_id == w.media_file_id)}
    finally:
        db.close()


# ── (f) the detect stage writes rows ─────────────────────────────────────


def test_the_detect_stage_stores_suggestions_and_records_its_job(Session):
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    result = _stage_detect(db, w.media_file_id)
    db.close()

    assert result is not None and result["created"] > 0
    assert _jobs(w)["detect"] == ("done", None)
    rows = _snippets(w)
    assert rows
    for source, status, start, end, title, generator, topics, quality, viral in rows:
        assert (source, status, generator) == ("keyword", "suggested", "tfidf-v1")
        assert start < end
        assert title
        assert quality is None and viral is None


def test_the_detect_stage_attaches_the_tracks_speaker(Session):
    from apps.api.models.snippet import Snippet
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session, tracks=2)
    db = w.Session()
    _stage_detect(db, w.media_file_id)
    found = {s.speaker_id for s in db.query(Snippet)
             .filter(Snippet.media_file_id == w.media_file_id)}
    db.close()
    assert found
    assert found <= set(w.speaker_ids.values())
    assert None not in found


def test_a_rerun_replaces_its_own_rows_and_is_idempotent(Session):
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    first = _stage_detect(db, w.media_file_id)
    after_first = _snippets(w)
    second = _stage_detect(db, w.media_file_id)
    db.close()

    assert first["removed"] == 0
    assert second["removed"] == first["created"]
    assert second["created"] == first["created"]
    # Same rows, not doubled: a re-run converges.
    assert _snippets(w) == after_first


def test_a_rerun_never_touches_import_manual_approved_or_rejected_rows(Session):
    """The four exclusions, in one test, because what matters is that a
    re-run replaces ONLY its own untouched suggestions."""
    from apps.api.models.snippet import Snippet, SnippetStatus
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    protected = [
        ("import", SnippetStatus.suggested, 1_000, "from a model run by hand"),
        ("manual", SnippetStatus.suggested, 2_000, "typed by a producer"),
        ("keyword", SnippetStatus.approved, 3_000, "a generated clip somebody approved"),
        ("keyword", SnippetStatus.rejected, 4_000, "a generated clip somebody turned down"),
    ]
    for source, status, start, title in protected:
        db.add(Snippet(
            id=uuid.uuid4(), media_file_id=w.media_file_id, start_ms=start,
            end_ms=start + 9_000, title=title, quote="q", topics=["kept"],
            status=status, source=source, generator="hand",
        ))
    db.commit()

    _stage_detect(db, w.media_file_id)
    _stage_detect(db, w.media_file_id)
    db.close()

    survivors = {
        (s[0], s[1], s[4]) for s in _snippets(w)
        if s[5] == "hand"
    }
    assert survivors == {
        ("import", "suggested", "from a model run by hand"),
        ("manual", "suggested", "typed by a producer"),
        ("keyword", "approved", "a generated clip somebody approved"),
        ("keyword", "rejected", "a generated clip somebody turned down"),
    }


def test_a_rerun_keeps_a_clip_a_person_edited_and_makes_no_twin_of_it(Session):
    """An edited suggestion (user_edited_at set, still `suggested`, still
    `keyword`) is kept exactly like an approved one, and the window it was
    cut from is not suggested again beside it."""
    from datetime import datetime, timezone

    from apps.api.models.snippet import Snippet
    from apps.api.services.snippet_detect import MAX_OVERLAP_RATIO
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    first = _stage_detect(db, w.media_file_id)
    assert first["created"] > 0
    target = (db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id)
              .order_by(Snippet.start_ms).first())
    target.start_ms += 500
    target.title = "Trimmed by a person"
    target.user_edited_at = datetime.now(timezone.utc)
    db.commit()
    edited_id, span = target.id, (target.start_ms, target.end_ms)

    second = _stage_detect(db, w.media_file_id)
    third = _stage_detect(db, w.media_file_id)
    rows = db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id).all()
    db.close()

    assert second["removed"] == first["created"] - 1, "everything but the edited clip is replaced"
    assert second["skipped"] >= 1, "the window it came from is not suggested again"
    assert third["removed"] == second["created"]
    kept = next(r for r in rows if r.id == edited_id)
    assert (kept.title, kept.start_ms, kept.end_ms) == ("Trimmed by a person", *span)
    for r in rows:
        if r.id == edited_id:
            continue
        overlap = min(r.end_ms, span[1]) - max(r.start_ms, span[0])
        shortest = min(r.end_ms - r.start_ms, span[1] - span[0])
        assert overlap <= 0 or overlap / shortest <= MAX_OVERLAP_RATIO


def test_a_rejected_clip_is_not_suggested_again(Session):
    from apps.api.models.snippet import Snippet, SnippetStatus
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    first = _stage_detect(db, w.media_file_id)
    for s in db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id):
        s.status = SnippetStatus.rejected
    db.commit()
    again = _stage_detect(db, w.media_file_id)
    db.close()
    # The detector is deterministic: every window it finds is a rejected one.
    assert (again["created"], again["removed"], again["skipped"]) == (0, 0, first["created"])


def test_drop_overlapping_uses_the_selection_limit():
    from apps.api.services.snippet_detect import MAX_OVERLAP_RATIO, drop_overlapping

    kept = [{"start_ms": 10_000, "end_ms": 20_000}]
    rows = [
        {"start_ms": 0, "end_ms": 9_000},          # no overlap
        {"start_ms": 17_000, "end_ms": 27_000},    # 3 s of 10 s = 0.30: allowed
        {"start_ms": 16_900, "end_ms": 26_900},    # 3.1 s: dropped
        {"start_ms": 12_000, "end_ms": 15_000},    # wholly inside: dropped
    ]
    assert MAX_OVERLAP_RATIO == 0.30
    out, dropped = drop_overlapping(rows, kept)
    assert out == rows[:2] and dropped == 2
    assert drop_overlapping(rows, []) == (rows, 0)


def test_the_dry_run_counts_by_the_same_rule(Session):
    from datetime import datetime, timezone

    from apps.api.models.snippet import Snippet
    from apps.api.scripts.snippet_detect import preview
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    first = _stage_detect(db, w.media_file_id)
    edited = (db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id)
              .order_by(Snippet.start_ms).first())
    edited.user_edited_at = datetime.now(timezone.utc)
    db.commit()
    would = preview(db, w.media_file_id)
    real = _stage_detect(db, w.media_file_id)
    db.close()
    assert (would["removed"], would["created"], would["skipped"]) == \
        (real["removed"], real["created"], real["skipped"])
    assert would["removed"] == first["created"] - 1 and would["kept"] == 1


def test_a_soft_deleted_asset_detects_nothing(Session):
    """Excluded by the existing helper (`TranscriptSegment.live`), not by a
    second copy of the rule here."""
    from apps.api.tasks.transcribe_tasks import _stage_detect, snippet_words_by_track

    w = _make_world(Session, deleted=True)
    db = w.Session()
    assert snippet_words_by_track(db, w.media_file_id) == {}
    result = _stage_detect(db, w.media_file_id)
    db.close()
    assert result == {"created": 0, "removed": 0, "skipped": 0, "tracks": []}
    assert _snippets(w) == []


# ── (g) a detect failure must not fail the transcription ─────────────────


def test_a_failing_detect_records_the_error_and_returns_none(Session, monkeypatch):
    from apps.api.tasks import transcribe_tasks

    w = _make_world(Session)

    def boom(*_a, **_kw):
        raise RuntimeError("the suggester fell over")

    monkeypatch.setattr(transcribe_tasks, "detect_snippets", boom)
    db = w.Session()
    result = transcribe_tasks._stage_detect(db, w.media_file_id)
    db.close()

    assert result is None, "a failure returns None rather than raising"
    status, error = _jobs(w)["detect"]
    assert status == "failed"
    assert "the suggester fell over" in error
    assert "RuntimeError" in error
    assert _snippets(w) == []


def test_a_failing_detect_leaves_the_stored_transcript_alone(Session, monkeypatch):
    """The point of swallowing the error: the transcript is already stored
    and useful, so a broken suggester must not undo it."""
    from apps.api.models.snippet import TranscriptSegment
    from apps.api.tasks import transcribe_tasks

    w = _make_world(Session)
    monkeypatch.setattr(transcribe_tasks, "detect_snippets",
                        lambda *_a, **_kw: (_ for _ in ()).throw(ValueError("nope")))
    db = w.Session()
    transcribe_tasks._stage_detect(db, w.media_file_id)
    remaining = (
        db.query(TranscriptSegment)
        .filter(TranscriptSegment.media_file_id == w.media_file_id)
        .count()
    )
    db.close()
    assert remaining == w.segment_count


def test_a_detect_failure_does_not_discard_rows_that_were_already_there(
    Session, monkeypatch,
):
    """The delete and the insert are one transaction: a failure in between
    must not leave the file with no suggestions at all."""
    from apps.api.tasks import transcribe_tasks

    w = _make_world(Session)
    db = w.Session()
    transcribe_tasks._stage_detect(db, w.media_file_id)
    before = _snippets(w)
    assert before

    monkeypatch.setattr(transcribe_tasks, "detect_snippets",
                        lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("late")))
    assert transcribe_tasks._stage_detect(db, w.media_file_id) is None
    db.close()
    assert _snippets(w) == before


# ── (h) the detect script ────────────────────────────────────────────────


@pytest.fixture
def run_script(monkeypatch):
    """Point a script's SessionLocal at the test database."""
    def _bind(module, Session):
        monkeypatch.setattr(module, "SessionLocal", Session)
    return _bind


def test_the_detect_script_skips_a_file_with_no_transcript(Session, run_script, capsys):
    from apps.api.scripts import snippet_detect as script

    w = _make_world(Session)
    db = w.Session()
    # Drop the transcript, keeping the asset and its media file.
    from apps.api.models.snippet import TranscriptSegment, TranscriptWord
    ids = [s.id for s in db.query(TranscriptSegment)
           .filter(TranscriptSegment.media_file_id == w.media_file_id)]
    db.query(TranscriptWord).filter(TranscriptWord.segment_id.in_(ids)).delete(
        synchronize_session=False)
    db.query(TranscriptSegment).filter(TranscriptSegment.id.in_(ids)).delete(
        synchronize_session=False)
    db.commit()
    db.close()

    run_script(script, Session)
    assert script.main(["--project-id", str(w.project_id)]) == 0
    out = capsys.readouterr().out
    assert "no transcript segments yet" in out
    assert _snippets(w) == []


def test_the_detect_script_dry_run_changes_nothing(Session, run_script, capsys):
    from apps.api.scripts import snippet_detect as script

    w = _make_world(Session)
    run_script(script, Session)
    assert script.main(["--project-id", str(w.project_id), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "would" in out and "Nothing written." in out
    assert _snippets(w) == [], "a dry run writes no rows"


def test_the_detect_script_writes_the_same_rows_the_stage_would(Session, run_script, capsys):
    from apps.api.scripts import snippet_detect as script
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    run_script(script, Session)
    assert script.main(["--asset-id", str(w.asset_id)]) == 0
    from_script = _snippets(w)
    assert from_script

    db = w.Session()
    _stage_detect(db, w.media_file_id)
    db.close()
    assert _snippets(w) == from_script, "script and pipeline run the same detection"
    assert "suggestion(s)" in capsys.readouterr().out


def test_the_detect_script_leaves_a_soft_deleted_asset_out(Session, run_script, capsys):
    from apps.api.scripts import snippet_detect as script

    w = _make_world(Session, deleted=True)
    run_script(script, Session)
    assert script.main(["--project-id", str(w.project_id)]) == 0
    assert "No live assets found." in capsys.readouterr().out
    assert _snippets(w) == []


# ── (i) the export script ────────────────────────────────────────────────


def test_the_json_export_has_the_documented_shape(Session):
    from apps.api.scripts.snippet_export import build_json, load_transcript

    w = _make_world(Session, tracks=2)
    db = w.Session()
    transcript = load_transcript(db, w.media_file_id)
    db.close()

    assert set(transcript) == {"media_file_id", "asset_name", "language", "segments"}
    assert transcript["media_file_id"] == str(w.media_file_id)
    assert transcript["asset_name"] == "Interview"
    assert transcript["language"] == "en"
    assert transcript["segments"]
    for segment in transcript["segments"]:
        assert set(segment) == {"track", "speaker", "start_ms", "end_ms", "text_current"}
        assert segment["track"] in (0, 1)
        assert segment["speaker"] in ("Anna Example", "Bruno Beispiel")
        assert segment["start_ms"] < segment["end_ms"]
        assert segment["text_current"]
    # Valid JSON, and round-trips.
    assert json.loads(build_json(transcript)) == transcript


def test_the_markdown_export_reads_as_a_transcript(Session):
    from apps.api.scripts.snippet_export import build_markdown, load_transcript

    w = _make_world(Session)
    db = w.Session()
    text = build_markdown(load_transcript(db, w.media_file_id))
    db.close()

    assert text.startswith("# Interview")
    assert "- Language: en" in text
    assert "[00:00] **Anna Example:** We shot the whole interview" in text
    for line in text.splitlines():
        if line.startswith("["):
            assert "**" in line, line


def test_the_export_timestamp_floors_and_grows_past_an_hour():
    from apps.api.scripts.snippet_export import _timestamp

    assert _timestamp(0) == "[00:00]"
    assert _timestamp(1_999) == "[00:01]", "floored, not rounded to 00:02"
    assert _timestamp(61_000) == "[01:01]"
    assert _timestamp(3_601_000) == "[1:00:01]"


def test_exporting_a_soft_deleted_asset_refuses_rather_than_printing_nothing(Session):
    from apps.api.scripts.snippet_export import load_transcript
    from apps.api.scripts.snippet_set_track_speaker import ScriptError

    w = _make_world(Session, deleted=True)
    db = w.Session()
    with pytest.raises(ScriptError, match="in the trash"):
        load_transcript(db, w.media_file_id)
    db.close()


def test_the_export_script_writes_a_file_when_asked(Session, run_script, tmp_path):
    from apps.api.scripts import snippet_export as script

    w = _make_world(Session)
    out = tmp_path / "transcript.md"
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id),
                        "--format", "md", "--out", str(out)]) == 0
    assert out.read_text(encoding="utf-8").startswith("# Interview")


# ── (j) the import script ────────────────────────────────────────────────


def _write_payload(tmp_path, items, generator="claude"):
    path = tmp_path / "clips.json"
    path.write_text(json.dumps({"meta": {"generator": generator}, "snippets": items}),
                    encoding="utf-8")
    return str(path)


def _transcript_words(w):
    from apps.api.tasks.transcribe_tasks import snippet_words_by_track
    db = w.Session()
    try:
        return {t: d["words"] for t, d in snippet_words_by_track(db, w.media_file_id).items()}
    finally:
        db.close()


def test_the_import_script_stores_rows_as_import_with_the_meta_generator(
    Session, run_script, tmp_path, capsys,
):
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    path = _write_payload(tmp_path, [{
        "start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
        "title": "Why the light matters", "topics": ["light", "interview"],
        "quality_score": 0.8, "viral_score": 0.4, "speaker": "anna example",
    }], generator="gpt")

    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 0

    rows = _snippets(w)
    assert len(rows) == 1
    source, status, start, end, title, generator, topics, quality, viral = rows[0]
    assert (source, status, generator) == ("import", "suggested", "gpt")
    assert title == "Why the light matters"
    assert topics == ["light", "interview"]
    assert (quality, viral) == (0.8, 0.4)
    assert "Imported 1" in capsys.readouterr().out


def test_the_import_script_matches_a_speaker_case_insensitively(
    Session, run_script, tmp_path,
):
    from apps.api.models.snippet import Snippet
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    path = _write_payload(tmp_path, [{
        "start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
        "title": "A clip", "topics": [], "speaker": "ANNA EXAMPLE",
    }])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 0

    db = w.Session()
    stored = db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id).one()
    assert stored.speaker_id == w.speaker_ids[0]
    db.close()


def test_an_unknown_speaker_is_stored_unnamed_and_reported(
    Session, run_script, tmp_path, capsys,
):
    """Creating a speaker from an imported string would fill the roster
    with a model's spelling mistakes."""
    from apps.api.models.snippet import Snippet, SnippetSpeaker
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    path = _write_payload(tmp_path, [{
        "start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
        "title": "A clip", "topics": [], "speaker": "Nobody Here",
    }])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 0
    assert "not in the roster" in capsys.readouterr().out

    db = w.Session()
    stored = db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id).one()
    assert stored.speaker_id is None
    assert db.query(SnippetSpeaker).filter(
        SnippetSpeaker.project_id == w.project_id).count() == 1
    db.close()


def test_the_import_script_dry_run_writes_nothing(Session, run_script, tmp_path, capsys):
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    path = _write_payload(tmp_path, [{
        "start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
        "title": "A clip", "topics": [],
    }])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id),
                        "--file", path, "--dry-run"]) == 0
    assert "Nothing written." in capsys.readouterr().out
    assert _snippets(w) == []


def test_the_import_script_reports_refusals_and_exits_nonzero(
    Session, run_script, tmp_path, capsys,
):
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    path = _write_payload(tmp_path, [
        {"start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
         "title": "the good one", "topics": []},
        {"start_ms": 500_000, "end_ms": 900_000, "title": "out of range", "topics": []},
    ])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 1

    captured = capsys.readouterr()
    assert "refused item 1" in captured.err
    assert "outside the transcript" in captured.err
    # The good one was still imported.
    assert [row[4] for row in _snippets(w)] == ["the good one"]


def test_the_import_script_never_overwrites_a_manual_row(Session, run_script, tmp_path):
    from apps.api.models.snippet import Snippet, SnippetStatus
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    track = _transcript_words(w)[0]
    db = w.Session()
    db.add(Snippet(
        id=uuid.uuid4(), media_file_id=w.media_file_id,
        start_ms=track[0]["start_ms"], end_ms=track[12]["end_ms"],
        title="typed by a producer", quote="hands off", topics=["kept"],
        status=SnippetStatus.suggested, source="manual", generator="hand",
    ))
    db.commit()
    db.close()

    # Deliberately the SAME span as the manual row.
    path = _write_payload(tmp_path, [{
        "start_ms": track[0]["start_ms"], "end_ms": track[12]["end_ms"],
        "title": "an import over the top", "topics": [],
    }])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 0

    rows = {(row[0], row[4]) for row in _snippets(w)}
    assert ("manual", "typed by a producer") in rows
    assert ("import", "an import over the top") in rows


def test_the_import_script_refuses_a_file_that_is_not_json(
    Session, run_script, tmp_path, capsys,
):
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session)
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", str(bad)]) == 2
    assert "not valid JSON" in capsys.readouterr().err
    assert _snippets(w) == []


def test_the_import_script_refuses_a_soft_deleted_asset(
    Session, run_script, tmp_path, capsys,
):
    from apps.api.scripts import snippet_import as script

    w = _make_world(Session, deleted=True)
    path = _write_payload(tmp_path, [])
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", path]) == 2
    assert "in the trash" in capsys.readouterr().err
