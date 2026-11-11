"""`snippet_export.py --format sentences`, and importing clips cut on it.

Pure tests first -- where a sentence ends, and what each one carries --
over plain word dicts, as tests/test_snippet_detect.py does for detection.
Then the database half on that file's SQLite world: the script end to end,
the json and md formats unchanged, and a clip cut on sentence edges going
back in through snippet_import.py with nothing snapped and nothing refused.
"""
import json
import random

import pytest

from apps.api.scripts.snippet_export import ends_sentence, split_sentences
from apps.api.tests.test_snippet_detect import (  # noqa: F401  -- fixtures
    Session, _make_world, _snippets, engine, run_script,
)


def tw(track, text, *, start_ms=0, word_ms=300, gap_ms=100, gaps=None, speaker=None):
    """Word dicts for one track, the shape `load_words` produces."""
    out, t = [], start_ms
    for index, token in enumerate(text.split()):
        t += (gaps or {}).get(index, 0)
        out.append({"track": track, "speaker": speaker, "seq": 0, "idx": index,
                    "start_ms": t, "end_ms": t + word_ms, "word": " " + token})
        t += word_ms + gap_ms
    return out


def texts(sentences):
    return [s["text"] for s in sentences]


# ── Where a sentence ends ─────────────────────────────────────────────────


def test_common_abbreviations_and_initials_do_not_end_a_sentence():
    sentences = split_sentences(tw(0,
        "Dr. Weber met Mr. Smith, e.g. on Tuesday in the U.S. office. "
        "John F. Kennedy spoke first. "
        "Frau Prof. Lang kam z.B. heute bzw. morgen. "
        "We started at nine a.m. "
        "And so did I. "
        "Cameras, lenses, lights etc. "
        "Then we left."
    ))
    assert texts(sentences) == [
        "Dr. Weber met Mr. Smith, e.g. on Tuesday in the U.S. office.",
        "John F. Kennedy spoke first.",
        "Frau Prof. Lang kam z.B. heute bzw. morgen.",
        "We started at nine a.m.",
        "And so did I.",
        "Cameras, lenses, lights etc.",
        "Then we left.",
    ]


def test_a_decimal_split_across_two_words_does_not_end_a_sentence():
    sentences = split_sentences(tw(0, "It grew by 2. 5 percent. Then 3.5 more. It took 2. Yes."))
    assert texts(sentences) == ["It grew by 2. 5 percent.", "Then 3.5 more.", "It took 2.", "Yes."]


def test_question_and_exclamation_marks_end_a_sentence_quotes_and_all():
    sentences = split_sentences(tw(0, 'Is it ready? "Yes!" Really?! (Good.) Well… we went on.'))
    assert texts(sentences) == ['Is it ready?', '"Yes!"', 'Really?!', '(Good.)', 'Well… we went on.']


@pytest.mark.parametrize("word,following,expected", [
    ("done.", "Next", True), ("done?", None, True), ('done!"', "So", True),
    ("Dr.", "Weber", False), ("DR.", "Weber", False), ("“Mr.", "Smith", False),
    ("U.S.", "office", False), ("p.m.", "Then", True),
    ("2.", "5", False), ("2.", "Then", True), ("2.", None, True),
    ("done…", "and", False), ("done,", "and", False), ("", "x", False),
])
def test_ends_sentence(word, following, expected):
    assert ends_sentence(word, following) is expected


def test_a_long_sentence_stays_one_sentence_and_reports_its_longest_pause():
    body = " ".join(f"word{n}" for n in range(119)) + " end."
    words = tw(0, body, gaps={60: 1_500})
    [sentence] = split_sentences(words)
    assert sentence["start_ms"] == words[0]["start_ms"]
    assert sentence["end_ms"] == words[-1]["end_ms"]
    assert len(sentence["text"].split()) == 120
    assert sentence["max_inner_gap_ms"] == 1_600, "the 100 ms rhythm plus the 1.5 s pause"
    assert sentence["gap_ms"] is None


def test_a_track_that_ends_mid_sentence_closes_it_at_the_last_word():
    words = tw(0, "This one is done. and then it just trails")
    sentences = split_sentences(words)
    assert texts(sentences) == ["This one is done.", "and then it just trails"]
    assert sentences[-1]["end_ms"] == words[-1]["end_ms"]

    no_terminator = tw(0, "nothing here ever ends")
    assert texts(split_sentences(no_terminator)) == ["nothing here ever ends"]


