"""SocialSnippet transcription decisions, without Whisper (services/snippet_transcribe.py).

Track selection, the initial prompt, folder scope and the bleed gate are
plain functions over plain data. The gate is tested against real WAVs
made by ffmpeg, so the RMS reader and the dB arithmetic are exercised on
actual PCM rather than on numbers typed into the test. Those tests skip if
ffmpeg is not installed; the test image has it.
"""

import math
import shutil
import subprocess

import pytest

from apps.api.services.snippet_transcribe import (
    INITIAL_PROMPT_MAX_CHARS,
    audio_streams_from_ffprobe,
    build_initial_prompt,
    combined_segments,
    dominant_language,
    folder_in_scope,
    gate_words_by_track,
    has_speech_level,
    is_whisper_no_speech_error,
    rms_profile,
    select_tracks,
    span_level_db,
)


def _stream(audio_index, channels, **extra):
    return {"stream_index": audio_index + 1, "audio_index": audio_index, "codec": "aac",
            "channels": channels, "channel_layout": "mono" if channels == 1 else "stereo",
            "sample_rate": 48000, **extra}


# ── select_tracks ──────────────────────────────────────────────────────────


def test_one_track_is_used():
    tracks, reason = select_tracks([_stream(0, 2)], [])
    assert tracks == [0]
    assert "single" in reason


def test_three_mono_tracks_are_all_used():
    tracks, _ = select_tracks([_stream(0, 1), _stream(1, 1), _stream(2, 1)], [])
    assert tracks == [0, 1, 2]


def test_stereo_fullmix_is_skipped_next_to_mono_tracks():
    streams = [_stream(0, 2), _stream(1, 1), _stream(2, 1)]
    tracks, reason = select_tracks(streams, [])
    assert tracks == [1, 2]
    assert "fullmix" in reason and "[0]" in reason


def test_all_stereo_tracks_are_kept():
    """Nothing to compare against: no stream is presumed to be a mix."""
    tracks, _ = select_tracks([_stream(0, 2), _stream(1, 2)], [])
    assert tracks == [0, 1]


def test_mapped_tracks_override_everything():
    streams = [_stream(0, 2), _stream(1, 1), _stream(2, 1)]

    class Row:
        def __init__(self, i):
            self.track_index = i

    tracks, reason = select_tracks(streams, [Row(2), Row(0)])
    assert tracks == [0, 2], "mapped means exactly the mapped tracks, stereo or not"
    assert "mapped" in reason
    assert select_tracks(streams, [2])[0] == [2], "plain ints work too"


def test_no_audio_streams_means_nothing_to_transcribe():
    assert select_tracks([], [])[0] == []
    assert select_tracks(None, None)[0] == []


def test_streams_without_a_usable_index_fall_back_to_track_zero():
    tracks, reason = select_tracks([{"audio_index": None}, {"channels": 1}], [])
    assert tracks == [0]
    assert "audio_index 0" in reason


def test_ffprobe_output_becomes_the_audio_streams_shape():
    payload = {"streams": [
        {"index": 0, "codec_type": "video", "codec_name": "h264"},
        {"index": 1, "codec_type": "audio", "codec_name": "aac", "channels": 2,
         "channel_layout": "stereo", "sample_rate": "48000", "duration": "12.5",
         "tags": {"language": "deu", "title": "Mix"}},
        {"index": 2, "codec_type": "audio", "codec_name": "pcm_s24le", "channels": 1,
         "sample_rate": "48000"},
    ]}
    streams = audio_streams_from_ffprobe(payload)
    assert [s["audio_index"] for s in streams] == [0, 1]
    assert [s["stream_index"] for s in streams] == [1, 2]
    assert streams[0]["language"] == "deu" and streams[0]["title"] == "Mix"
    assert streams[0]["sample_rate"] == 48000 and streams[0]["duration_seconds"] == 12.5
    assert select_tracks(streams, [])[0] == [1]


# ── build_initial_prompt ─────────────────────────────────────────────────


def test_prompt_lists_the_names():
    assert build_initial_prompt(["Anna Müller", "Jörg Øster"]) == "Anna Müller, Jörg Øster."


