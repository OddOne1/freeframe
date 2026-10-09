"""The input URL has to outlive the work that reads it (§221).

`transcode()` presigned the original ONCE, with a hardcoded 7200s expiry,
and then used that single URL for the ffprobe pass, the HLS ladder — whose
own ffmpeg ceiling is 14400, twice the expiry on its own — and finally the
thumbnail, which runs only after the ladder has been encoded AND uploaded.

Measured on the live server: two 95+ GiB MXF masters encoded for ~2 h,
uploaded for ~21 min, and then died with `ffmpeg ... returned non-zero exit
status 8` against `Expires=<task start + 7200>`. Everything expensive was
already finished and correct; `process_asset` threw it away and retried the
whole transcode. The ladder itself had cleared its expiry by about forty
seconds, so a marginally slower file would have failed mid-encode instead.

Two independent things are therefore asserted here, and they fail
differently:

  * the configured expiry covers the worst sequence one URL must survive —
    derived from the timeouts in the source, reusing §219 item 7's survey
    rather than a second hand-written list;
  * the stages that run AFTER a long stage get a FRESH signature, asserted
    by call ORDER against a fake S3, because an expiry that is merely large
    is still a clock the next slower file can outrun.

§218's rule is unchanged and re-checked: `_make_thumbnail` still never
raises, so a thumbnail that fails for any reason — expired link included —
costs a jpeg and not a ladder.
"""

import ast
import json
import re
import subprocess
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from packages.transcoder import ffmpeg_transcoder as ft
from packages.transcoder.base import TranscodeJob
from packages.transcoder.ffmpeg_transcoder import (
    DEFAULT_URL_EXPIRY_SECONDS,
    MAX_PRESIGN_EXPIRY_SECONDS,
    FFmpegTranscoder,
)

API = Path(__file__).resolve().parents[1]
REPO = API.parents[1]
TRANSCODER_SRC = REPO / "packages" / "transcoder" / "ffmpeg_transcoder.py"


# ── the bound, derived from the source ─────────────────────────────────────


def _worst_url_lifetime_seconds() -> int:
    """The bounded work one `transcode()` URL has to survive.

    Reuses §219 item 7's own survey of long timeouts (test_celery_wiring)
    rather than restating the numbers, so there is one place in the test
    suite that knows what the ffmpeg ceilings are.

    Only the stages with an actual timeout can be summed. The EXIF full-file
    download and the HLS ladder upload have none at all — they are bounded
    by bytes and bandwidth, not by a clock — which is exactly why the
    setting needs headroom above this figure rather than equalling it.
    """
    from apps.api.tests.test_celery_wiring import _long_subprocess_timeouts

    long_timeouts = _long_subprocess_timeouts()
    ladder = max(
        v for k, v in long_timeouts.items() if k.startswith("ffmpeg_transcoder.py")
    )

    src = TRANSCODER_SRC.read_text()
    # The probe that runs before the ladder, on the same URL. Pinned to the
    # exact call rather than "the largest small timeout in the file", which
    # would silently pick up the thumbnail's 600 instead.
    probe = re.search(
        r"probe_result = subprocess\.run\(probe_cmd.*?timeout=(\d+)\)", src
    )
    assert probe, "could not find transcode()'s own ffprobe timeout"
    # One thumbnail ATTEMPT, inside _make_thumbnail; there are two attempts.
    thumb = re.search(
        r"proc = subprocess\.run\(cmd, capture_output=True, timeout=(\d+)\)", src
    )
    assert thumb, "could not find _make_thumbnail's per-attempt timeout"
    return ladder + int(probe.group(1)) + 2 * int(thumb.group(1))


def test_the_derived_bound_is_the_shape_we_think_it_is():
    """Guards the derivation. If the scan silently found nothing, every
    bound below would be trivially satisfied."""
    bound = _worst_url_lifetime_seconds()
    # 14400 ladder + 120 probe + 2x600 thumbnail.
    assert bound == 15720, (
        f"the derived worst-case bounded lifetime is {bound}s; the ceilings "
        f"in the transcoder have moved, so re-check the setting"
    )


def test_the_default_expiry_covers_the_worst_bounded_sequence():
    """The old 7200 did not even cover the ladder alone."""
    assert DEFAULT_URL_EXPIRY_SECONDS >= _worst_url_lifetime_seconds()


def test_the_default_expiry_leaves_room_for_the_two_untimed_phases():
    """The EXIF download and the ladder upload have no ceiling to derive.

    The incident's own numbers are the evidence that they are not small: a
    ~21 minute upload, on top of a full-size download of a 95 GiB original.
    So the setting has to exceed the bounded figure by a real margin, not
    merely clear it.
    """
    bound = _worst_url_lifetime_seconds()
    assert DEFAULT_URL_EXPIRY_SECONDS >= 2 * bound, (
        f"{DEFAULT_URL_EXPIRY_SECONDS}s leaves only "
        f"{DEFAULT_URL_EXPIRY_SECONDS - bound}s for a full-size download and "
        f"a multi-GB upload, neither of which has a timeout to bound it"
    )