def test_two_tracks_are_split_on_their_own_and_merged_by_start():
    guest = tw(0, "Hello there. How are you doing today?", speaker="Anna Example")
    host = tw(1, "Fine thanks. And you?", start_ms=500, speaker="Bruno Beispiel")
    # A guest sentence still open while the host speaks: no sentence mixes them.
    sentences = split_sentences(guest + host)

    assert [(s["track"], s["text"]) for s in sentences] == [
        (0, "Hello there."),
        (1, "Fine thanks."),
        (0, "How are you doing today?"),
        (1, "And you?"),
    ]
    assert [s["i"] for s in sentences] == [0, 1, 2, 3]
    assert [s["speaker"] for s in sentences] == [
        "Anna Example", "Bruno Beispiel", "Anna Example", "Bruno Beispiel"]
    # gap_ms is per track, never measured against the other speaker.
    assert sentences[0]["gap_ms"] is None and sentences[1]["gap_ms"] is None
    assert sentences[2]["gap_ms"] == guest[2]["start_ms"] - guest[1]["end_ms"]
    assert sentences[3]["gap_ms"] == host[2]["start_ms"] - host[1]["end_ms"]


# ── What each sentence carries ────────────────────────────────────────────


def test_each_sentence_has_exactly_the_documented_fields():
    [first, second] = split_sentences(tw(0, "One two three. Four five.", gaps={3: 900}))
    assert set(first) == {"i", "track", "speaker", "start_ms", "end_ms",
                          "gap_ms", "max_inner_gap_ms", "text"}
    assert (first["start_ms"], first["end_ms"], first["max_inner_gap_ms"]) == (0, 1_100, 100)
    assert second["gap_ms"] == 100 + 900
    assert second["max_inner_gap_ms"] == 100


def test_the_speaker_is_the_one_of_the_segment_the_sentence_starts_in():
    words = tw(0, "Anna starts this and Bruno ends it.", speaker="Anna Example")
    for word in words[4:]:
        word["speaker"] = "Bruno Beispiel"
    [sentence] = split_sentences(words)
    assert sentence["speaker"] == "Anna Example"


def test_words_are_ordered_by_start_then_index_whatever_order_they_come_in():
    words = tw(0, "First one here. Second one there.") + tw(1, "Other track.", start_ms=50)
    shuffled = list(words)
    random.Random(7).shuffle(shuffled)
    assert split_sentences(shuffled) == split_sentences(words)


def test_min_words_drops_short_sentences_without_inventing_a_silence():
    words = tw(0, "This answer has five words. Yes. Right, right. And this one has six words.")
    every = split_sentences(words)
    kept = split_sentences(words, min_words=3)

    assert texts(every) == ["This answer has five words.", "Yes.", "Right, right.",
                            "And this one has six words."]
    assert texts(kept) == ["This answer has five words.", "And this one has six words."]
    assert [s["i"] for s in kept] == [0, 1]
    # Measured from "right." -- where the silence began -- not from "words."
    assert kept[1]["gap_ms"] == every[3]["gap_ms"] == 100
    assert split_sentences(words, min_words=1) == every


def test_no_words_no_sentences():
    assert split_sentences([]) == []


# ── The script, on a database ─────────────────────────────────────────────


def _export(script, w, tmp_path, *extra):
    out = tmp_path / "sentences.json"
    assert script.main(["--media-file-id", str(w.media_file_id), "--format", "sentences",
                        "--out", str(out), *extra]) == 0
    return json.loads(out.read_text(encoding="utf-8"))


def test_the_sentences_export_reads_the_stored_words(Session, run_script, tmp_path, capsys):
    from apps.api.scripts import snippet_export as script

    w = _make_world(Session, tracks=2)
    run_script(script, Session)
    exported = _export(script, w, tmp_path)

    assert set(exported) == {"media_file_id", "asset_name", "language", "sentences"}
    assert exported["media_file_id"] == str(w.media_file_id)
    assert (exported["asset_name"], exported["language"]) == ("Interview", "en")
    sentences = exported["sentences"]
    assert sentences and {s["track"] for s in sentences} == {0, 1}
    assert [s["i"] for s in sentences] == list(range(len(sentences)))
    assert {s["speaker"] for s in sentences} == {"Anna Example", "Bruno Beispiel"}
    for s in sentences:
        assert s["start_ms"] < s["end_ms"]
        assert s["speaker"] == ["Anna Example", "Bruno Beispiel"][s["track"]]
    assert f"Wrote {len(sentences)} sentence(s)" in capsys.readouterr().err

    fewer = _export(script, w, tmp_path, "--min-words", "3")["sentences"]
    assert 0 < len(fewer) < len(sentences)
    assert all(len(s["text"].split()) >= 3 for s in fewer)


