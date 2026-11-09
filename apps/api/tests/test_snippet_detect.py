"""Clip detection, import and export.

Two halves, as elsewhere in SocialSnippet's tests:

* Pure logic, no database -- detection "keyword-v2": the hard rules (one
  complete thought inside one speaker's turn), every boost and penalty of
  the score, the minimum, non-overlap, the per-file cap and spacing, the
  topics and the profanity-free titles; then every import check. These
  are plain functions over plain dicts (services/snippet_detect.py), so
  they are tested as such, on the realistic English and German interviews
  in tests/snippet_transcripts.py -- one of them opening with the retakes
  "tfidf-v1" turned into clips.

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
from apps.api.services import snippet_detect_v1 as v1

from . import snippet_transcripts as T


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


# ── Realistic transcripts (tests/snippet_transcripts.py) ─────────────────
#
# A two-microphone interview in English and in German, timed like Whisper
# output. The English one opens with the retakes and chatter "tfidf-v1"
# turned into clips on a real 57-minute interview.


def _tracks(turns):
    return T.conversation(turns)[0]


def _windows(turns, **kw):
    return sd.evaluate_windows(_tracks(turns), **kw)


def _starting(windows, text):
    """The best-scoring window whose text starts with `text`."""
    found = [w for w in windows if w["text"].startswith(text)]
    assert found, f"no window starts with {text!r}"
    return max(found, key=lambda w: (w["score"], -w["start_ms"]))


RETAKE_WORDS = ("go again", "take two", "rolling", "sorry", "is it recording",
                "check, check", "nochmal", "von vorne", "läuft die kamera")


# ── (a) sentences and the length and gap rules ───────────────────────────


def test_sentences_split_on_terminal_punctuation_only():
    sentences = sd.build_sentences(words(EN))
    assert len(sentences) == 4
    assert sentences[0]["text"].endswith("camera today.")
    assert sentences[1]["text"].startswith("The camera moves")
    for sentence in sentences:
        assert sentence["start_ms"] == sentence["words"][0]["start_ms"]
        assert sentence["end_ms"] == sentence["words"][-1]["end_ms"]


def test_a_trailing_run_without_punctuation_is_still_a_sentence():
    """Whisper regularly leaves the last sentence unfinished; it stays a
    sentence (search and quotes need it), it just never ends a clip."""
    sentences = sd.build_sentences(words("One done. and then this trails off"))
    assert len(sentences) == 2
    assert sentences[1]["text"] == "and then this trails off"


def test_a_question_mark_and_a_closing_quote_both_end_a_sentence():
    sentences = sd.build_sentences(words('Is it ready? "Yes it is." And so we went'))
    assert [s["text"] for s in sentences][:2] == ['Is it ready?', '"Yes it is."']


def test_every_window_starts_at_a_sentence_start_and_ends_at_a_sentence_end():
    tracks = _tracks(T.EN_INTERVIEW)
    for window in sd.evaluate_windows(tracks):
        sentences = sd.build_sentences(tracks[window["track_index"]])
        assert window["start_ms"] in {s["start_ms"] for s in sentences}
        assert window["end_ms"] in {s["end_ms"] for s in sentences}


def test_every_window_is_15_to_45_seconds_with_enough_words():
    windows = _windows(T.EN_INTERVIEW) + _windows(T.DE_INTERVIEW)
    assert windows
    for window in windows:
        assert sd.MIN_DURATION_MS <= window["duration_ms"] <= sd.MAX_DURATION_MS
        assert window["word_count"] >= sd.MIN_WORDS
    assert (sd.MIN_DURATION_MS, sd.MAX_DURATION_MS) == (15_000, 45_000)
    assert (sd.IDEAL_MIN_MS, sd.IDEAL_MAX_MS) == (20_000, 35_000)


def test_a_window_shorter_than_the_minimum_is_not_offered():
    """Four words at 400 ms is 1.6 s: far too short, and far too few words."""
    assert sd.evaluate_windows({0: words("Short and sweet done.")}) == []


def test_a_window_with_too_few_words_is_rejected_even_when_long_enough():
    """Twenty words spread over twenty-six seconds passes the duration rule
    and still is not a clip -- MIN_WORDS is what rejects it."""
    sparse = words(" ".join(["Word"] * 19) + " end.", word_ms=200, gap_ms=1_150)
    assert sparse[-1]["end_ms"] - sparse[0]["start_ms"] > sd.MIN_DURATION_MS
    assert len(sparse) < sd.MIN_WORDS
    assert sd.evaluate_windows({0: sparse}) == []


def test_an_internal_silence_over_the_limit_splits_the_candidates():
    """A 3 s hole is a cut, not a breath: no window may span it."""
    tracks = _tracks([(T.GUEST, T.EN_STORY), (T.GUEST, T.EN_OPINION)])
    split = len(T.EN_STORY.split())
    first_end = tracks[0][split - 1]["end_ms"]
    for word in tracks[0][split:]:
        word["start_ms"] += 3_000
        word["end_ms"] += 3_000
    windows = sd.evaluate_windows(tracks)
    assert windows
    for window in windows:
        assert window["end_ms"] <= first_end or window["start_ms"] > first_end + 3_000


def test_the_length_rules_are_arguments_not_hard_coded():
    tight = sd.evaluate_windows(_tracks(T.EN_MONOLOGUE), min_duration_ms=5_000,
                                max_duration_ms=12_000, min_words=10)
    assert tight
    for window in tight:
        assert 5_000 <= window["duration_ms"] <= 12_000


def test_windows_never_span_two_tracks():
    """One track is one speaker: a clip across two mics is two people
    talking over each other."""
    tracks = _tracks(T.EN_INTERVIEW)
    for window in sd.evaluate_windows(tracks):
        own = tracks[window["track_index"]]
        inside = [w for w in own if window["start_ms"] <= w["start_ms"] < window["end_ms"]]
        assert len(inside) == window["word_count"]


# ── (b) one complete thought: the hard rejections ────────────────────────


def test_a_window_may_not_start_mid_sentence():
    """"approx." ends a sentence by punctuation, so "three euros..." is a
    sentence start by construction -- and still the middle of a thought.
    A lower-case start gives it away."""
    text = ("The flour costs approx. three euros a kilo today, twice what it cost "
            "when my grandmother opened the shop. " + T.EN_STORY)
    windows = _windows([(T.GUEST, text)])
    mid = [w for w in windows if w["text"].startswith("three euros")]
    assert mid
    for window in mid:
        assert "!" + sd.REJECT_MID_SENTENCE_START in window["reasons"]
        assert window["rejected"]
    rows = sd.detect_snippets(T.media_file([(T.GUEST, text)]))
    assert rows and not any(row["quote"].startswith("three") for row in rows)


def test_a_window_may_not_end_mid_sentence_or_trailing_off():
    windows = _windows(T.EN_INTERVIEW)
    trailing = [w for w in windows if w["text"].endswith("we tried the new")]
    assert trailing
    for window in trailing:
        assert "!" + sd.REJECT_MID_SENTENCE_END in window["reasons"]
    assert not sd._ends_thought("and then we tried...")
    assert not sd._ends_thought("und dann haben wir…")
    assert not sd._ends_thought("and then we tried the new")
    assert sd._ends_thought("We tried it.")
    assert sd._ends_thought('"Did it work?"')


def test_a_lower_case_transcript_does_not_reject_everything():
    """A track with no capitals at all was transcribed without case; the
    mid-sentence check is skipped for it rather than rejecting all of it."""
    rows = sd.detect_snippets(T.media_file([(T.GUEST, T.EN_STORY.lower())]))
    assert len(rows) == 1


@pytest.mark.parametrize("opener", ["So", "And", "Yeah,", "Okay,", "Um,", "Also,", "Und", "Äh,"])
def test_a_window_may_not_start_with_a_filler_or_backchannel(opener):
    story = T.DE_STORY if opener in ("Also,", "Und", "Äh,") else T.EN_STORY
    windows = _windows([(T.GUEST, f"{opener} {story}")])
    first = [w for w in windows if w["sentence_span"][0] == 0]
    assert first
    for window in first:
        assert "!" + sd.REJECT_FILLER_START in window["reasons"]


def test_a_window_stays_inside_one_speakers_turn():
    """The host cutting in with a whole sentence ends the guest's turn: no
    window may run across it. A short "mhm" does not."""
    long_cut = [(T.GUEST, T.EN_STORY),
                (T.HOST, "Wait, sorry, which year did she open the first shop?", T.OVER),
                (T.GUEST, T.EN_OPINION)]
    tracks = _tracks(long_cut)
    cut_at = tracks[T.HOST][0]["start_ms"]
    guest_windows = [w for w in sd.evaluate_windows(tracks) if w["track_index"] == T.GUEST]
    assert any(w["start_ms"] <= cut_at < w["end_ms"] for w in guest_windows)
    for window in guest_windows:
        spans_cut = window["start_ms"] <= cut_at < window["end_ms"]
        assert spans_cut == ("!" + sd.REJECT_CROSSES_TURN in window["reasons"])

    short = [(T.GUEST, T.EN_STORY), (T.HOST, "Mhm.", T.OVER), (T.GUEST, T.EN_OPINION)]
    assert not any("!" + sd.REJECT_CROSSES_TURN in w["reasons"] for w in _windows(short))


# ── (c) the score: penalties ─────────────────────────────────────────────


def test_the_retake_chatter_of_the_failed_interview_is_never_a_clip():
    """Modelled on the 57-minute interview: v1 offered "okay, go again" and
    "fuck me, there's some people here ready" as clips titled like
    "Fuck · Go · Good". v2 scores that chatter at the bottom and offers
    none of it."""
    media_file = T.media_file(T.EN_INTERVIEW)
    old = v1.detect_snippets(media_file)
    assert any("go again" in row["quote"].lower() for row in old), "the failure, reproduced"
    assert any({"Go", "Good"} & set(row["title"].split(" · ")) for row in old)

    chatter = _starting(_windows(T.EN_INTERVIEW), "Fuck me")
    assert "-" + sd.REASON_RETAKE in chatter["reasons"]
    assert chatter["score"] < sd.MIN_QUALITY_SCORE and chatter["rejected"]

    new = sd.detect_snippets(media_file)
    assert new
    for row in new:
        quote = row["quote"].lower()
        assert not any(phrase in quote for phrase in RETAKE_WORDS), row["quote"]
        for word in ("Fuck", "Go", "Good", "Okay", "Yeah", "Moment"):
            assert word not in row["title"].split(" · ")


def test_german_retakes_are_never_a_clip():
    rows = sd.detect_snippets(T.media_file(T.DE_INTERVIEW))
    assert rows
    for row in rows:
        assert not any(phrase in row["quote"].lower() for phrase in RETAKE_WORDS)


def test_retake_phrases_are_counted_as_phrases():
    count = sd._count_phrases
    assert count("okay go again take two".split(), sd.RETAKE_PHRASES) == 2
    assert count("we're rolling".split(), sd.RETAKE_PHRASES) == 1, "longest match, once"
    assert count("läuft die kamera nochmal".split(), sd.RETAKE_PHRASES) == 2
    assert count("the haircut was good".split(), sd.RETAKE_PHRASES) == 0, "whole words only"


@pytest.mark.parametrize("turns, start", [
    (T.EN_INTERVIEW, "It's hard to say"),
    (T.DE_INTERVIEW, "Das ist halt"),
])
def test_a_filler_heavy_answer_sinks_below_the_bar(turns, start):
    window = _starting(_windows(turns), start)
    assert "-" + sd.REASON_FILLER in window["reasons"]
    assert "-" + sd.REASON_THIN in window["reasons"]
    assert window["rejected"] and window["score"] < sd.MIN_QUALITY_SCORE


def test_repeated_words_and_low_diversity_are_penalised():
    window = _starting(_windows(T.EN_INTERVIEW), "It's hard to say")
    assert "-" + sd.REASON_REPEATS in window["reasons"]
    assert "-" + sd.REASON_LOW_DIVERSITY in window["reasons"]


def test_a_run_of_unanswered_questions_is_penalised():
    window = _starting(_windows(T.EN_INTERVIEW), "What does a good croissant need")
    assert window["track_index"] == T.HOST
    assert "-" + sd.REASON_MOSTLY_QUESTIONS in window["reasons"]
    assert "-" + sd.REASON_ENDS_ON_QUESTION in window["reasons"]
    assert window["rejected"]


def test_fast_back_and_forth_is_penalised():
    """The host keeps cutting in: each interjection is short enough to
    stay inside the guest's turn, and together they sink the window."""
    window = _starting(_windows(T.EN_INTERVIEW), "Partly the dough")
    assert "-" + sd.REASON_RAPID_TURNS in window["reasons"]
    assert window["rejected"]