def test_the_configured_setting_also_covers_the_bound():
    """Against the resolved setting, env override included — lowering
    TRANSCODE_URL_EXPIRY_SECONDS reintroduces the incident."""
    from apps.api.config import settings

    assert settings.transcode_url_expiry_seconds >= _worst_url_lifetime_seconds()


def test_the_setting_stays_within_the_sigv4_ceiling():
    """SigV4 allows 1..604800 (7 days) because the signing key is only valid
    that long; MinIO/AIStor follow S3 here. A larger value is rejected at
    signing time, so it would break every transcode rather than extend one.
    """
    from apps.api.config import settings

    assert MAX_PRESIGN_EXPIRY_SECONDS == 604800
    assert 0 < settings.transcode_url_expiry_seconds <= MAX_PRESIGN_EXPIRY_SECONDS
    assert 0 < DEFAULT_URL_EXPIRY_SECONDS <= MAX_PRESIGN_EXPIRY_SECONDS


def test_the_url_expiry_matches_the_celery_visibility_timeout():
    """Two ends of one bound: a task that may run for N seconds needs input
    readable for N seconds. They are allowed to differ, but the URL must not
    be the shorter of the two — that is the §221 bug in a new place."""
    from apps.api.config import settings

    assert settings.transcode_url_expiry_seconds >= \
        settings.celery_visibility_timeout_seconds, (
            "the input URL expires before Celery would still let the task run"
        )


# ── no call site may carry a literal ───────────────────────────────────────


def _presign_calls() -> dict:
    """{line -> the rendered call} for every `_get_presigned_url(...)`."""
    out = {}
    for node in ast.walk(ast.parse(TRANSCODER_SRC.read_text())):
        if isinstance(node, ast.Call) and \
                ast.unparse(node.func).endswith("_get_presigned_url"):
            out[node.lineno] = ast.unparse(node)
    return out


def test_no_presign_call_site_hardcodes_an_expiry():
    """THE static guard, and the reason it is written as a scan.

    The literal that caused this was `expires_in=7200` at one call site,
    invisible from anywhere a reader would look for a timeout. A new call
    site that passes its own number must fail here rather than wait for a
    file slow enough to expose it.
    """
    calls = _presign_calls()
    assert calls, "found no _get_presigned_url call sites — the scan is broken"

    literal = {}
    for line, rendered in calls.items():
        for node in ast.walk(ast.parse(rendered, mode="eval")):
            if not isinstance(node, ast.keyword) or node.arg != "expires_in":
                continue
            if isinstance(node.value, ast.Constant):
                literal[line] = rendered
    assert not literal, (
        f"presign call site(s) with a hardcoded expiry: {literal}. The "
        f"expiry belongs in TRANSCODE_URL_EXPIRY_SECONDS, not in the "
        f"pipeline."
    )


def test_the_expiry_resolves_from_the_instance_not_a_default_literal():
    """`_get_presigned_url`'s own default must be the configured value, so a
    call site that passes nothing still gets it."""
    src = TRANSCODER_SRC.read_text()
    assert re.search(
        r"def _get_presigned_url\(self, s3_key: str, expires_in: int = None",
        src,
    ), "the parameter default should be None, resolved from the instance"
    assert "self.url_expiry_seconds if expires_in is None else expires_in" in src


def test_the_task_passes_the_setting_into_the_transcoder():
    """The package imports nothing from apps.api by design, so the number
    only arrives if the caller hands it over."""
    task_src = (API / "tasks" / "transcode_tasks.py").read_text()
    assert "url_expiry_seconds=settings.transcode_url_expiry_seconds" in task_src


def test_a_transcoder_built_without_an_expiry_still_gets_the_long_default():
    """lut_tasks and the test suite construct this with three positional
    args; none of them may silently fall back to two hours."""
    t = FFmpegTranscoder(MagicMock(), "bucket", "http://s3")
    assert t.url_expiry_seconds == DEFAULT_URL_EXPIRY_SECONDS


def test_the_presign_log_states_the_expiry_and_never_the_url(caplog):
    """§221 item 4. The next incident has to be readable from the worker log
    — and the URL carries the signature, so it must not be in it."""
    s3 = MagicMock()
    s3.generate_presigned_url.return_value = "https://store/obj?X-Amz-Signature=deadbeef"
    t = FFmpegTranscoder(s3, "bucket", "http://s3", url_expiry_seconds=43200)

    with caplog.at_level("WARNING"):
        url = t._get_presigned_url("raw/p/a/v/CLIP.MXF", stage="probe + HLS ladder")

    messages = [r.getMessage() for r in caplog.records]
    assert any("43200" in m for m in messages), (
        f"the expiry is not in the log: {messages}"
    )
    assert any("CLIP.MXF" in m for m in messages), "the key is not in the log"
    assert not any("X-Amz-Signature" in m or url in m for m in messages), (
        f"the signed URL leaked into the log: {messages}"
    )