def test_the_sentences_export_refuses_a_soft_deleted_asset(Session, run_script, capsys):
    from apps.api.scripts import snippet_export as script

    w = _make_world(Session, deleted=True)
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--format", "sentences"]) == 2
    assert "in the trash" in capsys.readouterr().err


def test_min_words_is_only_for_the_sentences_format_and_must_be_positive(capsys):
    from apps.api.scripts import snippet_export as script

    for argv in (["--format", "json", "--min-words", "2"], ["--format", "md", "--min-words", "2"],
                 ["--format", "sentences", "--min-words", "0"]):
        with pytest.raises(SystemExit) as exit_info:
            script.main(["--media-file-id", "00000000-0000-0000-0000-000000000000", *argv])
        assert exit_info.value.code == 2
    assert "--min-words" in capsys.readouterr().err


@pytest.mark.parametrize("fmt", ["json", "md"])
def test_the_json_and_md_formats_are_what_they_were(Session, run_script, tmp_path, fmt):
    """`main` writes exactly build_json / build_markdown plus one newline,
    as before --format sentences existed."""
    from apps.api.scripts import snippet_export as script

    w = _make_world(Session, tracks=2)
    run_script(script, Session)
    out = tmp_path / f"transcript.{fmt}"
    assert script.main(["--media-file-id", str(w.media_file_id), "--format", fmt,
                        "--out", str(out)]) == 0

    db = w.Session()
    transcript = script.load_transcript(db, w.media_file_id)
    db.close()
    text = script.build_json(transcript) if fmt == "json" else script.build_markdown(transcript)
    assert out.read_bytes() == (text if text.endswith("\n") else text + "\n").encode("utf-8")


# ── Back in through snippet_import.py ─────────────────────────────────────


def test_clips_cut_on_sentence_edges_import_with_nothing_snapped_or_refused(
    Session, run_script, tmp_path, capsys,
):
    from apps.api.scripts import snippet_export as export
    from apps.api.scripts import snippet_import as script
    from apps.api.services.snippet_detect import validate_import
    from apps.api.tasks.transcribe_tasks import snippet_words_by_track

    w = _make_world(Session, tracks=2)
    run_script(export, Session)
    sentences = _export(export, w, tmp_path)["sentences"]
    guest = [s for s in sentences if s["track"] == 0]
    host = [s for s in sentences if s["track"] == 1]

    # Every sentence on its own, three-sentence runs on one track, and one
    # span from a host sentence's start to a guest sentence's end.
    clips = [(s["start_ms"], s["end_ms"]) for s in sentences]
    clips += [(a["start_ms"], c["end_ms"]) for a, c in zip(guest, guest[2:])]
    later_guest = next(g for g in guest if g["end_ms"] > host[0]["start_ms"])
    clips.append((host[0]["start_ms"], later_guest["end_ms"]))
    payload = {"meta": {"generator": "claude"},
               "snippets": [{"start_ms": start, "end_ms": end, "title": f"Clip {n}",
                             "topics": []}
                            for n, (start, end) in enumerate(clips)]}

    db = w.Session()
    words = {t: d["words"] for t, d in snippet_words_by_track(db, w.media_file_id).items()}
    db.close()
    result = validate_import(payload, words)
    assert result["refused"] == []
    assert result["snapped"] == 0
    assert [(r["start_ms"], r["end_ms"]) for r in result["accepted"]] == clips

    path = tmp_path / "clips.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    run_script(script, Session)
    assert script.main(["--media-file-id", str(w.media_file_id), "--file", str(path)]) == 0
    out = capsys.readouterr().out
    assert f"Imported {len(clips)} (0 with a time snapped to a word boundary), 0 refused." in out
    assert sorted((row[2], row[3]) for row in _snippets(w)) == sorted(clips)