def test_a_contentless_last_sentence_is_a_weak_end():
    windows = _windows([(T.GUEST, T.EN_OPINION + " You know?")])
    tagged = [w for w in windows if w["text"].endswith("You know?")]
    assert tagged
    for window in tagged:
        assert "-" + sd.REASON_WEAK_END in window["reasons"]


def test_padding_a_thought_with_the_next_one_scores_lower():
    """Prefer the end of a thought over padding it: the story alone beats
    the story plus the start of the next answer."""
    windows = _windows(T.EN_MONOLOGUE)
    alone = [w for w in windows if w["text"].startswith("My grandmother")
             and w["text"].endswith("my hands remembered.")]
    padded = [w for w in windows if w["text"].startswith("My grandmother")
              and "biggest mistake" in w["text"]]
    assert alone and padded
    assert "-" + sd.REASON_THOUGHT_BREAK in padded[0]["reasons"]
    assert alone[0]["score"] > max(w["score"] for w in padded)


# ── (d) the score: boosts ────────────────────────────────────────────────


def test_a_first_person_story_with_specifics_scores_high():
    window = _starting(_windows(T.EN_INTERVIEW), "My grandmother opened")
    for code in (sd.REASON_FIRST_PERSON, sd.REASON_STORY, sd.REASON_OPINION,
                 sd.REASON_SPECIFICS, sd.REASON_EMOTION, sd.REASON_DENSITY,
                 sd.REASON_IDEAL_LENGTH, sd.REASON_CLEAN_END, sd.REASON_CLEAN_START):
        assert "+" + code in window["reasons"], code
    assert window["score"] >= 0.85