def test_prompt_is_empty_without_speakers():
    assert build_initial_prompt([]) == ""
    assert build_initial_prompt(None) == ""
    assert build_initial_prompt(["", "   "]) == ""


def test_prompt_drops_duplicates_ignoring_case():
    assert build_initial_prompt(["Anna", "anna", " Anna "]) == "Anna."


def test_prompt_never_exceeds_200_characters_and_never_cuts_a_name():
    names = [f"Speaker{i:03d} Lastname" for i in range(50)]
    prompt = build_initial_prompt(names)
    assert 0 < len(prompt) <= INITIAL_PROMPT_MAX_CHARS == 200
    for part in prompt.rstrip(".").split(", "):
        assert part in names, f"{part!r} is a cut name"
    # A name that cannot fit is left out; later shorter ones still get in.
    assert build_initial_prompt(["X" * 250, "Anna"]) == "Anna."


# ── folder scope ───────────────────────────────────────────────────────────


def test_scope_is_the_source_folder_and_everything_below():
    parents = {"child": "source", "grandchild": "child", "source": "root", "other": "root", "root": None}
    assert folder_in_scope("source", "source", parents.get)
    assert folder_in_scope("grandchild", "source", parents.get)
    assert not folder_in_scope("other", "source", parents.get)
    assert not folder_in_scope(None, "source", parents.get), "project root is outside a source folder"
    assert folder_in_scope(None, None, parents.get), "no source folder = whole project"
    assert folder_in_scope("other", None, parents.get)


def test_scope_survives_a_parent_cycle():
    cycle = {"a": "b", "b": "a"}
    assert not folder_in_scope("a", "source", cycle.get)


# ── levels and the gate, on real WAVs ──────────────────────────────────────

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def _tone(path, volume_db=0.0, seconds=3, freq=440):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
         "-i", f"sine=frequency={freq}:sample_rate=16000:duration={seconds}",
         "-af", f"volume={volume_db}dB", "-ac", "1", "-c:a", "pcm_s16le", str(path)],
        check=True,
    )
    return str(path)


def _words(*spans):
    return [{"start": s, "end": e, "word": f" w{i}", "probability": 0.9}
            for i, (s, e) in enumerate(spans)]


def _segment(*spans):
    words = _words(*spans)
    return {"start": spans[0][0], "end": spans[-1][1],
            "text": "".join(w["word"] for w in words).strip(), "words": words}


@needs_ffmpeg
def test_rms_profile_measures_a_20_db_difference(tmp_path):
    loud = rms_profile(_tone(tmp_path / "a.wav"))
    quiet = rms_profile(_tone(tmp_path / "b.wav", volume_db=-20))
    assert len(loud) == len(quiet) == 30, "3 s at 100 ms frames"
    diff = span_level_db(loud, 0.5, 2.5) - span_level_db(quiet, 0.5, 2.5)
    assert 19.5 < diff < 20.5, diff
    # A sine at ffmpeg's default amplitude (1/8) is about -21 dBFS RMS.
    assert -23 < span_level_db(loud, 0.5, 2.5) < -19


@needs_ffmpeg
def test_gate_drops_the_bleed_track_and_keeps_the_speaker(tmp_path):
    rms = {
        0: rms_profile(_tone(tmp_path / "a.wav")),
        1: rms_profile(_tone(tmp_path / "b.wav", volume_db=-20)),
    }
    spans = [(0.5, 1.0), (1.2, 1.8), (2.0, 2.6)]
    track_words = {0: [_segment(*spans)], 1: [_segment(*spans)]}

    gated = gate_words_by_track(track_words, rms, margin_db=6.0, min_keep_ratio=0.5)

    assert gated[0] == track_words[0], "the speaker's own track is untouched"
    assert gated[1] == [], "every word on the -20 dB copy is bleed"
    assert track_words[1][0]["words"], "the input is not mutated"


