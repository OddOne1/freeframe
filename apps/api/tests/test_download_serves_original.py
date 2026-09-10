"""A download hands back the ORIGINAL upload, never a display derivative (§141).

`s3_key_processed` is what the viewer shows: a WebP for an image, an mp3
for audio, an HLS prefix for video. The video branch already understood
that and preferred `s3_key_raw` on download. The other branch did not, so
downloading a TIFF or a WAV silently returned the re-encoded preview —
under a filename claiming to be the original, which is what makes it a
correctness bug rather than a preference.

Both routers are exercised because the identical branch is written out
twice, in share.py and assets.py. A test covering one would not have
caught the other, which is how they drifted into agreeing on the bug.
"""
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.asset import AssetType


RAW = "raw/project/asset/original.tiff"
PROCESSED = "processed/project/asset/preview.webp"


def _media_file(raw=RAW, processed=PROCESSED, original_filename="original.tiff"):
    mf = MagicMock()
    mf.s3_key_raw = raw
    mf.s3_key_processed = processed
    mf.s3_key_thumbnail = None
    mf.original_filename = original_filename
    mf.version_id = uuid.uuid4()
    mf.duration_seconds = None
    return mf


def _asset(asset_type=AssetType.image, name="A Photo"):
    a = MagicMock()
    a.id = uuid.uuid4()
    a.name = name
    a.asset_type = asset_type
    a.deleted_at = None
    a.project_id = uuid.uuid4()
    return a


# The key actually handed to the proxy is the whole point, so capture it
# rather than asserting on the opaque token the real function returns.
def _capture_proxy(monkeypatch_target):
    calls = []

    def fake(s3_key, expires_hours=24, download_filename=None):
        calls.append({"s3_key": s3_key, "download_filename": download_filename})
        return f"/stream/hls/{s3_key.rsplit('/', 1)[-1]}?token=fake"

    return calls, fake


# ── share.py ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("asset_type", [AssetType.image, AssetType.audio])
def test_share_download_serves_the_raw_original(client, mock_db, asset_type):
    from apps.api.routers import share

    calls, fake = _capture_proxy(share)
    asset = _asset(asset_type)
    with patch.object(share, "proxy_url_for", fake), \
         patch.object(share, "validate_share_link_with_session") as v, \
         patch.object(share, "_get_asset", return_value=asset), \
         patch.object(share, "_validate_asset_in_share"), \
         patch.object(share, "_require_download_variant"), \
         patch.object(share, "_log_share_activity"), \
         patch.object(share, "_get_latest_media_file", return_value=_media_file()):
        link = MagicMock()
        link.id = uuid.uuid4()
        v.return_value = link
        out = share.get_share_stream_url(
            token="t", asset_id=asset.id, share_session=None, download=True,
            variant=share.DownloadVariant.raw, db=mock_db, current_user=None,
        )

    assert calls, "proxy_url_for was never called"
    assert calls[-1]["s3_key"] == RAW, (
        f"download served {calls[-1]['s3_key']!r}, not the original"
    )
    # The filename must describe what is actually being sent.
    assert calls[-1]["download_filename"].endswith(".tiff")
    assert out["url"].startswith("/stream/hls/")


@pytest.mark.parametrize("asset_type", [AssetType.image, AssetType.audio])
def test_share_view_still_prefers_the_processed_derivative(client, mock_db, asset_type):
    """The fix must not make viewing serve the original.

    A viewer asking for a 60MB TIFF instead of its WebP would be a worse
    regression than the bug being fixed.
    """
    from apps.api.routers import share

    calls, fake = _capture_proxy(share)
    asset = _asset(asset_type)
    with patch.object(share, "proxy_url_for", fake), \
         patch.object(share, "validate_share_link_with_session") as v, \
         patch.object(share, "_get_asset", return_value=asset), \
         patch.object(share, "_validate_asset_in_share"), \
         patch.object(share, "_log_share_activity"), \
         patch.object(share, "_get_latest_media_file", return_value=_media_file()):
        link = MagicMock()
        link.id = uuid.uuid4()
        v.return_value = link
        share.get_share_stream_url(
            token="t", asset_id=asset.id, share_session=None, download=False,
            variant=share.DownloadVariant.raw, db=mock_db, current_user=None,
        )
    assert calls[-1]["s3_key"] == PROCESSED
    assert calls[-1]["download_filename"] is None


def test_share_download_falls_back_to_processed_when_there_is_no_raw(client, mock_db):
    """An asset with only a derivative must still download, not 500."""
    from apps.api.routers import share

    calls, fake = _capture_proxy(share)
    asset = _asset(AssetType.image)
    with patch.object(share, "proxy_url_for", fake), \
         patch.object(share, "validate_share_link_with_session") as v, \
         patch.object(share, "_get_asset", return_value=asset), \
         patch.object(share, "_validate_asset_in_share"), \
         patch.object(share, "_require_download_variant"), \
         patch.object(share, "_log_share_activity"), \
         patch.object(share, "_get_latest_media_file",
                      return_value=_media_file(raw=None)):
        link = MagicMock()
        link.id = uuid.uuid4()
        v.return_value = link
        share.get_share_stream_url(
            token="t", asset_id=asset.id, share_session=None, download=True,
            variant=share.DownloadVariant.raw, db=mock_db, current_user=None,
        )
    assert calls[-1]["s3_key"] == PROCESSED