def test_a_german_story_scores_high_and_capitalised_nouns_are_not_names():
    """In German every noun is capitalised, so a capital letter alone is
    not a named thing there: without the year, the story has no
    specifics. In English, a capital mid-sentence is a name."""
    window = _starting(_windows(T.DE_INTERVIEW), "Mein Vater")
    for code in (sd.REASON_SPECIFICS, sd.REASON_FIRST_PERSON, sd.REASON_STORY):
        assert "+" + code in window["reasons"], code

    without_year = T.DE_STORY.replace("1987", "damals")
    window = _starting(_windows([(T.GUEST, without_year)]), "Mein Vater")
    assert "+" + sd.REASON_SPECIFICS not in window["reasons"]

    no_numbers = T.EN_STORY.replace("1962", "the sixties").replace("four hundred", "many")
    english = _starting(_windows([(T.GUEST, no_numbers)]), "My grandmother")
    assert "+" + sd.REASON_SPECIFICS in english["reasons"], "Vienna, Saturdays"


def test_strong_claims_are_boosted():
    for turns, start in ((T.DE_INTERVIEW, "Der größte Fehler"),
                         (T.EN_INTERVIEW, "The biggest mistake")):
        assert "+" + sd.REASON_OPINION in _starting(_windows(turns), start)["reasons"]


