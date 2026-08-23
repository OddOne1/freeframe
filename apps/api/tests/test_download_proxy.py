"""Persisted 1080p download proxy for heavy sources (CLAUDE.md §57).

The build condition and the export's source selection are pure functions of
data already in hand, and are tested as such. The two integration-shaped
claims — that a qualifying upload writes the key, and that plain 1080p never
reaches ffmpeg — are tested by driving the real functions with ffmpeg, S3 and
the transcoder stubbed, since what is under test is the branching, not
libx264.
"""

import os
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


# ─── the build condition ─────────────────────────────────────────────────────

def result(width=1920, height=1080, bitrate=None):
    return SimpleNamespace(
        width=width,
        height=height,
        technical_metadata={"video_bit_rate": bitrate} if bitrate is not None else {},
    )


def test_a_normal_1080p_source_gets_no_proxy():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    # The whole point: nothing changes for lightweight sources.
    assert _needs_download_proxy(result(bitrate=50_000_000)) is False


def test_high_bitrate_qualifies_at_any_resolution():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    assert _needs_download_proxy(result(bitrate=150_000_000)) is True


def test_the_bitrate_threshold_is_exclusive():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    # 100 Mbit/s exactly is not "> 100".
    assert _needs_download_proxy(result(bitrate=100_000_000)) is False
    assert _needs_download_proxy(result(bitrate=100_000_001)) is True


def test_4k_qualifies_on_a_modest_bitrate():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    assert _needs_download_proxy(result(width=3840, height=2160, bitrate=40_000_000)) is True


def test_a_vertical_4k_source_qualifies_too():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    # Compared against the LONGER edge: 2160x3840 is exactly as heavy as
    # 3840x2160, and testing width alone would quietly exclude it.
    assert _needs_download_proxy(result(width=2160, height=3840)) is True


def test_missing_metadata_does_not_qualify_or_explode():
    from apps.api.tasks.transcode_tasks import _needs_download_proxy
    # A format ffprobe could not read a bitrate from must not be treated as
    # heavy on a guess.
    assert _needs_download_proxy(SimpleNamespace(width=None, height=None, technical_metadata=None)) is False
    assert _needs_download_proxy(result(bitrate="not-a-number")) is False


# ─── which file an export reads ──────────────────────────────────────────────

def media(proxy="proxies/p/a/v/1080p.mp4", raw="raw/p/a/v/original.mov"):
    return SimpleNamespace(proxy_1080p_key=proxy, s3_key_raw=raw)


@pytest.mark.parametrize("variant_name", ["proxy_720p", "proxy_720p_lut", "proxy_1080p_lut", "proxy_1080p"])
def test_proxy_variants_read_the_persisted_proxy_when_there_is_one(variant_name):
    from apps.api.models.share import DownloadVariant
    from apps.api.tasks.lut_tasks import _export_source_key
    variant = DownloadVariant(variant_name)
    assert _export_source_key(variant, media()) == "proxies/p/a/v/1080p.mp4"


@pytest.mark.parametrize("variant_name", ["raw", "raw_lut"])
def test_raw_variants_always_read_the_original(variant_name):
    from apps.api.models.share import DownloadVariant
    from apps.api.tasks.lut_tasks import _export_source_key
    # "The original, graded" has to mean the original.
    variant = DownloadVariant(variant_name)
    assert _export_source_key(variant, media()) == "raw/p/a/v/original.mov"


@pytest.mark.parametrize(
    "variant_name", ["raw", "raw_lut", "proxy_720p", "proxy_720p_lut", "proxy_1080p", "proxy_1080p_lut"]
)
def test_without_a_proxy_every_variant_reads_the_original(variant_name):
    from apps.api.models.share import DownloadVariant
    from apps.api.tasks.lut_tasks import _export_source_key
    # Zero behaviour change for an asset that never qualified.
    variant = DownloadVariant(variant_name)
    assert _export_source_key(variant, media(proxy=None)) == "raw/p/a/v/original.mov"


def test_the_export_argv_is_unchanged_by_where_the_input_came_from():
    from apps.api.models.share import DownloadVariant
    from apps.api.tasks.lut_tasks import _build_export_command
    a = _build_export_command(DownloadVariant.proxy_720p, "http://proxy", None, "/tmp/o.mp4")
    b = _build_export_command(DownloadVariant.proxy_720p, "http://raw", None, "/tmp/o.mp4")
    # Same settings either way — which is what makes chaining safe: the
    # proxy was encoded with the ladder the export would have used.
    assert a[a.index("http://proxy") + 1:] == b[b.index("http://raw") + 1:]


# ─── the upload path actually builds and records it ──────────────────────────