@needs_ffmpeg
def test_gate_keeps_two_equally_loud_tracks(tmp_path):
    rms = {
        0: rms_profile(_tone(tmp_path / "a.wav")),
        1: rms_profile(_tone(tmp_path / "b.wav", freq=660)),
    }
    spans = [(0.5, 1.0), (1.2, 1.8)]
    track_words = {0: [_segment(*spans)], 1: [_segment(*spans)]}

    gated = gate_words_by_track(track_words, rms, margin_db=6.0, min_keep_ratio=0.5)
    assert gated == track_words


@needs_ffmpeg
def test_gate_trims_a_segment_that_keeps_enough_words(tmp_path):
    """A segment survives when at least min_keep_ratio of its words do; the
    dropped words leave its text and its start."""
    loud = rms_profile(_tone(tmp_path / "a.wav"))
    quiet = rms_profile(_tone(tmp_path / "b.wav", volume_db=-20))
    # Track 0 is loud for the first second only, then quiet; track 1 the
    # other way round. 30 frames each.
    t0 = loud[:10] + quiet[10:]
    t1 = quiet[:10] + loud[10:]
    seg = _segment((0.2, 0.6), (1.2, 1.6), (1.8, 2.2), (2.4, 2.8))
    gated = gate_words_by_track({0: [], 1: [seg]}, {0: t0, 1: t1}, 6.0, 0.5)
    kept = gated[1][0]
    assert [w["word"] for w in kept["words"]] == [" w1", " w2", " w3"]
    assert kept["text"] == "w1 w2 w3"
    assert kept["start"] == 1.2

    strict = gate_words_by_track({0: [], 1: [seg]}, {0: t0, 1: t1}, 6.0, 0.8)
    assert strict[1] == [], "3 of 4 is below a 0.8 keep ratio"


def test_gate_is_a_no_op_for_one_track():
    track_words = {0: [_segment((0.0, 0.5))]}
    assert gate_words_by_track(track_words, {0: []}, 6.0, 0.5) is track_words


def test_gate_keeps_words_when_every_track_is_silent():
    """No evidence of bleed is not evidence of bleed."""
    track_words = {0: [_segment((0.0, 0.5))], 1: [_segment((0.0, 0.5))]}
    assert gate_words_by_track(track_words, {0: [0.0] * 10, 1: [0.0] * 10}, 6.0, 0.5) == track_words


def test_span_level_reads_at_least_one_frame_and_silence_past_the_end():
    rms = [0.5, 0.25]
    assert math.isclose(span_level_db(rms, 0.01, 0.02), 20 * math.log10(0.5))
    assert span_level_db(rms, 5.0, 6.0) == -200.0


# ── output ─────────────────────────────────────────────────────────────────


def test_combined_segments_are_time_ordered_across_tracks_in_the_old_shape():
    gated = {
        0: [{"start": 0.0, "end": 1.0, "text": "a"}, {"start": 4.0, "end": 5.0, "text": "c"}],
        1: [{"start": 2.0, "end": 3.0, "text": " b "}, {"start": 6.0, "end": 7.0, "text": ""}],
    }
    out = combined_segments(gated)
    assert [s["text"] for s in out] == ["a", "b", "c"]
    assert [s["id"] for s in out] == [0, 1, 2]
    assert all(set(s) == {"id", "start", "end", "text"} for s in out)


def test_dominant_language_is_the_track_with_most_words():
    tracks = {0: {"language": "de", "language_probability": 0.9},
              1: {"language": "en", "language_probability": 0.8}}
    gated = {0: [_segment((0, 1))], 1: [_segment((0, 1), (1, 2), (2, 3))]}
    assert dominant_language(tracks, gated) == ("en", 0.8)


# ── speech or not ──────────────────────────────────────────────────────────


def test_speech_level_needs_a_second_above_the_floor():
    floor = 10 ** (-55 / 20)
    assert has_speech_level([0.1] * 10) is True, "1 s of -20 dBFS"
    assert has_speech_level([0.1] * 9 + [0.0] * 1000) is False, "0.9 s is not enough"
    assert has_speech_level([floor * 1.01] * 10) is True
    assert has_speech_level([floor * 0.99] * 100_000) is False, "hours of hiss below the floor"
    assert has_speech_level([]) is False and has_speech_level([0.0] * 34_000) is False
    assert has_speech_level([0.1] * 20, frame_ms=50) is True
    with pytest.raises(ValueError):
        has_speech_level([0.1], frame_ms=0)