def test_an_answer_to_another_speakers_question_is_boosted_and_kept_alone():
    """The host asks, the guest answers: the clip is the answer only."""
    window = _starting(_windows(T.DE_INTERVIEW), "Mein Vater")
    assert "+" + sd.REASON_ANSWER in window["reasons"]
    assert window["track_index"] == T.GUEST
    assert "angefangen?" not in window["text"]
    alone = _starting(_windows([(T.GUEST, T.DE_STORY)]), "Mein Vater")
    assert "+" + sd.REASON_ANSWER not in alone["reasons"]
    assert window["score"] > alone["score"]


def test_every_score_is_between_0_and_1_and_reasons_use_known_codes():
    codes = {getattr(sd, name) for name in dir(sd)
             if name.startswith(("REASON_", "REJECT_"))}
    for window in _windows(T.EN_INTERVIEW) + _windows(T.DE_INTERVIEW):
        assert 0.0 <= window["score"] <= 1.0
        for reason in window["reasons"]:
            assert reason[0] in "+-!" and reason[1:] in codes, reason
        assert window["rejected"] == any(r.startswith("!") for r in window["reasons"])


# ── (e) ranking, the minimum, non-overlap and the per-file cap ───────────


def test_the_interview_yields_its_three_real_answers():
    rows = sd.detect_snippets(T.media_file(T.EN_INTERVIEW))
    assert [row["quote"].split(" ")[:3] for row in rows] == [
        ["My", "grandmother", "opened"],
        ["The", "biggest", "mistake"],
        ["The", "worst", "day"],
    ]
    for row in rows:
        assert row["quality_score"] >= sd.MIN_QUALITY_SCORE


def test_the_german_interview_yields_its_three_real_answers():
    rows = sd.detect_snippets(T.media_file(T.DE_INTERVIEW))
    assert [row["quote"].split(" ")[:2] for row in rows] == [
        ["Mein", "Vater"], ["Der", "größte"], ["Der", "Frost"],
    ]


def test_nothing_under_the_minimum_score_is_offered():
    assert sd.build_candidates(_tracks(T.EN_INTERVIEW), min_score=1.01) == []
    for clip in sd.build_candidates(_tracks(T.EN_INTERVIEW)):
        assert clip["score"] >= sd.MIN_QUALITY_SCORE


