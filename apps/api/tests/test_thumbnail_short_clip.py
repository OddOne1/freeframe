"""Thumbnails must not fail on short clips, and must never cost a transcode.

The bug, found on the production server: the thumbnail command carried a
`fps=0.1` filter, and that filter emits NO FRAMES for a clip shorter than
half its interval -- it rounds `duration/10` to a whole number of output
frames, and anything under 5 s rounds to zero. ffmpeg then opens the mjpeg
encoder on an unconverted pixel format and dies with a complaint about
colour range, which is entirely a red herring:

    [vf#0:0] No filtered frames for output stream, trying to initialize anyway.
    [mjpeg]  Non full-range YUV is non-standard, set strict_std_compliance ...
    [vost#0:0/mjpeg] Error while opening encoder - maybe incorrect parameters ...

exit 234. Measured here against real ffmpeg 7.1.5, and the measurement is
what the constants in the module are set from:

  * 4.0 s and 4.9 s -> 0 frames, exit 234.  5.0 s -> 1 frame. The boundary
    is 5 s, half the interval -- not the ~10 s the symptom suggests.
  * A LIMITED-range ("tv") 4 s clip fails identically, which is what rules
    colour range out as a cause rather than as the error text.
  * On a 64.9 s clip, `fps=0.1 -frames:v 1` yields the frame at t=4.96 s,
    NOT t=0 -- the filter is not a no-op even when one frame is kept. That
    is why the fix keeps the filter for clips long enough to survive it
    instead of deleting it outright: deleting it would silently restyle
    every thumbnail already in the library.

Because the thumbnail was step 5, AFTER the ladder was encoded and uploaded,
a raise here marked the version `failed` and made process_asset re-run the
whole transcode. The tests below pin both halves: the command is right, and
a thumbnail that fails anyway still returns a successful transcode.

The real-ffmpeg tests skip when ffmpeg is absent. They are the only ones
that can prove the bug is actually gone -- a mock can only prove the
command string changed, never that ffmpeg accepts it.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from packages.transcoder.base import TranscodeJob  # noqa: E402
from packages.transcoder import ffmpeg_transcoder as ft  # noqa: E402
from packages.transcoder.ffmpeg_transcoder import (  # noqa: E402
    FFmpegError,
    FFmpegTranscoder,
    MIN_DURATION_FOR_INTERVAL_SECONDS,
    THUMBNAIL_INTERVAL_SECONDS,
    redact_presigned_urls,
    stderr_tail,
    thumbnail_cmd,
)

HAVE_FFMPEG = shutil.which("ffmpeg") is not None
needs_ffmpeg = pytest.mark.skipif(
    not HAVE_FFMPEG,
    reason="needs real ffmpeg: a mock cannot prove ffmpeg accepts the command",
)

#: A presigned URL of the shape this module actually hands ffmpeg.
SIGNED_URL = (
    "https://192.168.1.34:30320/freeframe/raw/p/a/v/CLIP.MXF"
    "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    "&X-Amz-Credential=AKIAEXAMPLE%2F20261009%2Fus-east-1%2Fs3%2Faws4_request"
    "&X-Amz-Signature=7f3c0ddeadbeefcafe0123456789abcdef0123456789abcdef01234567"
    "&X-Amz-Security-Token=TOKENTOKENTOKEN"
)

#: ffmpeg's real words on the reported failure, used so the fallback and
#: redaction tests work against the text this actually has to survive.
REAL_FAILURE_STDERR = (
    f"[in#0 @ 0xaaaa] Opening '{SIGNED_URL}' for reading\n"
    "  Stream #0:0 -> #0:0 (h264 (native) -> mjpeg (native))\n"
    "[vf#0:0 @ 0xaaaa] No filtered frames for output stream, trying to initialize anyway.\n"
    "[mjpeg @ 0xffff] Non full-range YUV is non-standard, set strict_std_compliance "
    "to at most unofficial to use it.\n"
    "[vost#0:0/mjpeg @ 0xaaaa] Error while opening encoder - maybe incorrect "
    "parameters such as bit_rate, rate, width or height.\n"
    "Conversion failed!\n"
)


# ── the command builder ───────────────────────────────────────────────────

def test_single_frame_command_has_no_fps_filter():
    """The whole bug, in one assertion."""
    cmd = thumbnail_cmd(SIGNED_URL, "/t/thumb_%04d.jpg", interval=None, limit=1)
    joined = " ".join(cmd)
    assert "fps=" not in joined, (
        "a single-frame thumbnail must not carry an fps filter: fps=1/N emits "
        "nothing at all for a clip under N/2 seconds, and ffmpeg then fails "
        "with exit 234 while blaming the pixel format"
    )
    assert "-vf" not in cmd
    assert cmd[:4] == ["ffmpeg", "-y", "-i", SIGNED_URL]
    assert "-frames:v" in cmd and cmd[cmd.index("-frames:v") + 1] == "1"
    assert "-q:v" in cmd and cmd[cmd.index("-q:v") + 1] == "2"
    assert cmd[-1] == "/t/thumb_%04d.jpg"


def test_interval_command_keeps_the_historical_sampling():
    """A normal clip's thumbnail must not change appearance.

    `fps=0.1 -frames:v 1` picks t=4.96 s, not t=0 (measured). Dropping the
    filter would move every existing thumbnail to the first frame, so the
    interval form has to stay available and has to stay exactly this.
    """
    cmd = thumbnail_cmd(SIGNED_URL, "/t/thumb_%04d.jpg", interval=10.0, limit=1)
    assert cmd[cmd.index("-vf") + 1] == "fps=0.1"
    # The argument ORDER is what shipped before the fix, so the output is
    # byte-identical rather than merely equivalent.
    assert cmd[4:] == ["-vf", "fps=0.1", "-q:v", "2", "-frames:v", "1", "/t/thumb_%04d.jpg"]


def test_interval_command_without_a_limit_is_the_many_frame_form():
    cmd = thumbnail_cmd(SIGNED_URL, "/t/thumb_%04d.jpg", interval=THUMBNAIL_INTERVAL_SECONDS)
    assert "-frames:v" not in cmd
    assert cmd[cmd.index("-vf") + 1] == "fps=0.1"


def test_interval_is_expressed_as_a_rate_not_a_period():
    """fps= takes frames per second; an interval of 20 s is fps=0.05."""
    cmd = thumbnail_cmd(SIGNED_URL, "/t/o.jpg", interval=20.0)
    assert cmd[cmd.index("-vf") + 1] == "fps=0.05"


def test_fallback_command_is_simpler_and_pins_a_format_mjpeg_accepts():
    cmd = thumbnail_cmd(SIGNED_URL, "/t/thumb_%04d.jpg", interval=None, limit=1, fallback=True)
    assert "-vf" not in cmd
    assert cmd[cmd.index("-map") + 1] == "0:v:0"
    for flag in ("-an", "-sn", "-dn"):
        assert flag in cmd, f"the fallback should ignore non-video streams ({flag})"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuvj420p"
    assert "-frames:v" in cmd


def test_one_builder_is_the_only_place_a_thumbnail_command_is_written():
    """The two call sites drifted once; this is what stops it recurring.

    Structural rather than a substring count over the source: the prose in
    this module names `fps=0.1` and `-q:v` repeatedly while explaining the
    bug, so text matching finds the comments, not the code.
    """
    import ast

    tree = ast.parse(Path(ft.__file__).read_text())
    offenders = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        literals = {
            n.value for n in ast.walk(node)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
        }
        # Every ffmpeg call in this module is a list of literal arguments, so
        # a thumbnail command written anywhere else shows up as these flags
        # appearing inside some other function's body.
        found = literals & {"-vf", "-q:v", "-frames:v", "-pix_fmt"}
        if found and node.name != "thumbnail_cmd":
            offenders[node.name] = sorted(found)
    # build_download_proxy is an MP4 encode, not a thumbnail, and legitimately
    # pins its own pixel format.
    offenders.pop("build_download_proxy", None)
    assert offenders == {}, (
        f"thumbnail/encoder flags written outside thumbnail_cmd(): {offenders}. "
        "Both thumbnail call sites must go through the one builder."
    )
    # And the rate is derived from the interval, never hardcoded.
    builder = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.FunctionDef) and n.name == "thumbnail_cmd"
    )
    import re as _re

    rates = [
        n.value for n in ast.walk(builder)
        if isinstance(n, ast.Constant) and isinstance(n.value, str)
        and _re.match(r"fps=\d", n.value)
    ]
    assert rates == [], (
        f"a literal fps rate is baked into the builder: {rates}. The rate has "
        "to be derived from `interval`, or the two can disagree."
    )


def test_threshold_is_half_the_interval():
    assert MIN_DURATION_FOR_INTERVAL_SECONDS == THUMBNAIL_INTERVAL_SECONDS / 2 == 5.0


# ── URL redaction ─────────────────────────────────────────────────────────

def test_redaction_removes_signature_credential_and_token():
    out = redact_presigned_urls(REAL_FAILURE_STDERR)
    for secret in ("X-Amz-Signature", "7f3c0ddeadbeefcafe", "AKIAEXAMPLE",
                   "X-Amz-Credential", "X-Amz-Security-Token", "TOKENTOKENTOKEN"):
        assert secret not in out, f"{secret} survived redaction"
    # The path is kept: it is what identifies the object.
    assert "raw/p/a/v/CLIP.MXF" in out
    assert "<redacted>" in out
    # Everything that is not a URL is untouched.
    assert "No filtered frames for output stream" in out
    assert "Conversion failed!" in out


def test_redaction_covers_a_scheme_it_has_never_heard_of():
    text = "Opening 'https://host/key?MyOwnSigningScheme=abc123secret' for reading"
    out = redact_presigned_urls(text)
    assert "abc123secret" not in out and "MyOwnSigningScheme" not in out


def test_redaction_handles_several_urls_and_empty_input():
    text = f"a {SIGNED_URL} b https://other/k?Signature=zzz c"
    out = redact_presigned_urls(text)
    assert "zzz" not in out and "7f3c0ddeadbeefcafe" not in out
    assert out.count("<redacted>") == 2
    assert redact_presigned_urls("") == ""
    assert redact_presigned_urls(None) == ""


def test_stderr_tail_redacts_before_trimming():
    """Trimming first could leave a bare signature with no '?' to anchor on."""
    tail = stderr_tail(("x" * 4000) + REAL_FAILURE_STDERR)
    assert len(tail) <= ft.FFMPEG_STDERR_TAIL_CHARS
    assert "7f3c0ddeadbeefcafe" not in tail
    assert "Conversion failed!" in tail


def test_stderr_tail_accepts_bytes():
    assert "Conversion failed!" in stderr_tail(REAL_FAILURE_STDERR.encode())
    assert stderr_tail(None) == ""


# ── failures carry ffmpeg's own words ─────────────────────────────────────

def test_run_ffmpeg_checked_puts_the_stderr_tail_in_the_error(monkeypatch):
    def fake_run(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 234, "", REAL_FAILURE_STDERR)
    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    with pytest.raises(FFmpegError) as exc:
        ft.run_ffmpeg_checked(["ffmpeg", "-i", SIGNED_URL], timeout=5, what="thing")
    msg = str(exc.value)
    assert "exit 234" in msg
    assert "Error while opening encoder" in msg, (
        "an exit code alone is what made this bug take a server to diagnose"
    )
    assert "7f3c0ddeadbeefcafe" not in msg


def test_run_ffmpeg_checked_reports_a_timeout_with_its_output(monkeypatch):
    def fake_run(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, 5, stderr=REAL_FAILURE_STDERR)
    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    with pytest.raises(FFmpegError) as exc:
        ft.run_ffmpeg_checked(["ffmpeg"], timeout=5, what="thing")
    assert "timed out" in str(exc.value) and "Conversion failed!" in str(exc.value)


# ── the fallback path, and failure never costing a transcode ──────────────

class _FakeS3:
    """Enough of a boto3 client for transcode() to run, recording uploads."""

    def __init__(self, fail_thumbnail_upload=False):
        self.uploaded: list[str] = []
        self.fail_thumbnail_upload = fail_thumbnail_upload

    def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
        return SIGNED_URL

    def download_file(self, bucket, key, path):
        raise RuntimeError("no exiftool source in tests")

    def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803
        if self.fail_thumbnail_upload and key.endswith("thumbnail.jpg"):
            raise RuntimeError("storage refused the PUT")
        self.uploaded.append(key)


def _transcoder(**kw):
    return FFmpegTranscoder(_FakeS3(**kw), "freeframe", "http://s3")


def _job():
    return TranscodeJob(
        media_id="m", version_id="v",
        input_s3_key="raw/p/a/v/CLIP.MXF",
        output_s3_prefix="processed/p/a/v",
        qualities=["360p"],
    )


def _probe_json():
    return json.dumps({
        "streams": [{"codec_type": "video", "width": 1920, "height": 1080,
                     "duration": "4.04", "r_frame_rate": "25/1"}],
        "format": {"duration": "4.04"},
    })


def _patch_transcode_env(monkeypatch, thumbnail_runs):
    """Everything in transcode() except the thumbnail step is stubbed out.

    `thumbnail_runs` is called with each ffmpeg thumbnail command and
    returns (returncode, writes_a_file).
    """
    monkeypatch.setattr(
        FFmpegTranscoder, "_run_ffmpeg_with_progress",
        staticmethod(lambda cmd, dur, cb, timeout: None),
    )
    calls: list[list[str]] = []

    def fake_run(cmd, **kw):
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, _probe_json(), "")
        calls.append(list(cmd))
        rc, writes = thumbnail_runs(cmd)
        if writes:
            # The output pattern is the last argument; ffmpeg expands %04d.
            Path(cmd[-1].replace("%04d", "0001")).write_bytes(b"\xff\xd8jpeg")
        return subprocess.CompletedProcess(cmd, rc, "", REAL_FAILURE_STDERR)

    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    return calls


def test_fallback_runs_when_the_primary_command_fails(monkeypatch):
    """One retry, with the simpler command, and it is what succeeds."""
    attempts = {"n": 0}

    def runs(cmd):
        attempts["n"] += 1
        return (0, True) if attempts["n"] == 2 else (234, False)

    calls = _patch_transcode_env(monkeypatch, runs)
    t = _transcoder()
    result = ft.asyncio.run(t.transcode(_job()))

    assert result.success is True
    assert result.thumbnail_keys == ["processed/p/a/v/thumbnail.jpg"]
    assert len(calls) == 2, "exactly one retry"
    assert "-map" in calls[1] and "-pix_fmt" in calls[1], "the retry is the fallback form"
    assert "processed/p/a/v/thumbnail.jpg" in t.s3.uploaded


def test_thumbnail_failure_still_returns_a_successful_transcode(monkeypatch, caplog):
    """The point of the whole fix: finished work is not thrown away."""
    calls = _patch_transcode_env(monkeypatch, lambda cmd: (234, False))
    t = _transcoder()
    with caplog.at_level("WARNING"):
        result = ft.asyncio.run(t.transcode(_job()))

    assert result.success is True, (
        "a failed thumbnail must not fail the transcode: process_asset marks "
        "the version failed on a non-success result and re-runs everything"
    )
    assert result.error is None
    assert result.thumbnail_keys == []
    assert len(calls) == 2, "primary plus exactly one fallback, then give up"
    assert "processed/p/a/v/thumbnail.jpg" not in t.s3.uploaded
    # And it is not silent.
    warnings = "\n".join(r.getMessage() for r in caplog.records if r.levelname == "WARNING")
    assert "Thumbnail generation failed" in warnings
    assert "Error while opening encoder" in warnings, "ffmpeg's reason must be logged"
    assert "7f3c0ddeadbeefcafe" not in warnings, "the presigned URL must be redacted"
    assert "X-Amz-Signature" not in warnings


def test_a_run_that_exits_zero_but_writes_nothing_is_still_a_failure(monkeypatch):
    calls = _patch_transcode_env(monkeypatch, lambda cmd: (0, False))
    result = ft.asyncio.run(_transcoder().transcode(_job()))
    assert result.success is True and result.thumbnail_keys == []
    assert len(calls) == 2


def test_thumbnail_upload_failure_also_keeps_the_transcode(monkeypatch):
    _patch_transcode_env(monkeypatch, lambda cmd: (0, True))
    t = _transcoder(fail_thumbnail_upload=True)
    result = ft.asyncio.run(t.transcode(_job()))
    assert result.success is True and result.thumbnail_keys == []


def test_a_short_clip_skips_the_fps_filter_on_the_first_attempt(monkeypatch):
    """The probe says 4.04 s, so the broken form is never even tried."""
    calls = _patch_transcode_env(monkeypatch, lambda cmd: (0, True))
    result = ft.asyncio.run(_transcoder().transcode(_job()))
    assert result.success is True
    assert len(calls) == 1
    assert "fps=0.1" not in " ".join(calls[0]), (
        "a clip the probe reports as shorter than 5 s must not be handed the "
        "filter that cannot produce a frame for it"
    )


def test_a_normal_clip_still_gets_the_interval_form(monkeypatch):
    """Appearance is preserved for everything that works today."""
    calls = _patch_transcode_env(monkeypatch, lambda cmd: (0, True))
    monkeypatch.setattr(
        ft, "parse_ffprobe_metadata",
        lambda d: {"duration_seconds": 64.9, "width": 1920, "height": 1080, "fps": 25.0},
    )
    result = ft.asyncio.run(_transcoder().transcode(_job()))
    assert result.success is True
    assert "fps=0.1" in " ".join(calls[0])


def test_unknown_duration_tries_the_interval_form_first(monkeypatch):
    calls = _patch_transcode_env(monkeypatch, lambda cmd: (0, True))
    monkeypatch.setattr(ft, "parse_ffprobe_metadata", lambda d: {})
    ft.asyncio.run(_transcoder().transcode(_job()))
    assert "fps=0.1" in " ".join(calls[0])


# ── real ffmpeg ───────────────────────────────────────────────────────────

def _make_clip(path: Path, seconds: float, pix_fmt="yuv422p10le", color_range="pc"):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"testsrc2=size=640x360:rate=25:duration={seconds}",
         "-c:v", "libx264", "-pix_fmt", pix_fmt, "-color_range", color_range, str(path)],
        check=True, capture_output=True, timeout=120,
    )
    return path


@needs_ffmpeg
def test_real_ffmpeg_the_old_command_fails_on_a_short_clip(tmp_path):
    """The regression anchor: prove the broken command is still broken."""
    clip = _make_clip(tmp_path / "short.mp4", 4.04)
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(clip), "-vf", "fps=0.1", "-q:v", "2",
         "-frames:v", "1", str(tmp_path / "old_%04d.jpg")],
        capture_output=True, text=True, timeout=120,
    )
    assert proc.returncode != 0
    assert not list(tmp_path.glob("old_*.jpg"))
    assert "No filtered frames for output stream" in proc.stderr


@needs_ffmpeg
@pytest.mark.parametrize("seconds", [0.5, 1.0, 4.04, 4.9])
def test_real_ffmpeg_short_clips_now_produce_a_thumbnail(tmp_path, seconds):
    clip = _make_clip(tmp_path / f"c{seconds}.mp4", seconds)
    out = tmp_path / "out"
    out.mkdir()
    t = _transcoder()
    got = t._make_thumbnail(str(clip), out, seconds)
    assert got is not None and got.exists() and got.stat().st_size > 0


@needs_ffmpeg
def test_real_ffmpeg_a_short_clip_needs_no_fallback(tmp_path, monkeypatch):
    """The PRIMARY command must work on its own for a short clip.

    Without this, restoring the fps filter still looks fine here: the
    fallback rescues it and a thumbnail appears either way. What would be
    lost is silent -- two ffmpeg runs and two reads of the source over the
    network for every short clip, with the first one guaranteed to fail.
    """
    clip = _make_clip(tmp_path / "s.mp4", 4.04)
    out = tmp_path / "out"
    out.mkdir()
    real_run = subprocess.run
    runs: list[list[str]] = []

    def counting(cmd, **kw):
        runs.append(list(cmd))
        return real_run(cmd, **kw)

    monkeypatch.setattr(ft.subprocess, "run", counting)
    assert _transcoder()._make_thumbnail(str(clip), out, 4.04) is not None
    assert len(runs) == 1, (
        f"a 4.04 s clip took {len(runs)} ffmpeg runs; the command chosen for a "
        "short clip has to succeed first time, not be rescued by the retry"
    )


@needs_ffmpeg
@pytest.mark.parametrize("pix_fmt,color_range", [
    ("yuv422p10le", "pc"),   # the reported Canon MXF shape
    ("yuv420p", "tv"),       # limited range: fails identically today
])
def test_real_ffmpeg_colour_range_is_not_the_cause(tmp_path, pix_fmt, color_range):
    """Both ranges fail at 4 s and both work at 65 s, so duration is the cause."""
    short = _make_clip(tmp_path / "s.mp4", 4.04, pix_fmt, color_range)
    old = subprocess.run(
        ["ffmpeg", "-y", "-i", str(short), "-vf", "fps=0.1", "-q:v", "2",
         "-frames:v", "1", str(tmp_path / "o_%04d.jpg")],
        capture_output=True, timeout=120,
    )
    assert old.returncode != 0, "the old command should fail at 4 s in BOTH ranges"
    out = tmp_path / "out"
    out.mkdir()
    assert _transcoder()._make_thumbnail(str(short), out, 4.04) is not None


@needs_ffmpeg
def test_real_ffmpeg_a_normal_clip_gets_the_identical_frame(tmp_path):
    """Byte-for-byte, so no existing thumbnail changes appearance."""
    clip = _make_clip(tmp_path / "long.mp4", 64.9)
    before = tmp_path / "before_%04d.jpg"
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(clip), "-vf", "fps=0.1", "-q:v", "2",
         "-frames:v", "1", str(before)],
        check=True, capture_output=True, timeout=300,
    )
    out = tmp_path / "out"
    out.mkdir()
    got = _transcoder()._make_thumbnail(str(clip), out, 64.9)
    assert got is not None
    assert got.read_bytes() == (tmp_path / "before_0001.jpg").read_bytes(), (
        "the thumbnail a normal clip gets must be exactly the one it got "
        "before the fix"
    )


@needs_ffmpeg
def test_real_ffmpeg_the_fallback_command_works_on_its_own(tmp_path):
    """Proven independently: the retry is not dead code."""
    for seconds in (4.04, 64.9):
        clip = _make_clip(tmp_path / f"f{seconds}.mp4", seconds)
        pattern = str(tmp_path / f"fb{seconds}_%04d.jpg")
        proc = subprocess.run(
            thumbnail_cmd(str(clip), pattern, interval=None, limit=1, fallback=True),
            capture_output=True, timeout=300,
        )
        assert proc.returncode == 0
        assert (tmp_path / f"fb{seconds}_0001.jpg").exists()


@needs_ffmpeg
def test_real_ffmpeg_generate_thumbnails_gives_a_short_clip_one_frame(tmp_path):
    """One per 10 s -- and a clip under 10 s still owes one."""
    short = _make_clip(tmp_path / "gs.mp4", 4.04)
    long_ = _make_clip(tmp_path / "gl.mp4", 64.9)

    for clip, expected in ((short, 1), (long_, 6)):
        t = FFmpegTranscoder(_FakeS3(), "freeframe", "http://s3")
        t._get_presigned_url = lambda key, expires_in=7200, _c=clip: str(_c)  # noqa: ARG005
        paths = ft.asyncio.run(t.generate_thumbnails("raw/k", 0))
        try:
            assert len(paths) == expected, f"{clip.name}: {len(paths)} frames"
            for p in paths:
                assert Path(p).exists(), (
                    "generate_thumbnails used to delete its own output in a "
                    "finally block before returning the paths"
                )
        finally:
            if paths:
                shutil.rmtree(Path(paths[0]).parent, ignore_errors=True)


@needs_ffmpeg
def test_real_ffmpeg_generate_thumbnails_raises_with_a_reason(tmp_path):
    broken = tmp_path / "broken.mxf"
    broken.write_bytes(b"not a video at all")
    t = FFmpegTranscoder(_FakeS3(), "freeframe", "http://s3")
    t._get_presigned_url = lambda key, expires_in=7200: str(broken)  # noqa: ARG005
    with pytest.raises(FFmpegError) as exc:
        ft.asyncio.run(t.generate_thumbnails("raw/k", 0))
    assert "exit" in str(exc.value) and len(str(exc.value)) > 40