class _FakeTranscoder:
    """Stands in for FFmpegTranscoder. What is under test is the branching in
    _process_video, not libx264."""

    instances: list["_FakeTranscoder"] = []

    def __init__(self, *_args, **_kwargs):
        self.proxy_calls: list[tuple[str, str]] = []
        _FakeTranscoder.instances.append(self)

    async def transcode(self, job, progress_callback=None):
        from packages.transcoder.base import TranscodeResult
        return _FakeTranscoder.next_result

    def build_download_proxy(self, input_key, output_key):
        self.proxy_calls.append((input_key, output_key))


@pytest.fixture
def fake_transcoder(monkeypatch):
    from packages.transcoder import ffmpeg_transcoder
    _FakeTranscoder.instances = []
    monkeypatch.setattr(ffmpeg_transcoder, "FFmpegTranscoder", _FakeTranscoder)
    return _FakeTranscoder


def run_process_video(fake, transcode_result):
    from apps.api.tasks import transcode_tasks
    from packages.transcoder.base import TranscodeResult
    fake.next_result = transcode_result

    db = MagicMock()
    asset = SimpleNamespace(id=uuid.uuid4(), project_id=uuid.uuid4())
    version = SimpleNamespace(id=uuid.uuid4())
    media_file = SimpleNamespace(
        s3_key_raw="raw/pfx/a/v/original.mov",
        s3_key_processed=None, s3_key_thumbnail=None,
        width=None, height=None, duration_seconds=None, fps=None,
        technical_metadata=None, proxy_1080p_key=None,
    )
    transcode_tasks._process_video(
        db, asset, version, media_file, MagicMock(),
        "processed/pfx/a/v",
    )
    return media_file


def ok_result(**kw):
    from packages.transcoder.base import TranscodeResult
    return TranscodeResult(success=True, hls_prefix="processed/pfx/a/v", **kw)


def test_a_heavy_source_gets_a_proxy_built_and_recorded(fake_transcoder, monkeypatch):
    from apps.api.tasks import transcode_tasks
    monkeypatch.setattr(transcode_tasks, "_publish_event", lambda *a, **k: None)

    media_file = run_process_video(
        fake_transcoder,
        ok_result(width=3840, height=2160, technical_metadata={"video_bit_rate": 40_000_000}),
    )

    fake = fake_transcoder.instances[-1]
    assert fake.proxy_calls == [("raw/pfx/a/v/original.mov", "proxies/pfx/a/v/1080p.mp4")]
    assert media_file.proxy_1080p_key == "proxies/pfx/a/v/1080p.mp4"
    # Same tail as the HLS output, under its own area — which is what lets
    # purge delete it by prefix.
    assert media_file.s3_key_processed == "processed/pfx/a/v"


def test_a_light_source_gets_none(fake_transcoder, monkeypatch):
    from apps.api.tasks import transcode_tasks
    monkeypatch.setattr(transcode_tasks, "_publish_event", lambda *a, **k: None)

    media_file = run_process_video(
        fake_transcoder,
        ok_result(width=1920, height=1080, technical_metadata={"video_bit_rate": 20_000_000}),
    )
    assert fake_transcoder.instances[-1].proxy_calls == []
    assert media_file.proxy_1080p_key is None


def test_a_failed_proxy_does_not_fail_the_upload(fake_transcoder, monkeypatch):
    from apps.api.tasks import transcode_tasks
    monkeypatch.setattr(transcode_tasks, "_publish_event", lambda *a, **k: None)

    def boom(self, *_):
        raise RuntimeError("ffmpeg died")

    monkeypatch.setattr(_FakeTranscoder, "build_download_proxy", boom, raising=False)

    # Playback is already complete and correct by this point; the only
    # consequence of no proxy is that downloads re-encode from the original,
    # which is what every non-qualifying asset does anyway.
    media_file = run_process_video(fake_transcoder, ok_result(width=3840, height=2160))
    assert media_file.proxy_1080p_key is None
    assert media_file.s3_key_processed == "processed/pfx/a/v"


# ─── plain 1080p is served, not re-encoded ───────────────────────────────────

def test_plain_1080p_with_a_proxy_never_invokes_ffmpeg(monkeypatch):
    from apps.api.tasks import lut_tasks
    from apps.api.models.share import DownloadVariant

    ran = []
    monkeypatch.setattr(lut_tasks.subprocess, "run", lambda *a, **k: ran.append(a))

    copies = []
    client = MagicMock()
    client.copy_object.side_effect = lambda **kw: copies.append(kw)
    monkeypatch.setattr(lut_tasks.s3_service, "get_s3_client", lambda: client)

    presigned = _run_export(
        monkeypatch, lut_tasks, DownloadVariant.proxy_1080p, proxy="proxies/p/a/v/1080p.mp4"
    )

    assert ran == []
    # Not even a presigned URL was minted: the export never went near ffmpeg.
    assert presigned == []
    assert len(copies) == 1
    assert copies[0]["CopySource"]["Key"] == "proxies/p/a/v/1080p.mp4"
    # The copy is what gets TTL-deleted. The permanent proxy must not be.
    assert copies[0]["Key"].startswith("lut-exports/")