@pytest.mark.parametrize("exc, expected", [
    (ValueError("max() arg is an empty sequence"), True),
    # Everything else is a real failure and must propagate.
    (ValueError("max() arg is an empty sequence "), False),
    (ValueError("Max() arg is an empty sequence"), False),
    (ValueError("invalid literal for int()"), False),
    (ValueError(), False),
    (RuntimeError("max() arg is an empty sequence"), False),
    (type("SubValueError", (ValueError,), {})("max() arg is an empty sequence"), False),
], ids=["exact", "trailing-space", "case", "other-message", "no-message", "runtime", "subclass"])
def test_only_the_exact_whisper_error_means_no_speech(exc, expected):
    assert is_whisper_no_speech_error(exc) is expected


def test_the_message_is_what_this_python_says_for_an_empty_max():
    """The worker and the test image run the same CPython line (3.11); if
    an upgrade changes the wording, this fails before the server does."""
    from apps.api.services.snippet_transcribe import WHISPER_NO_SPEECH_MESSAGE
    with pytest.raises(ValueError) as caught:
        max([])
    assert str(caught.value) == WHISPER_NO_SPEECH_MESSAGE


@needs_ffmpeg
def test_a_generated_silent_wav_has_no_speech_level_and_a_tone_has(tmp_path):
    silent = tmp_path / "silent.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
         "-t", "5", "-c:a", "pcm_s16le", str(silent)],
        check=True,
    )
    rms = rms_profile(str(silent))
    assert len(rms) == 50 and max(rms) == 0.0
    assert has_speech_level(rms) is False
    assert has_speech_level(rms_profile(_tone(tmp_path / "loud.wav"))) is True
    # -21 dBFS tone pulled down 30 dB: about -51 dBFS, quiet speech. Still asked.
    assert has_speech_level(rms_profile(_tone(tmp_path / "quiet.wav", volume_db=-30))) is True
    # 40 dB down, about -61 dBFS: below the floor.
    assert has_speech_level(rms_profile(_tone(tmp_path / "hiss.wav", volume_db=-40))) is False


# ── which failures are retried ─────────────────────────────────────────────


def _client_error(code):
    from botocore.exceptions import ClientError
    return ClientError({"Error": {"Code": code}}, "GetObject")


def _transient_cases():
    import subprocess as sp
    from botocore.exceptions import EndpointConnectionError, ReadTimeoutError
    from sqlalchemy.exc import OperationalError
    from apps.api.tasks.transcribe_tasks import _FfmpegError

    return [
        (ConnectionError("reset by peer"), True),
        (TimeoutError("read timed out"), True),
        (sp.TimeoutExpired(["ffmpeg"], 10), True),
        (sp.CalledProcessError(1, ["ffmpeg"]), True),
        (_FfmpegError("ffmpeg could not extract audio track 1"), True),
        (EndpointConnectionError(endpoint_url="http://s3"), True),
        (ReadTimeoutError(endpoint_url="http://s3"), True),
        (_client_error("SlowDown"), True),
        (_client_error("InternalError"), True),
        (OperationalError("SELECT 1", {}, Exception("server closed the connection")), True),
        (MemoryError(), True),
        (RuntimeError("std::bad_alloc"), True),
        (RuntimeError("CUDA failed: out of memory"), True),
        # Deterministic: fail the stage at once.
        (ValueError("max() arg is an empty sequence"), False),
        (ValueError("bad"), False),
        (KeyError("segments"), False),
        (TypeError("NoneType"), False),
        (_client_error("NoSuchKey"), False),
        (_client_error("404"), False),
        (_client_error("AccessDenied"), False),
        (RuntimeError("Whisper model 'small.en' is an English-only checkpoint"), False),
        (Exception("anything unknown"), False),
    ]


def test_retry_classification():
    from apps.api.tasks.transcribe_tasks import _is_transient
    for exc, expected in _transient_cases():
        assert _is_transient(exc) is expected, (type(exc).__name__, str(exc))