@pytest.mark.parametrize("minutes, cap", [
    (0, 3), (1, 3), (12, 3), (12.5, 4), (16, 4), (30, 8), (57, 15), (120, 30),
])
def test_the_per_file_cap_is_max_3_or_one_per_four_minutes(minutes, cap):
    assert sd.max_clips_for(int(minutes * 60_000)) == cap


def _long_turns():
    """About 58 minutes: both interviews, eleven times over."""
    return (T.EN_INTERVIEW + T.DE_INTERVIEW) * 11


def test_a_long_file_is_capped_and_its_clips_spaced():
    media_file = T.media_file(_long_turns())
    assert 55 <= media_file["duration_ms"] / 60_000 <= 60
    rows = sd.detect_snippets(media_file)
    assert len(rows) == sd.max_clips_for(media_file["duration_ms"]) == 15
    for a, b in zip(rows, rows[1:]):
        assert b["start_ms"] - a["start_ms"] >= sd.MIN_START_SPACING_MS
        assert a["end_ms"] <= b["start_ms"], "no two new clips overlap"


def test_the_cap_follows_the_files_duration_not_its_transcript():
    """A transcript covering a minute and a half of a 57-minute file gets
    the 57-minute cap -- and still no more clips than it has answers. A
    short duration caps a long transcript."""
    media_file = T.media_file(T.EN_MONOLOGUE, duration_ms=57 * 60_000)
    assert len(sd.detect_snippets(media_file)) == 3
    capped = sd.build_candidates(_tracks(_long_turns()), duration_ms=5 * 60_000)
    assert len(capped) == 3


def test_spacing_between_clip_starts_is_an_argument():
    tracks = _tracks(T.EN_MONOLOGUE)
    assert len(sd.build_candidates(tracks)) == 3
    # The three answers start at 0, 30.3 and 53.0 s. 25 s apart, 53.0 is too
    # close to 30.3, so the flood story is offered from its second sentence
    # (56.4 s) instead; 40 s apart only the best answer fits.
    wide = sd.build_candidates(tracks, min_start_spacing_ms=25_000)
    assert [round(c["start_ms"] / 1000, 1) for c in wide] == [0.0, 30.3, 56.4]
    for a, b in zip(wide, wide[1:]):
        assert b["start_ms"] - a["start_ms"] >= 25_000
    assert len(sd.build_candidates(tracks, min_start_spacing_ms=40_000)) == 1


def test_select_clips_prefers_the_higher_score_and_keeps_starts_apart():
    def w(start, end, score, track=0):
        return {"start_ms": start, "end_ms": end, "duration_ms": end - start,
                "score": score, "track_index": track, "rejected": False}
    windows = [w(0, 20_000, 0.7), w(10_000, 30_000, 0.9), w(40_000, 60_000, 0.7),
               w(70_000, 90_000, 0.8, track=1), w(75_000, 95_000, 0.95),
               {**w(100_000, 120_000, 0.99), "rejected": True}]
    kept = sd.select_clips(windows, max_clips=10)
    assert [(k["start_ms"], k["score"]) for k in kept] == [
        (10_000, 0.9), (40_000, 0.7), (75_000, 0.95),
    ]
    assert [k["start_ms"] for k in sd.select_clips(windows, max_clips=1)] == [75_000]


# ── (f) topics ───────────────────────────────────────────────────────────


def test_an_apostrophe_never_splits_a_word():
    """v1 tokenised "I've" as "ve", which then became a topic."""
    assert sd.tokenize("I've we've they'll don't") == ["i've", "we've", "they'll", "don't"]
    assert sd.tokenize("we 've done it") == ["we've", "done", "it"], "split suffix glued back"
    assert sd.tokenize("I’ve") == ["i've"], "typographic apostrophe"
    assert sd.tokenize("Anna's bakery gibt's") == ["anna", "bakery", "gibt's"]
    assert "ve" in v1.tokenize("I've"), "the v1 bug this replaces"
    for term in ("i've", "we've", "don't", "gibt's", "ve", "ll", "re"):
        assert term in sd.STOPWORDS
    for row in sd.detect_snippets(T.media_file(T.EN_INTERVIEW)):
        assert not {"ve", "ll", "re"} & {p for t in row["topics"] for p in t.split()}


def test_generic_words_contractions_and_fillers_are_stopwords():
    for word in ("go", "good", "okay", "yeah", "moment", "thing", "stuff", "really",
                 "um", "gonna", "it's", "that's", "everywhere", "eighteen",
                 "äh", "ähm", "genau", "sache", "ding", "zeug", "gibt's", "leute"):
        assert word in sd.STOPWORDS, word


