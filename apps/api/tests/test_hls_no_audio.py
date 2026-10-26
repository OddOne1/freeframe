"""A video with NO audio track must transcode (§237).

The bug, from the production worker log of 2026-10-26:

    Stream #0:0 ...: Video: h264 (Main) ... 2618x1968   <- the ONLY stream
    Stream map '' matches no streams.
    To ignore this, add a trailing '?' to the map.
    Failed to set value 'a:0' for option 'map': Invalid argument
    Error opening output files: Invalid argument
    RuntimeError: Transcode failed: HLS transcode failed (exit 234)

`-map a:0` was appended for every rung of the ladder unconditionally, and
`-var_stream_map` always claimed one audio rendition per video rendition.
A silent source -- an iOS ReplayKit screen recording, stock footage, any
muted export -- therefore died in ffmpeg's OPTION PARSING, about 0.7 s in,
before a single frame was encoded, and the version went `failed`.

Two halves, and both matter:

  * **The with-audio command must not move.** `_ladder_cmd_before_the_fix`
    below is a verbatim copy of the builder as it shipped on `main`
    (b50275a), kept here as an oracle: every file that has audio -- which
    is nearly everything in the library -- must still be encoded by exactly
    the argv it was encoded by yesterday, flag for flag, in order.
  * **Without audio, exactly two things change**: no `-map a:0` on any
    rung, and `-var_stream_map v:0 v:1 v:2` instead of `v:0,a:0 ...`.
    Nothing else -- not the filter graph, not the codec flags, not
    `master.m3u8`, not `%v/seg_%03d.ts` -- so nothing downstream (the
    upload, the HLS proxy, hls.js, Safari's native player, the share page)
    can tell the difference beyond the missing audio.

The real-ffmpeg tests are the only ones that prove ffmpeg ACCEPTS the
command; they skip where ffmpeg is absent. They were run for this change
against ffmpeg 7.1.5 (the production version is 7.1), including one that
asserts the OLD command still fails on a silent input with the very words
from the log above.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from packages.transcoder.base import (  # noqa: E402
    TranscodeJob,
    has_audio_stream,
)
from packages.transcoder import ffmpeg_transcoder as ft  # noqa: E402
from packages.transcoder.ffmpeg_transcoder import (  # noqa: E402
    QUALITY_MAP,
    FFmpegTranscoder,
    hls_ladder_cmd,
)

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(
    not HAVE_FFMPEG,
    reason="needs real ffmpeg: a mock cannot prove ffmpeg accepts the command",
)

SIGNED_URL = (
    "https://192.168.1.34:30320/freeframe/raw/p/a/v/SCREEN.mov"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Signature=7f3c0ddeadbeefcafe0123456789abcdef0123456789abcdef01234567"
)

LADDER = ["1080p", "720p", "360p"]


# ── the oracle: the builder exactly as it shipped on main ─────────────────

def _ladder_cmd_before_the_fix(input_url: str, qualities: list, hls_dir: Path) -> list:
    """`main`'s ladder command, copied verbatim, audio maps and all.

    Deliberately a COPY rather than a call with a flag: an oracle that
    shares code with the thing it checks cannot catch the thing it is here
    to catch, which is the with-audio argv drifting while the fix is made.
    """
    split_outputs = "".join(f"[v{i}]" for i in range(len(qualities)))
    filter_complex = f"[v:0]split={len(qualities)}{split_outputs};"
    filter_complex += ";".join(
        f"[v{i}]scale={QUALITY_MAP[q][0]}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2[{q}]"
        for i, q in enumerate(qualities)
    )

    ffmpeg_cmd = [
        "ffmpeg", "-y", "-i", input_url,
        "-filter_complex", filter_complex,
    ]

    for i, quality in enumerate(qualities):
        scale, crf = QUALITY_MAP[quality]
        ffmpeg_cmd += [
            "-map", f"[{quality}]", "-map", "a:0",
            f"-c:v:{i}", "libx264", f"-crf", str(crf), "-preset", "fast",
            f"-pix_fmt:v:{i}", "yuv420p",
            f"-profile:v:{i}", "high",
            f"-level:v:{i}", "4.1",
            "-force_key_frames", "expr:gte(t,n_forced*2)",
        ]

    ffmpeg_cmd += [
        "-f", "hls",
        "-hls_time", "2",
        "-hls_playlist_type", "vod",
        "-hls_flags", "independent_segments",
        "-hls_segment_type", "mpegts",
        "-master_pl_name", "master.m3u8",
        "-var_stream_map", " ".join(f"v:{i},a:{i}" for i in range(len(qualities))),
        "-hls_segment_filename", str(hls_dir / "%v" / "seg_%03d.ts"),
        str(hls_dir / "%v" / "playlist.m3u8"),
    ]
    ffmpeg_cmd += ["-progress", "pipe:1", "-nostats"]
    return ffmpeg_cmd


def _value_after(cmd: list, flag: str):
    return cmd[cmd.index(flag) + 1]


# ── B: the with-audio command is byte-for-byte what it was ────────────────

@pytest.mark.parametrize("qualities", [LADDER, ["720p", "360p"], ["360p"]])
def test_with_audio_the_argv_is_exactly_what_it_was_before(qualities, tmp_path):
    """The whole no-regression guarantee, in one assertion per ladder shape."""
    assert hls_ladder_cmd(SIGNED_URL, qualities, tmp_path, has_audio=True) == \
        _ladder_cmd_before_the_fix(SIGNED_URL, qualities, tmp_path)


def test_with_audio_still_maps_one_audio_stream_per_rendition(tmp_path):
    cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=True)
    assert cmd.count("a:0") == len(LADDER)
    assert _value_after(cmd, "-var_stream_map") == "v:0,a:0 v:1,a:1 v:2,a:2"


# ── C: without audio, no audio map and a video-only var_stream_map ────────

def test_no_audio_drops_every_audio_map(tmp_path):
    cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=False)
    assert "a:0" not in cmd, (
        "a silent source has nothing for `-map a:0` to match: ffmpeg refuses "
        "the whole command with \"Stream map '' matches no streams\" before "
        "it encodes a frame"
    )
    mapped = [cmd[i + 1] for i, arg in enumerate(cmd) if arg == "-map"]
    assert mapped == [f"[{q}]" for q in LADDER]
    assert not any(m.startswith("a:") for m in mapped)


def test_no_audio_var_stream_map_has_no_audio_member(tmp_path):
    cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=False)
    assert _value_after(cmd, "-var_stream_map") == "v:0 v:1 v:2"


@pytest.mark.parametrize("qualities", [LADDER, ["720p", "360p"], ["360p"]])
def test_no_audio_var_stream_map_still_names_every_rendition(qualities, tmp_path):
    cmd = hls_ladder_cmd(SIGNED_URL, qualities, tmp_path, has_audio=False)
    assert _value_after(cmd, "-var_stream_map") == " ".join(
        f"v:{i}" for i in range(len(qualities))
    )


def test_no_audio_changes_nothing_but_the_maps(tmp_path):
    """The silent command IS the audio command minus audio. Nothing else.

    Written as a transformation rather than a list of spot checks so that
    anything else that drifts -- a codec flag, the filter graph, the
    segment pattern, the order of any of it -- fails here.
    """
    with_audio = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=True)
    without = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=False)

    stripped, i = [], 0
    while i < len(with_audio):
        if with_audio[i] == "-map" and with_audio[i + 1] == "a:0":
            i += 2
            continue
        if with_audio[i] == "-var_stream_map":
            stripped += ["-var_stream_map", "v:0 v:1 v:2"]
            i += 2
            continue
        stripped.append(with_audio[i])
        i += 1

    assert stripped == without


def test_the_hls_output_layout_is_identical_on_both_paths(tmp_path):
    """Everything downstream keys off these, so they may not move."""
    for has_audio in (True, False):
        cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=has_audio)
        assert _value_after(cmd, "-master_pl_name") == "master.m3u8"
        assert _value_after(cmd, "-hls_segment_filename") == \
            str(tmp_path / "%v" / "seg_%03d.ts")
        assert _value_after(cmd, "-f") == "hls"
        assert str(tmp_path / "%v" / "playlist.m3u8") in cmd
        # -progress is what _run_ffmpeg_with_progress reads for the bar.
        assert cmd[-3:] == ["-progress", "pipe:1", "-nostats"]


def test_no_audio_keeps_every_video_encoding_flag(tmp_path):
    """§117's pinned pixel format/profile/level are not audio's business."""
    cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=False)
    for i, q in enumerate(LADDER):
        assert _value_after(cmd, f"-c:v:{i}") == "libx264"
        assert _value_after(cmd, f"-pix_fmt:v:{i}") == "yuv420p"
        assert _value_after(cmd, f"-profile:v:{i}") == "high"
        assert _value_after(cmd, f"-level:v:{i}") == "4.1"
    assert cmd.count("-crf") == len(LADDER)


def test_neither_path_pins_an_audio_codec(tmp_path):
    """The ladder has never set one; inheriting the mpegts default (AAC) is
    what every rendition already in the library was made with."""
    for has_audio in (True, False):
        cmd = hls_ladder_cmd(SIGNED_URL, LADDER, tmp_path, has_audio=has_audio)
        assert not any(a.startswith("-c:a") or a.startswith("-b:a") for a in cmd)


# ── A: detection, from the probe the pipeline already runs ────────────────

def test_detects_audio_from_the_probe_payload():
    assert has_audio_stream({"streams": [
        {"codec_type": "video", "codec_name": "h264"},
        {"codec_type": "audio", "codec_name": "aac", "channels": 2},
    ]}) is True


def test_detects_the_absence_of_audio():
    """The production file: one video stream and nothing else."""
    assert has_audio_stream({"streams": [
        {"codec_type": "video", "codec_name": "h264",
         "width": 2618, "height": 1968},
    ]}) is False


@pytest.mark.parametrize("payload", [
    {},
    {"streams": []},
    {"streams": None},
    {"format": {"duration": "18.02"}},
    {"streams": [{"codec_type": "data"}, {"codec_type": "subtitle"}]},
])
def test_no_audio_for_payloads_that_do_not_contain_one(payload):
    assert has_audio_stream(payload) is False


def test_an_unusable_audio_stream_still_counts_as_audio():
    """§237 D — detection matches what `-map a:0` itself would select.

    A zero-channel or exotic-codec audio stream is mapped by ffmpeg today
    and will be mapped tomorrow: whatever it does then, it does the same
    thing now. Deciding a stream is "too broken to map" would be an audio
    re-encoding policy, and it would silently change the behaviour of files
    that transcode fine today.
    """
    assert has_audio_stream({"streams": [
        {"codec_type": "video"},
        {"codec_type": "audio", "codec_name": "pcm_s16le", "channels": 0},
    ]}) is True


def test_detection_survives_junk_in_the_stream_list():
    assert has_audio_stream({"streams": ["nonsense", None, {"codec_type": "audio"}]}) is True
    assert has_audio_stream({"streams": ["nonsense", None]}) is False


def test_detection_is_not_a_guess_from_the_file_name():
    """A name says nothing about the streams, in either direction."""
    assert has_audio_stream({
        "streams": [{"codec_type": "video"}],
        "format": {"filename": "interview_with_audio.mov"},
    }) is False
    assert has_audio_stream({
        "streams": [{"codec_type": "video"}, {"codec_type": "audio"}],
        "format": {"filename": "silent_screen_recording.mov"},
    }) is True


# ── the whole of transcode(), with ffmpeg stubbed ─────────────────────────

class _FakeS3:
    def __init__(self):
        self.uploaded = []

    def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
        return SIGNED_URL

    def download_file(self, bucket, key, path, **kw):
        raise RuntimeError("no exiftool source in tests")

    def upload_file(self, path, bucket, key, ExtraArgs=None, **kw):  # noqa: N803
        self.uploaded.append(key)


def _job():
    return TranscodeJob(
        media_id="m", version_id="v",
        input_s3_key="raw/p/a/v/SCREEN.mov",
        output_s3_prefix="processed/p/a/v",
        qualities=LADDER,
    )


SILENT_PROBE = json.dumps({
    "streams": [{"codec_type": "video", "codec_name": "h264", "width": 2618,
                 "height": 1968, "duration": "18.02", "r_frame_rate": "25/1"}],
    "format": {"duration": "18.02"},
})

WITH_AUDIO_PROBE = json.dumps({
    "streams": [
        {"codec_type": "video", "codec_name": "h264", "width": 1920,
         "height": 1080, "duration": "18.02", "r_frame_rate": "25/1"},
        {"codec_type": "audio", "codec_name": "aac", "channels": 2,
         "sample_rate": "48000"},
    ],
    "format": {"duration": "18.02"},
})


def _run_transcode(monkeypatch, probe_stdout, probe_rc=0):
    """transcode() with every subprocess stubbed; returns (result, ladder_cmd)."""
    captured = {}

    def fake_ladder(cmd, dur, cb, timeout, **kw):
        captured["cmd"] = list(cmd)

    monkeypatch.setattr(
        FFmpegTranscoder, "_run_ffmpeg_with_progress", staticmethod(fake_ladder),
    )

    def fake_run(cmd, **kw):
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, probe_rc, probe_stdout, "")
        # the thumbnail attempts: write the frame they are asked for
        Path(cmd[-1].replace("%04d", "0001")).write_bytes(b"\xff\xd8jpeg")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    t = FFmpegTranscoder(_FakeS3(), "freeframe", "http://s3")
    result = ft.asyncio.run(t.transcode(_job()))
    return result, captured.get("cmd")


def test_a_silent_input_takes_the_video_only_path(monkeypatch):
    result, cmd = _run_transcode(monkeypatch, SILENT_PROBE)
    assert result.success is True
    assert "a:0" not in cmd
    assert _value_after(cmd, "-var_stream_map") == "v:0 v:1 v:2"


def test_an_input_with_audio_is_transcoded_exactly_as_before(monkeypatch, tmp_path):
    result, cmd = _run_transcode(monkeypatch, WITH_AUDIO_PROBE)
    assert result.success is True
    assert cmd.count("a:0") == len(LADDER)
    # Same oracle as above, now through the real entry point: only the
    # work_dir in the paths differs, so compare the shape around them.
    hls_dir = Path(_value_after(cmd, "-hls_segment_filename")).parent.parent
    assert cmd == _ladder_cmd_before_the_fix(SIGNED_URL, LADDER, hls_dir)


@pytest.mark.parametrize("probe_stdout,probe_rc", [
    ("", 1),                      # ffprobe failed outright
    ("not json at all", 0),       # ffprobe answered with something unusable
])
def test_an_unreadable_probe_keeps_todays_behaviour(monkeypatch, probe_stdout, probe_rc):
    """Unknown is NOT treated as silent.

    Guessing "no audio" from a probe that said nothing would strip the
    sound off a file that has it -- a defect nobody notices for weeks.
    Guessing "audio" costs, at worst, the failure this change fixes, on a
    source we already know we could not read.
    """
    result, cmd = _run_transcode(monkeypatch, probe_stdout, probe_rc)
    assert result.success is True
    assert cmd.count("a:0") == len(LADDER)


def test_the_silent_path_says_so_in_the_log(monkeypatch, caplog):
    """§237 F — one line, and at WARNING: the transcoding worker runs at
    --loglevel=warning in production, so an INFO line would not be written
    at all and the video-only path would leave no trace where it matters."""
    with caplog.at_level("INFO", logger="packages.transcoder.ffmpeg_transcoder"):
        _run_transcode(monkeypatch, SILENT_PROBE)
    hits = [r for r in caplog.records if "no audio stream" in r.getMessage()]
    assert len(hits) == 1, f"expected exactly one line, got {len(hits)}"
    assert hits[0].levelname == "WARNING"
    assert "raw/p/a/v/SCREEN.mov" in hits[0].getMessage()
    assert "video-only" in hits[0].getMessage()


def test_nothing_is_logged_about_audio_for_a_normal_file(monkeypatch, caplog):
    with caplog.at_level("INFO", logger="packages.transcoder.ffmpeg_transcoder"):
        _run_transcode(monkeypatch, WITH_AUDIO_PROBE)
    assert not [r for r in caplog.records if "no audio stream" in r.getMessage()]


def test_the_audio_question_costs_no_extra_probe(monkeypatch):
    """A — one ffprobe of the input, as before. The URL is presigned and
    the object can be 100 GB: every probe of it is a real range read."""
    probes = []

    monkeypatch.setattr(
        FFmpegTranscoder, "_run_ffmpeg_with_progress",
        staticmethod(lambda cmd, dur, cb, timeout, **kw: None),
    )

    def fake_run(cmd, **kw):
        if cmd[0] == "ffprobe":
            probes.append(list(cmd))
            return subprocess.CompletedProcess(cmd, 0, SILENT_PROBE, "")
        Path(cmd[-1].replace("%04d", "0001")).write_bytes(b"\xff\xd8jpeg")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    ft.asyncio.run(FFmpegTranscoder(_FakeS3(), "freeframe", "http://s3").transcode(_job()))

    assert len(probes) == 1, f"one probe of the input, not {len(probes)}"
    # And it is the probe that was already there: all streams, not v:0 only.
    assert "-show_streams" in probes[0] and "-select_streams" not in probes[0]


# ── real ffmpeg: the only proof ffmpeg accepts any of this ────────────────

def _make_clip(path: Path, *, audio_tracks: int) -> Path:
    cmd = ["ffmpeg", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=25"]
    for n in range(audio_tracks):
        cmd += ["-f", "lavfi", "-i", f"sine=frequency={440 + 110 * n}:duration=2"]
    if audio_tracks:
        # Explicit maps: ffmpeg's default stream selection takes ONE audio
        # input, so a two-track fixture would quietly be a one-track one.
        cmd += ["-map", "0:v:0"]
        for n in range(audio_tracks):
            cmd += ["-map", f"{n + 1}:a:0"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if audio_tracks:
        cmd += ["-c:a", "aac"]
    cmd.append(str(path))
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)
    return path


def _probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-show_format", str(path)],
        capture_output=True, text=True, timeout=60, check=True,
    ).stdout
    return json.loads(out)


def _variant_dirs(hls_dir: Path, count: int) -> list:
    """ffmpeg's `%v` expands to the variant INDEX, so the renditions land in
    `0/`, `1/`, `2/` -- not in the `1080p/`-style directories the ladder
    also creates. True before this fix and after it; see
    test_real_ffmpeg_the_variant_directories_are_indices_on_both_paths."""
    return [hls_dir / str(i) for i in range(count)]


def _codec_types(path: Path) -> list:
    return [s["codec_type"] for s in _probe(path)["streams"]]


def _encode_ladder(src: Path, hls_dir: Path, *, has_audio: bool, qualities=None):
    qualities = qualities or ["720p", "360p"]
    hls_dir.mkdir(parents=True, exist_ok=True)
    for q in qualities:
        (hls_dir / q).mkdir(exist_ok=True)
    cmd = hls_ladder_cmd(str(src), qualities, hls_dir, has_audio=has_audio)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=600), qualities


@needs_ffmpeg
def test_real_ffmpeg_the_old_command_still_fails_on_a_silent_input(tmp_path):
    """The bug itself, reproduced: this is what production was running."""
    src = _make_clip(tmp_path / "silent.mp4", audio_tracks=0)
    hls_dir = tmp_path / "hls_old"
    hls_dir.mkdir()
    for q in ["720p", "360p"]:
        (hls_dir / q).mkdir()
    proc = subprocess.run(
        _ladder_cmd_before_the_fix(str(src), ["720p", "360p"], hls_dir),
        capture_output=True, text=True, timeout=600,
    )
    assert proc.returncode != 0
    assert "matches no streams" in proc.stderr
    assert "Failed to set value 'a:0' for option 'map'" in proc.stderr


@needs_ffmpeg
def test_real_ffmpeg_a_silent_input_produces_a_playable_ladder(tmp_path):
    src = _make_clip(tmp_path / "silent.mp4", audio_tracks=0)
    assert has_audio_stream(_probe(src)) is False

    hls_dir = tmp_path / "hls"
    proc, qualities = _encode_ladder(src, hls_dir, has_audio=False)
    assert proc.returncode == 0, proc.stderr[-1500:]

    master = hls_dir / "master.m3u8"
    assert master.exists()
    text = master.read_text()
    assert text.count("#EXT-X-STREAM-INF") == len(qualities)
    # A video-only master names no audio group, and must not claim one:
    # an EXT-X-MEDIA TYPE=AUDIO pointing at renditions that carry none is
    # exactly what would break a player on a stream that is otherwise fine.
    assert "EXT-X-MEDIA" not in text
    assert 'CODECS="avc1' in text and "mp4a" not in text
    # Both rungs are there, at their real sizes.
    assert "RESOLUTION=1280x720" in text and "RESOLUTION=640x360" in text

    for variant in _variant_dirs(hls_dir, len(qualities)):
        playlist = variant / "playlist.m3u8"
        assert playlist.exists(), f"{variant.name} has no variant playlist"
        segments = sorted(variant.glob("seg_*.ts"))
        assert segments, f"{variant.name} produced no segments"
        listed = [l for l in playlist.read_text().splitlines() if l.endswith(".ts")]
        assert listed, f"{variant.name}'s playlist lists no segments"
        assert len(listed) == len(segments)
        assert _codec_types(segments[0]) == ["video"]
        # Every URI the master names actually exists next to it.
        assert f"{variant.name}/playlist.m3u8" in text


@needs_ffmpeg
def test_real_ffmpeg_an_input_with_audio_still_carries_its_sound(tmp_path):
    src = _make_clip(tmp_path / "withaudio.mp4", audio_tracks=1)
    assert has_audio_stream(_probe(src)) is True

    hls_dir = tmp_path / "hls"
    proc, qualities = _encode_ladder(src, hls_dir, has_audio=True)
    assert proc.returncode == 0, proc.stderr[-1500:]
    assert (hls_dir / "master.m3u8").exists()

    for variant in _variant_dirs(hls_dir, len(qualities)):
        segments = sorted(variant.glob("seg_*.ts"))
        assert segments, f"{variant.name} produced no segments"
        assert sorted(_codec_types(segments[0])) == ["audio", "video"]


@needs_ffmpeg
def test_real_ffmpeg_two_audio_tracks_still_means_the_first_one(tmp_path):
    """`a:0` is one stream, not all of them -- unchanged by this fix."""
    src = _make_clip(tmp_path / "two_tracks.mp4", audio_tracks=2)
    assert _codec_types(src).count("audio") == 2
    assert has_audio_stream(_probe(src)) is True

    hls_dir = tmp_path / "hls"
    proc, _q = _encode_ladder(src, hls_dir, has_audio=True, qualities=["360p"])
    assert proc.returncode == 0, proc.stderr[-1500:]
    segment = sorted((hls_dir / "0").glob("seg_*.ts"))[0]
    assert _codec_types(segment).count("audio") == 1


@needs_ffmpeg
def test_real_ffmpeg_the_variant_directories_are_indices_on_both_paths(tmp_path):
    """`%v` is the variant INDEX, not the quality name -- as it always was.

    Worth pinning rather than assuming: the ladder also mkdir()s `1080p/`,
    `720p/`, `360p/`, which ffmpeg never writes into and which no upload
    ever picks up (only files are uploaded, and those directories stay
    empty). The names a player resolves are the ones inside master.m3u8,
    and this fix touches neither set.
    """
    src = _make_clip(tmp_path / "silent.mp4", audio_tracks=0)
    hls_dir = tmp_path / "hls"
    proc, qualities = _encode_ladder(src, hls_dir, has_audio=False)
    assert proc.returncode == 0, proc.stderr[-1500:]
    written = {d.name for d in hls_dir.iterdir() if d.is_dir() and any(d.iterdir())}
    assert written == {str(i) for i in range(len(qualities))}


@needs_ffmpeg
def test_real_ffmpeg_through_the_transcoder_entry_point(tmp_path, monkeypatch):
    """transcode() itself, end to end, on a real silent file.

    The only stand-in is S3: `generate_presigned_url` hands ffmpeg a local
    path, which it reads exactly as it reads a URL. Everything else --
    probe, audio detection, ladder, thumbnail, the upload walk -- is the
    real thing.
    """
    src = _make_clip(tmp_path / "silent.mp4", audio_tracks=0)

    class _LocalS3(_FakeS3):
        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            return str(src)

    s3 = _LocalS3()
    job = TranscodeJob(
        media_id="m", version_id="v",
        input_s3_key=str(src), output_s3_prefix="processed/p/a/v",
        qualities=["720p", "360p"],
    )
    result = ft.asyncio.run(
        FFmpegTranscoder(s3, "freeframe", "http://s3").transcode(job)
    )

    assert result.success is True, result.error
    assert "processed/p/a/v/master.m3u8" in s3.uploaded
    # One variant per rung, under the index names ffmpeg's `%v` writes.
    for i in range(2):
        assert f"processed/p/a/v/{i}/playlist.m3u8" in s3.uploaded
        assert any(k.startswith(f"processed/p/a/v/{i}/seg_") for k in s3.uploaded)
    assert "processed/p/a/v/thumbnail.jpg" in s3.uploaded
    assert result.width == 640 and result.height == 360


@needs_ffmpeg
def test_real_ffmpeg_a_file_with_audio_still_reaches_the_end(tmp_path):
    """The same entry point, the same assertions, with sound."""
    src = _make_clip(tmp_path / "withaudio.mp4", audio_tracks=1)

    class _LocalS3(_FakeS3):
        def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
            return str(src)

    s3 = _LocalS3()
    job = TranscodeJob(
        media_id="m", version_id="v",
        input_s3_key=str(src), output_s3_prefix="processed/p/a/v",
        qualities=["360p"],
    )
    result = ft.asyncio.run(
        FFmpegTranscoder(s3, "freeframe", "http://s3").transcode(job)
    )
    assert result.success is True, result.error
    assert "processed/p/a/v/master.m3u8" in s3.uploaded
    assert result.technical_metadata.get("audio_codec") == "aac"