# ── call order: the later stages get a fresh signature ─────────────────────


SIGNED = "https://store/obj?X-Amz-Expires=43200&X-Amz-Signature=sig"


class _OrderedFakeS3:
    """Records every presign and transfer in the order they happen.

    Order is the whole assertion. An expiry of 12 hours and a URL reused
    across 12 hours of work are indistinguishable from each other by value;
    only the sequence shows whether the thumbnail got its own signature
    after the upload finished, which is what makes the fix robust rather
    than merely roomier.
    """

    def __init__(self):
        self.events: list[tuple[str, object]] = []
        self.presign_expiries: list[int] = []

    def generate_presigned_url(self, op, Params, ExpiresIn):  # noqa: N803
        self.presign_expiries.append(ExpiresIn)
        n = len(self.presign_expiries)
        self.events.append(("presign", Params["Key"]))
        return f"{SIGNED}&n={n}"

    def download_file(self, bucket, key, path, **_kw):
        self.events.append(("download", key))
        raise RuntimeError("no exiftool source in tests")

    def upload_file(self, path, bucket, key, ExtraArgs=None, **_kw):  # noqa: N803
        self.events.append(("upload", key))


def _write_one_segment(cmd) -> None:
    """Leave one segment behind, so the upload loop has something to push.

    The output directory is read off `-hls_segment_filename`, NOT off
    `cmd[-1]`: the command ends with `-progress pipe:1 -nostats`, so the
    last element is a flag. Taking it as a path silently resolves to the
    process's cwd, which here is a read-only mount — and the resulting
    OSError is swallowed by transcode()'s own `except`, surfacing as
    `success=False` with the real cause buried in the result's error string.
    """
    seg = cmd[cmd.index("-hls_segment_filename") + 1]
    # <hls>/<%v>/seg_%03d.ts -> <hls>; the real code has already created one
    # subdirectory per quality under it.
    hls_dir = Path(seg).parent.parent
    for child in sorted(hls_dir.iterdir()):
        if child.is_dir():
            (child / "seg_000.ts").write_bytes(b"ts")


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
                     "duration": "120.0", "r_frame_rate": "25/1"}],
        "format": {"duration": "120.0"},
    })


@pytest.fixture
def ffmpeg_world(monkeypatch):
    """transcode() with every subprocess faked, recording the URL each
    ffmpeg command was given."""
    seen = {"ladder": None, "thumbnail": [], "order": []}

    def fake_run(cmd, **_kw):
        if cmd[0] == "ffprobe":
            seen["order"].append("ffprobe")
            return subprocess.CompletedProcess(cmd, 0, _probe_json(), "")
        # Every other subprocess.run in this path is a thumbnail attempt.
        seen["order"].append("thumbnail")
        seen["thumbnail"].append(cmd[cmd.index("-i") + 1])
        Path(cmd[-1].replace("%04d", "0001")).write_bytes(b"\xff\xd8jpeg")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    def fake_ladder(cmd, total_duration, progress_callback, timeout,
                    heartbeat_callback=None):
        seen["order"].append("ladder")
        seen["ladder"] = cmd[cmd.index("-i") + 1]
        _write_one_segment(cmd)

    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    monkeypatch.setattr(
        FFmpegTranscoder, "_run_ffmpeg_with_progress", staticmethod(fake_ladder),
    )
    return seen


def test_the_thumbnail_is_presigned_after_the_ladder_and_the_upload(ffmpeg_world):
    """The exact sequence that failed, now asserted.

    A second presign that happened BEFORE the upload would be just as stale
    by the time ffmpeg read it, so "there are two presigns" is not the
    assertion — "the second one comes after the last upload" is.
    """
    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3", url_expiry_seconds=43200)
    result = ft.asyncio.run(t.transcode(_job()))
    assert result.success is True

    kinds = [k for k, _ in s3.events]
    assert kinds.count("presign") == 2, (
        f"expected one presign for the ladder and one for the thumbnail, got "
        f"{s3.events}"
    )
    first_presign = kinds.index("presign")
    second_presign = max(i for i, k in enumerate(kinds) if k == "presign")
    # The LADDER's uploads, not every upload: the thumbnail's own PUT
    # necessarily follows its presign, and counting it here would make this
    # assertion unsatisfiable no matter how correct the code is.
    ladder_uploads = [
        i for i, (kind, key) in enumerate(s3.events)
        if kind == "upload" and not str(key).endswith("thumbnail.jpg")
    ]
    assert ladder_uploads, f"the ladder uploaded nothing: {s3.events}"
    assert first_presign < max(ladder_uploads) < second_presign, (
        f"the thumbnail's URL was not signed after the ladder upload: {s3.events}"
    )