def test_share_video_download_is_unchanged(client, mock_db):
    """The branch that was already correct must stay correct."""
    from apps.api.routers import share

    calls, fake = _capture_proxy(share)
    asset = _asset(AssetType.video, name="A Clip")
    mf = _media_file(raw="raw/clip.mov", processed="hls/clip/",
                     original_filename="clip.mov")
    with patch.object(share, "proxy_url_for", fake), \
         patch.object(share, "validate_share_link_with_session") as v, \
         patch.object(share, "_get_asset", return_value=asset), \
         patch.object(share, "_validate_asset_in_share"), \
         patch.object(share, "_require_download_variant"), \
         patch.object(share, "_log_share_activity"), \
         patch.object(share, "_get_latest_media_file", return_value=mf):
        link = MagicMock()
        link.id = uuid.uuid4()
        v.return_value = link
        share.get_share_stream_url(
            token="t", asset_id=asset.id, share_session=None, download=True,
            variant=share.DownloadVariant.raw, db=mock_db, current_user=None,
        )
    assert calls[-1]["s3_key"] == "raw/clip.mov"


# ── assets.py — the same rule, written out a second time ─────────────────

def _assets_env(monkey_asset, media_file):
    from apps.api.routers import assets as assets_router

    version = MagicMock()
    version.id = uuid.uuid4()
    from apps.api.models.asset import ProcessingStatus
    version.processing_status = ProcessingStatus.ready
    version.version_number = 1

    db = MagicMock()
    def q(model):
        m = MagicMock()
        name = getattr(model, "__name__", str(model))
        if name == "Asset":
            m.filter.return_value.first.return_value = monkey_asset
        elif name == "AssetVersion":
            m.filter.return_value.order_by.return_value.first.return_value = version
            m.filter.return_value.first.return_value = version
        else:
            m.filter.return_value.first.return_value = media_file
        return m
    db.query.side_effect = q
    return assets_router, db


@pytest.mark.parametrize("asset_type", [AssetType.image, AssetType.audio])
def test_main_app_download_serves_the_raw_original(asset_type):
    asset = _asset(asset_type)
    mf = _media_file()
    assets_router, db = _assets_env(asset, mf)
    calls, fake = _capture_proxy(assets_router)

    with patch.object(assets_router, "proxy_url_for", fake), \
         patch.object(assets_router, "require_asset_access"):
        assets_router.get_stream_url(
            asset_id=asset.id, version_id=None, download=True,
            db=db, current_user=MagicMock(),
        )
    assert calls[-1]["s3_key"] == RAW
    assert calls[-1]["download_filename"].endswith(".tiff")


@pytest.mark.parametrize("asset_type", [AssetType.image, AssetType.audio])
def test_main_app_view_still_prefers_processed(asset_type):
    asset = _asset(asset_type)
    mf = _media_file()
    assets_router, db = _assets_env(asset, mf)
    calls, fake = _capture_proxy(assets_router)

    with patch.object(assets_router, "proxy_url_for", fake), \
         patch.object(assets_router, "require_asset_access"):
        assets_router.get_stream_url(
            asset_id=asset.id, version_id=None, download=False,
            db=db, current_user=MagicMock(),
        )
    assert calls[-1]["s3_key"] == PROCESSED


def test_main_app_and_share_agree_on_the_same_key():
    """The two implementations must not drift again.

    Asserted as an equality between the two routers rather than twice
    against a literal, so a future change to one of them fails here.
    """
    from apps.api.routers import share as share_router

    asset = _asset(AssetType.image)
    mf = _media_file()

    assets_router, db = _assets_env(asset, mf)
    a_calls, a_fake = _capture_proxy(assets_router)
    with patch.object(assets_router, "proxy_url_for", a_fake), \
         patch.object(assets_router, "require_asset_access"):
        assets_router.get_stream_url(
            asset_id=asset.id, version_id=None, download=True,
            db=db, current_user=MagicMock(),
        )

    s_calls, s_fake = _capture_proxy(share_router)
    with patch.object(share_router, "proxy_url_for", s_fake), \
         patch.object(share_router, "validate_share_link_with_session") as v, \
         patch.object(share_router, "_get_asset", return_value=asset), \
         patch.object(share_router, "_validate_asset_in_share"), \
         patch.object(share_router, "_require_download_variant"), \
         patch.object(share_router, "_log_share_activity"), \
         patch.object(share_router, "_get_latest_media_file", return_value=mf):
        link = MagicMock(); link.id = uuid.uuid4(); v.return_value = link
        share_router.get_share_stream_url(
            token="t", asset_id=asset.id, share_session=None, download=True,
            variant=share_router.DownloadVariant.raw, db=MagicMock(),
            current_user=None,
        )

    assert a_calls[-1]["s3_key"] == s_calls[-1]["s3_key"]
    assert a_calls[-1]["download_filename"] == s_calls[-1]["download_filename"]