def test_no_topic_on_the_retake_heavy_interview_is_noise():
    rows = sd.detect_snippets(T.media_file(T.EN_INTERVIEW))
    for row in rows:
        for term in row["topics"]:
            for token in term.split(" "):
                assert token not in sd.STOPWORDS and len(token) > 1, term
                assert not sd.is_profane(token), term
    assert rows[0]["topics"][:2] == ["saturdays", "vienna"], "names first, capitalised"


def test_topics_on_a_german_interview_are_nouns_not_glue():
    rows = sd.detect_snippets(T.media_file(T.DE_INTERVIEW))
    flat = {term for row in rows for term in row["topics"]}
    assert {"weinberg", "riesling", "wahrheit"} <= flat
    for glue in ("haben", "das", "mit", "und", "die", "sich", "ein", "unserer", "jemals"):
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


def test_a_bigram_wins_when_it_recurs_and_scores_close_to_its_own_words():
    """"social media" appearing wherever "media" does should beat the bare
    word, and must then remove it so the list is not "social media, media,
    social"."""
    text = "social media strategy for the brand. social media pays the bills here."
    topics = sd.extract_topics([{"text": text}], top_n=4)[0]
    assert "social media" in topics
    assert "media" not in topics
    assert "social" not in topics


def test_a_bigram_said_once_is_not_a_topic_and_never_jumps_a_word():
    """v1 made "believe bakery" out of "believe a bakery"."""
    text = "I honestly trust a bakery that sells sourdough. Customers noticed it."
    terms = sd._terms(text)
    assert "trust bakery" not in terms and "customers noticed" in terms
    topics = sd.extract_topics([{"text": text}], top_n=6)[0]
    assert not any(" " in term for term in topics), topics


def test_topics_are_deterministic_and_order_is_stable():
    windows = sd.build_candidates(_tracks(T.EN_INTERVIEW))
    first = sd.extract_topics(windows)
    for _ in range(5):
        assert sd.extract_topics(windows) == first


def test_a_corpus_can_widen_the_document_frequency():
    """detect_snippets passes every sentence of the file; a term common
    across the file then scores lower."""
    # Stopwords between the two content words on purpose: with no adjacent
    # pair there is no bigram to swallow them, so what is measured here is
    # the idf and nothing else.
    window = [{"text": "camera is the light of it"}]
    alone = sd.extract_topics(window, top_n=2)[0]
    with_corpus = sd.extract_topics(
        window, top_n=2, corpus=["camera everywhere", "camera again", "camera once more"],
    )[0]
    assert set(alone) == {"camera", "light"}
    assert with_corpus[0] == "light"


def test_a_window_of_nothing_but_stopwords_has_no_topics():
    assert sd.extract_topics([{"text": "and the of it is to"}]) == [[]]
    assert sd.extract_topics([{"text": "okay yeah go good moment, really"}]) == [[]]


# ── (g) titles and quotes: profanity ─────────────────────────────────────


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


def test_a_title_never_holds_a_swear_word_but_the_quote_keeps_it():
    assert sd.make_title(["fucking", "bakery", "flour"]) == "Bakery · Flour"
    assert sd.make_title(["bullshit detector", "bakery", "scheiße"], "Bakery talk.") == (
        "Bakery talk."
    ), "one clean topic left: the quote stands in"
    fallback = sd.make_title([], "Fuck me, there's some people here ready.")
    assert "fuck" not in fallback.lower() and fallback.startswith("me,")
    assert "scheiß" not in sd.make_title([], "Das war scheiße, ehrlich gesagt.").lower()

    for turns, swear in ((T.EN_INTERVIEW, "fucking"), (T.DE_INTERVIEW, "scheiße")):
        rows = sd.detect_snippets(T.media_file(turns))
        assert any(swear in row["quote"] for row in rows), "the quote is what was said"
        for row in rows:
            assert not any(sd.is_profane(w) for w in sd.raw_words(row["title"])), row["title"]
            assert not any(sd.is_profane(w) for t in row["topics"] for w in t.split()), row


def test_profanity_is_matched_by_word_and_by_stem():
    for word in ("fuck", "Fucking", "bullshit", "motherfucker", "shit", "damn",
                 "Scheiße", "scheißegal", "Arschloch", "verdammt"):
        assert sd.is_profane(word), word
    for word in ("class", "assume", "Schein", "pass", "Dickens", "Hagel"):
        assert not sd.is_profane(word), word


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


# ── (h) detect_snippets, end to end on plain data ────────────────────────