def test_the_ladder_and_the_thumbnail_do_not_share_a_url(ffmpeg_world):
    """The bug itself: one signature serving both."""
    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3", url_expiry_seconds=43200)
    ft.asyncio.run(t.transcode(_job()))

    assert ffmpeg_world["ladder"], "the ladder never ran"
    assert ffmpeg_world["thumbnail"], "the thumbnail never ran"
    assert ffmpeg_world["ladder"] != ffmpeg_world["thumbnail"][0], (
        "the thumbnail reused the ladder's URL, which is the §221 failure"
    )
    # And the ladder keeps the one it STARTED with: an open ffmpeg
    # connection must not have its input swapped mid-run.
    assert ffmpeg_world["ladder"].endswith("&n=1")
    assert ffmpeg_world["thumbnail"][0].endswith("&n=2")


def test_both_stages_are_signed_with_the_configured_expiry(ffmpeg_world):
    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3", url_expiry_seconds=43200)
    ft.asyncio.run(t.transcode(_job()))

    assert s3.presign_expiries == [43200, 43200], (
        f"a stage was signed with something other than the configured "
        f"expiry: {s3.presign_expiries}"
    )


def test_the_ladder_runs_before_the_thumbnail_at_all(ffmpeg_world):
    """Guards the fixture: if the ladder were never reached, the order
    assertions above would be vacuous."""
    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3")
    ft.asyncio.run(t.transcode(_job()))
    assert ffmpeg_world["order"].index("ladder") < \
        ffmpeg_world["order"].index("thumbnail")


def test_an_expired_thumbnail_link_still_cannot_fail_the_transcode(monkeypatch):
    """§218, unchanged and re-checked.

    Even with every thumbnail attempt failing the way an expired URL does
    (ffmpeg exit 8), the ladder is already encoded and uploaded, so the
    result must still be a success with no thumbnail — not the discarded
    ladder this incident actually produced.
    """
    def fake_run(cmd, **_kw):
        if cmd[0] == "ffprobe":
            return subprocess.CompletedProcess(cmd, 0, _probe_json(), "")
        return subprocess.CompletedProcess(cmd, 8, "", b"HTTP error 403 Forbidden")

    def fake_ladder(cmd, total_duration, progress_callback, timeout,
                    heartbeat_callback=None):
        _write_one_segment(cmd)

    monkeypatch.setattr(ft.subprocess, "run", fake_run)
    monkeypatch.setattr(
        FFmpegTranscoder, "_run_ffmpeg_with_progress", staticmethod(fake_ladder),
    )

    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3")
    result = ft.asyncio.run(t.transcode(_job()))

    assert result.success is True, (
        "a failed thumbnail discarded a finished ladder — the §218 rule"
    )
    assert result.thumbnail_keys == []
    assert result.hls_prefix == "processed/p/a/v"


# ── the download proxy signs its own ───────────────────────────────────────


def test_the_download_proxy_presigns_its_own_url(monkeypatch):
    """It runs after a full ladder encode AND upload, so any URL inherited
    from transcode() would already be hours old — and its own ffmpeg carries
    a 14400s ceiling on top of that."""
    ran = {}

    def fake_checked(cmd, timeout=None, what=None):
        ran["url"] = cmd[cmd.index("-i") + 1]
        ran["timeout"] = timeout
        Path(cmd[-1]).write_bytes(b"mp4")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(ft, "run_ffmpeg_checked", fake_checked)

    s3 = _OrderedFakeS3()
    t = FFmpegTranscoder(s3, "freeframe", "http://s3", url_expiry_seconds=43200)
    t.build_download_proxy("raw/p/a/v/CLIP.MXF", "proxies/p/a/v/1080p.mp4")

    assert s3.presign_expiries == [43200], (
        f"the proxy did not sign exactly one URL of its own: "
        f"{s3.presign_expiries}"
    )
    assert ran["url"].startswith(SIGNED)
    # Its own ceiling must also fit inside the expiry it was handed.
    assert ran["timeout"] <= 43200


def test_the_proxy_url_is_signed_for_at_least_its_own_ffmpeg_ceiling():
    """A fresh URL that still expires before the encode it feeds would be
    the same bug with an extra step."""
    from apps.api.config import settings
    from apps.api.tests.test_celery_wiring import _long_subprocess_timeouts

    proxy_ceiling = max(
        v for k, v in _long_subprocess_timeouts().items()
        if k.startswith("ffmpeg_transcoder.py")
    )
    assert settings.transcode_url_expiry_seconds >= proxy_ceiling