def test_plain_1080p_without_a_proxy_still_re_encodes(monkeypatch):
    from apps.api.tasks import lut_tasks
    from apps.api.models.share import DownloadVariant

    ran = []
    monkeypatch.setattr(lut_tasks.subprocess, "run", lambda *a, **k: ran.append(a[0]))
    client = MagicMock()
    monkeypatch.setattr(lut_tasks.s3_service, "get_s3_client", lambda: client)

    _run_export(monkeypatch, lut_tasks, DownloadVariant.proxy_1080p, proxy=None)

    assert len(ran) == 1
    client.copy_object.assert_not_called()


def test_720p_with_a_proxy_still_re_encodes_but_from_the_proxy(monkeypatch):
    from apps.api.tasks import lut_tasks
    from apps.api.models.share import DownloadVariant

    ran = []
    monkeypatch.setattr(lut_tasks.subprocess, "run", lambda *a, **k: ran.append(a[0]))
    client = MagicMock()
    monkeypatch.setattr(lut_tasks.s3_service, "get_s3_client", lambda: client)

    presigned = _run_export(
        monkeypatch, lut_tasks, DownloadVariant.proxy_720p, proxy="proxies/p/a/v/1080p.mp4"
    )

    assert len(ran) == 1
    # Downscaling from the proxy, not decoding the 6K original again.
    assert presigned == ["proxies/p/a/v/1080p.mp4"]
    client.copy_object.assert_not_called()


def test_a_lut_variant_is_never_served_as_the_stored_file(monkeypatch):
    """The stored proxy is UNGRADED. Handing it back for a *_lut variant
    would deliver a file that is not what its label says — the failure mode
    this codebase's LUT work treats as the one that matters, because it
    looks plausible."""
    from apps.api.tasks import lut_tasks
    from apps.api.models.share import DownloadVariant

    ran = []
    monkeypatch.setattr(lut_tasks.subprocess, "run", lambda *a, **k: ran.append(a[0]))
    client = MagicMock()
    monkeypatch.setattr(lut_tasks.s3_service, "get_s3_client", lambda: client)

    presigned = _run_export(
        monkeypatch, lut_tasks, DownloadVariant.proxy_1080p_lut,
        proxy="proxies/p/a/v/1080p.mp4", with_lut=True,
    )

    client.copy_object.assert_not_called()
    assert len(ran) == 1
    # It reads the proxy — chaining is fine, a LUT is resolution-independent —
    # but it still has to burn the grade.
    assert presigned == ["proxies/p/a/v/1080p.mp4"]
    assert any("lut3d" in str(arg) for arg in ran[0])


def _run_export(monkeypatch, lut_tasks, variant, proxy, with_lut=False):
    """Drive the real burn_lut_export with everything external stubbed.

    Returns the keys that were presigned as ffmpeg input — empty when the
    export never reached ffmpeg at all.
    """
    asset = SimpleNamespace(
        id=uuid.uuid4(), project_id=uuid.uuid4(), name="Clip",
    )
    version = SimpleNamespace(id=uuid.uuid4())
    media_file = SimpleNamespace(
        version_id=version.id,
        s3_key_raw="raw/p/a/v/original.mov",
        proxy_1080p_key=proxy,
        original_filename="original.mov",
    )

    lut = SimpleNamespace(id=uuid.uuid4(), s3_key="luts/x.cube", name="Kodak") if with_lut else None

    db = MagicMock()

    def query(model):
        q = MagicMock()
        name = getattr(model, "__name__", "")
        q.filter.return_value.first.return_value = {
            "Asset": asset, "AssetVersion": version, "MediaFile": media_file, "Lut": lut,
        }.get(name)
        return q

    db.query.side_effect = query
    monkeypatch.setattr(lut_tasks, "SessionLocal", lambda: db)
    monkeypatch.setattr(lut_tasks, "_publish_event", lambda *a, **k: None)
    monkeypatch.setattr(lut_tasks.delete_lut_export, "apply_async", lambda *a, **k: None)
    monkeypatch.setattr(
        lut_tasks, "build_download_filename", lambda *a, **k: "Clip.mp4", raising=False,
    )
    presigned: list[str] = []
    monkeypatch.setattr(
        lut_tasks,
        "_presigned_input_url",
        lambda key: (presigned.append(key), f"http://signed/{key}")[1],
    )

    if with_lut:
        # The .cube genuinely has to exist on disk — ffmpeg's lut3d filter
        # takes a path — and the real download is stubbed, so write one.
        real_client = MagicMock()
        real_client.download_file.side_effect = lambda _b, _k, dest: open(dest, "w").write("LUT_3D_SIZE 2\n")
        monkeypatch.setattr(lut_tasks, "get_s3_client", lambda: real_client)

    lut_tasks.burn_lut_export(
        str(asset.id), str(version.id),
        str(lut.id) if with_lut else "",
        str(uuid.uuid4()), variant.value,
    )
    return presigned