def test_detect_snippets_marks_every_row_keyword_v2_with_its_score():
    rows = sd.detect_snippets(T.media_file(T.EN_INTERVIEW))
    assert rows
    for row in rows:
        assert row["source"] == "keyword"
        assert row["generator"] == "keyword-v2"
        assert row["status"] == "suggested"
        assert 0.0 <= row["quality_score"] <= 1.0
        assert row["viral_score"] is None
        assert row["reasons"] and all(r[0] in "+-" for r in row["reasons"])
        assert row["media_file_id"] == "mf-1"
        assert row["speaker_id"] == "sp-guest"
        assert row["start_ms"] < row["end_ms"]
        assert len(row["quote"]) <= sd.QUOTE_MAX_CHARS
        assert len(row["title"]) <= sd.TITLE_MAX_CHARS


def test_detect_snippets_is_deterministic():
    media_file = T.media_file(T.EN_INTERVIEW + T.DE_INTERVIEW)
    first = sd.detect_snippets(media_file)
    for _ in range(5):
        assert sd.detect_snippets(media_file) == first


def test_detect_snippets_accepts_string_track_keys_as_json_gives_them():
    from_json = json.loads(json.dumps(T.media_file(T.EN_MONOLOGUE)))
    assert list(from_json["tracks"]) == ["0"]
    assert sd.detect_snippets(from_json) == sd.detect_snippets(T.media_file(T.EN_MONOLOGUE))


def test_a_file_with_no_words_detects_nothing():
    assert sd.detect_snippets({"media_file_id": "mf", "tracks": {}}) == []
    assert sd.detect_snippets({"media_file_id": "mf", "tracks": {0: {"words": []}}}) == []


def test_the_compare_report_shows_both_detectors_side_by_side():
    from apps.api.scripts import snippet_detect_compare as compare

    media_file = T.media_file(T.EN_INTERVIEW)
    result = compare.compare(media_file)
    report = compare.render("asset X  Interview", media_file, result)
    assert "OLD tfidf-v1" in report and "NEW keyword-v2" in report
    assert "Good · Go · Good Good" in report, "v1's retake clip, on the left"
    assert "Saturdays · Vienna" in report
    assert "why:    +first_person" in report
    assert "below_min_score" in report and "ends_mid_sentence" in report
    assert report.rstrip().endswith("Nothing written.")
    assert len(result["v2"]) == 3 and len(result["v1"]) > 3


# ── (i) import validation, on plain data ─────────────────────────────────


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


def _make_world(Session, *, turns=None, tracks=1, deleted=False, language="en"):
    """A project, an asset, a version, a media file and a transcript.

    The transcript is `turns` (tests/snippet_transcripts.py): by default the
    guest's three answers on one track, which detection turns into three
    clips; with tracks=2 the English interview, host on track 1. The media
    file's duration is where the transcript ends.

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

    if turns is None:
        turns = T.EN_INTERVIEW if tracks == 2 else T.EN_MONOLOGUE
    by_track, end_ms = T.conversation(turns)

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
        file_size_bytes=1024, duration_seconds=end_ms / 1000, s3_key_raw="raw/interview.mp4",
        transcription_status=TranscriptionStatus.ready, transcript_language=language,
    )
    db.add(media_file)
    db.flush()

    speaker_ids = {}
    for track in sorted(by_track):
        name = ["Anna Example", "Bruno Beispiel"][track]
        speaker = SnippetSpeaker(id=uuid.uuid4(), project_id=project.id, name=name)
        db.add(speaker)
        db.flush()
        speaker_ids[track] = speaker.id

        all_words = by_track[track]
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


# ── (j) the detect stage writes rows ─────────────────────────────────────


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
    assert len(rows) == 3, "one clip per answer"
    for source, status, start, end, title, generator, topics, quality, viral in rows:
        assert (source, status, generator) == ("keyword", "suggested", "keyword-v2")
        assert start < end
        assert title and topics
        # The 0..1 score is stored; nothing predicts reach, so viral stays NULL.
        assert sd.MIN_QUALITY_SCORE <= quality <= 1.0 and viral is None


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


# ── (k) a detect failure must not fail the transcription ─────────────────


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


# ── (l) the detect script ────────────────────────────────────────────────


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


def test_v2_replaces_untouched_v1_suggestions_and_never_a_protected_clip(Session):
    """Stored "tfidf-v1" suggestions are `keyword` + `suggested`, so a v2
    run replaces them; a v1 clip somebody approved, rejected or edited --
    and every imported or hand-made clip -- is left exactly as it was."""
    from datetime import datetime, timezone

    from apps.api.models.snippet import Snippet, SnippetStatus
    from apps.api.tasks.transcribe_tasks import _stage_detect

    w = _make_world(Session)
    db = w.Session()
    far = 200_000  # past the transcript, so none of them blocks a new clip
    rows = [
        ("keyword", SnippetStatus.suggested, None, "tfidf-v1", "Fuck · Go · Good"),
        ("keyword", SnippetStatus.approved, None, "tfidf-v1", "approved v1"),
        ("keyword", SnippetStatus.rejected, None, "tfidf-v1", "rejected v1"),
        ("keyword", SnippetStatus.suggested, datetime.now(timezone.utc), "tfidf-v1", "edited v1"),
        ("import", SnippetStatus.suggested, None, "claude", "imported"),
        ("manual", SnippetStatus.suggested, None, None, "hand-made"),
    ]
    for i, (source, status, edited, generator, title) in enumerate(rows):
        db.add(Snippet(id=uuid.uuid4(), media_file_id=w.media_file_id,
                       start_ms=far + i * 20_000, end_ms=far + i * 20_000 + 15_000,
                       title=title, quote="q", topics=["kept"], status=status,
                       source=source, generator=generator, user_edited_at=edited,
                       quality_score=None))
    db.commit()
    result = _stage_detect(db, w.media_file_id)
    stored = {s.title: (s.status.value, s.generator, s.start_ms, s.quality_score)
              for s in db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id)}
    db.close()

    assert result["removed"] == 1 and result["created"] == 3
    assert "Fuck · Go · Good" not in stored
    for i, title in enumerate(["approved v1", "rejected v1", "edited v1", "imported", "hand-made"],
                              start=1):
        assert stored[title][2] == far + i * 20_000 and stored[title][3] is None, title
    new = [v for v in stored.values() if v[1] == "keyword-v2"]
    assert len(new) == 3 and all(v[3] >= sd.MIN_QUALITY_SCORE for v in new)


def test_the_pipeline_input_carries_the_files_duration_for_the_cap(Session):
    from apps.api.models.asset import MediaFile
    from apps.api.tasks.transcribe_tasks import snippet_detect_input

    w = _make_world(Session)
    db = w.Session()
    data = snippet_detect_input(db, w.media_file_id)
    assert data["media_file_id"] == str(w.media_file_id)
    assert set(data["tracks"]) == {0}
    end_ms = T.conversation(T.EN_MONOLOGUE)[1]
    assert data["duration_ms"] == end_ms
    db.query(MediaFile).filter(MediaFile.id == w.media_file_id).one().duration_seconds = None
    db.commit()
    assert snippet_detect_input(db, w.media_file_id)["duration_ms"] is None
    db.close()


def test_the_detect_script_dry_run_prints_each_score_and_its_reasons(
    Session, run_script, capsys,
):
    from apps.api.scripts import snippet_detect as script

    w = _make_world(Session)
    run_script(script, Session)
    assert script.main(["--asset-id", str(w.asset_id), "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert out.count("score 0.") + out.count("score 1.") == 3
    assert "+first_person" in out and "+clean_end" in out
    assert _snippets(w) == []


def test_the_compare_script_prints_old_and_new_and_writes_nothing(
    Session, run_script, capsys,
):
    from apps.api.models.snippet import SnippetJob
    from apps.api.scripts import snippet_detect_compare as compare

    w = _make_world(Session, tracks=2)
    run_script(compare, Session)
    assert compare.main(["--asset-id", str(w.asset_id)]) == 0
    out = capsys.readouterr().out
    assert "OLD tfidf-v1" in out and "NEW keyword-v2: 3 clip(s), cap 3" in out
    assert "Good · Go · Good Good" in out, "v1's retake clip"
    assert "Nothing written." in out
    assert _snippets(w) == []
    db = w.Session()
    assert db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id).count() == 0
    db.close()


def test_the_compare_script_refuses_a_missing_or_deleted_asset(Session, run_script, capsys):
    from apps.api.scripts import snippet_detect_compare as compare

    w = _make_world(Session, deleted=True)
    run_script(compare, Session)
    assert compare.main(["--asset-id", str(w.asset_id)]) == 2
    assert compare.main(["--asset-id", str(uuid.uuid4())]) == 2
    assert "no live asset" in capsys.readouterr().err


# ── (m) the export script ────────────────────────────────────────────────


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
    assert "[00:00] **Anna Example:** My grandmother opened the first shop" in text
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


# ── (n) the import script ────────────────────────────────────────────────


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
