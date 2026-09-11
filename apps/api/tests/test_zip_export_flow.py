"""Zip downloads end to end: cache reuse, deactivation cleanup, fallback (§143).

Against a REAL Postgres, because all three behaviours are about rows and
SQL — a cache lookup, a cascade-scoped purge, a permission narrowing — and
a mock session reports whatever the test tells it to.

    docker run -d --name ff-pg -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass \
      -e POSTGRES_DB=freeframe_test -p 55432:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:55432/freeframe_test \
      pytest apps/api/tests/test_zip_export_flow.py
"""
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


class _NoCloseSession:
    """The tasks own their session and close it in a finally block.

    Handing them the test's session directly detaches every object the test
    still holds, so this delegates everything except close().
    """

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def close(self):
        pass


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    return sessionmaker(autocommit=False, autoflush=False, bind=create_engine(PG_URL))


@pytest.fixture
def db(sessionmaker_):
    s = sessionmaker_()
    try:
        yield s
    finally:
        s.rollback()
        s.close()


@pytest.fixture
def world(db):
    """A share link over a folder holding a video, a still and a subfolder."""
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.share import DownloadVariant, ShareLink, SharePermission
    from apps.api.models.user import User

    owner = User(id=uuid.uuid4(), email=f"zip-{uuid.uuid4().hex[:8]}@e.com",
                 first_name="Z", last_name="X", password_hash="x")
    db.add(owner); db.flush()
    proj = Project(id=uuid.uuid4(), name="Zip", created_by=owner.id)
    db.add(proj); db.flush()
    root = Folder(id=uuid.uuid4(), name="Root", project_id=proj.id, created_by=owner.id)
    db.add(root); db.flush()
    sub = Folder(id=uuid.uuid4(), name="Sub", project_id=proj.id, parent_id=root.id,
                 created_by=owner.id)
    db.add(sub); db.flush()

    def mk(folder, name, atype, ftype, *, lut=None, proxy=None):
        a = Asset(id=uuid.uuid4(), name=name, project_id=proj.id, folder_id=folder.id,
                  asset_type=atype, created_by=owner.id, applied_lut_id=lut)
        db.add(a); db.flush()
        v = AssetVersion(id=uuid.uuid4(), asset_id=a.id, version_number=1,
                         processing_status=ProcessingStatus.ready, created_by=owner.id)
        db.add(v); db.flush()
        mf = MediaFile(id=uuid.uuid4(), version_id=v.id, s3_key_raw=f"raw/{a.id}/o.bin",
                       s3_key_processed=f"processed/{a.id}/p.bin", proxy_1080p_key=proxy,
                       file_size_bytes=10, mime_type="application/octet-stream",
                       file_type=ftype, original_filename=f"{name}.bin")
        db.add(mf); db.flush()
        return a, v, mf

    from apps.api.models.lut import Lut
    lut = Lut(id=uuid.uuid4(), owner_id=owner.id, name="L", s3_key="luts/x.cube", lut_size=17)
    db.add(lut); db.flush()

    video, vv, vmf = mk(root, "clip", AssetType.video, FileType.video,
                        lut=lut.id, proxy=f"proxies/1080.mp4")
    still, sv, smf = mk(root, "photo", AssetType.image, FileType.image)
    nested, nv, nmf = mk(sub, "inner", AssetType.video, FileType.video)

    link = ShareLink(id=uuid.uuid4(), token=f"zip{uuid.uuid4().hex[:8]}", folder_id=root.id,
                     created_by=owner.id, permission=SharePermission.view,
                     allowed_download_variants=[v.value for v in DownloadVariant])
    db.add(link); db.commit()
    return dict(db=db, owner=owner, proj=proj, root=root, sub=sub, link=link,
                video=(video, vv, vmf), still=(still, sv, smf), nested=(nested, nv, nmf))


# ── the batch offers only what is already stored ─────────────────────────

def test_batch_never_offers_a_variant_that_would_need_rendering(world):
    """The §143 scope decision, asserted at the source of the picker.

    `raw_lut` is permitted by this link and the asset HAS a LUT, so the
    single-item download menu would offer it. The batch must not, because
    a zip build runs no ffmpeg.
    """
    from apps.api.services.zip_export_service import stored_variants_for
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS

    asset, _, mf = world["video"]
    offered = stored_variants_for(ALL_DOWNLOAD_VARIANTS, asset, mf)

    assert "raw" in offered
    assert "proxy_1080p" in offered          # §57 persisted one for this file
    assert "raw_lut" not in offered          # would need a render
    assert "proxy_720p" not in offered       # no persisted 720p object exists
    assert "proxy_1080p_lut" not in offered


def test_a_file_without_a_persisted_proxy_offers_only_raw(world):
    from apps.api.services.zip_export_service import stored_variants_for
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS

    asset, _, mf = world["nested"]           # proxy_1080p_key is None
    assert stored_variants_for(ALL_DOWNLOAD_VARIANTS, asset, mf) == ["raw"]


def test_the_picker_offers_the_union_across_a_mixed_selection(world):
    """One file having a proxy is reason enough to offer it.

    The others fall back and say so per file — an intersection would hide
    the option whenever a single still was in the folder.
    """
    from apps.api.services.zip_export_service import batch_variant_options
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS

    pairs = [(world["video"][0], world["video"][2]),
             (world["still"][0], world["still"][2])]
    assert batch_variant_options(ALL_DOWNLOAD_VARIANTS, pairs) == ["raw", "proxy_1080p"]


# ── fallback is surfaced per file, not silently substituted ──────────────

def test_a_still_in_a_proxy_batch_falls_back_and_says_why(world, db):
    from apps.api.routers.share import _resolve_zip_selection
    from apps.api.schemas.share import ZipExportItem
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS, DownloadVariant

    items = [ZipExportItem(asset_id=world["video"][0].id),
             ZipExportItem(asset_id=world["still"][0].id)]
    resolved, plan = _resolve_zip_selection(
        db, items=items, variant=DownloadVariant.proxy_1080p, link=world["link"],
        root_folder_id=world["root"].id, allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    by_name = {e["asset_name"]: e for e in plan}
    assert by_name["clip"]["variant"] == "proxy_1080p"
    assert by_name["clip"]["fallback_reason"] is None

    assert by_name["photo"]["variant"] == "raw"
    assert by_name["photo"]["fallback_reason"]          # the note the UI shows
    assert "not a video" in by_name["photo"]["fallback_reason"]

    assert not any(e["needs_render"] for e in plan)


def test_the_zip_preserves_the_folder_tree(world, db):
    from apps.api.routers.share import _resolve_zip_selection
    from apps.api.schemas.share import ZipExportItem
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS, DownloadVariant

    items = [ZipExportItem(asset_id=world["video"][0].id),
             ZipExportItem(asset_id=world["nested"][0].id)]
    _, plan = _resolve_zip_selection(
        db, items=items, variant=DownloadVariant.raw, link=world["link"],
        root_folder_id=world["root"].id, allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    paths = sorted(e["path"] for e in plan)
    # The link's own folder is the archive root, so "Root/" is not repeated
    # inside; the subfolder is.
    assert paths[0].startswith("Sub/")
    assert "/" not in paths[1]


def test_an_unspecified_version_resolves_to_the_latest_ready_one(world, db):
    from apps.api.models.asset import AssetVersion, MediaFile, ProcessingStatus, FileType
    from apps.api.routers.share import _resolve_zip_selection
    from apps.api.schemas.share import ZipExportItem
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS, DownloadVariant

    asset, v1, _ = world["video"]
    v2 = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=2,
                      processing_status=ProcessingStatus.ready, created_by=world["owner"].id)
    db.add(v2); db.flush()
    db.add(MediaFile(id=uuid.uuid4(), version_id=v2.id, s3_key_raw=f"raw/{asset.id}/v2.bin",
                     file_size_bytes=11, mime_type="application/octet-stream",
                     file_type=FileType.video, original_filename="clip.bin"))
    db.flush()

    _, plan = _resolve_zip_selection(
        db, items=[ZipExportItem(asset_id=asset.id)], variant=DownloadVariant.raw,
        link=world["link"], root_folder_id=world["root"].id,
        allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    assert plan[0]["version_id"] == str(v2.id)

    # and an explicit older version is honoured
    _, plan2 = _resolve_zip_selection(
        db, items=[ZipExportItem(asset_id=asset.id, version_id=v1.id)],
        variant=DownloadVariant.raw, link=world["link"],
        root_folder_id=world["root"].id, allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    assert plan2[0]["version_id"] == str(v1.id)


# ── cache reuse ──────────────────────────────────────────────────────────

def _start(db, world, variant, items=None):
    from apps.api.routers.share import _resolve_zip_selection, _start_or_reuse_zip
    from apps.api.schemas.share import ZipExportItem
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS

    items = items or [ZipExportItem(asset_id=world["video"][0].id)]
    resolved, plan = _resolve_zip_selection(
        db, items=items, variant=variant, link=world["link"],
        root_folder_id=world["root"].id, allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    with patch("apps.api.routers.share.send_task_safe") as sent:
        export, reused = _start_or_reuse_zip(
            db, plan=plan, resolved=resolved, scope_kind="link", scope_id=world["link"].id,
            project_id=world["proj"].id, share_link_id=world["link"].id, created_by=None,
        )
    return export, reused, sent


def test_an_identical_second_request_reuses_the_first_archive(world, db):
    from apps.api.models.share import DownloadVariant

    first, reused1, sent1 = _start(db, world, DownloadVariant.raw)
    assert reused1 is False
    assert sent1.called, "a miss must dispatch a build"

    second, reused2, sent2 = _start(db, world, DownloadVariant.raw)
    assert reused2 is True
    assert second.id == first.id
    assert not sent2.called, "a hit must NOT dispatch a second build"


def test_a_different_variant_is_a_different_archive(world, db):
    from apps.api.models.share import DownloadVariant

    first, _, _ = _start(db, world, DownloadVariant.raw)
    second, reused, _ = _start(db, world, DownloadVariant.proxy_1080p)
    assert reused is False
    assert second.id != first.id


def test_a_failed_build_is_not_reused(world, db):
    """Retrying should retry, not hand back the failure."""
    from apps.api.models.share import DownloadVariant
    from apps.api.models.zip_export import ZipExportStatus

    first, _, _ = _start(db, world, DownloadVariant.raw)
    first.status = ZipExportStatus.failed
    db.commit()

    second, reused, sent = _start(db, world, DownloadVariant.raw)
    assert reused is False and second.id != first.id
    assert sent.called


# ── deactivation-triggered cleanup ───────────────────────────────────────

def test_purging_a_link_deletes_its_archives_and_only_its_own(world, db):
    from apps.api.models.share import DownloadVariant, ShareLink, SharePermission
    from apps.api.models.zip_export import ZipExport

    mine, _, _ = _start(db, world, DownloadVariant.raw)

    other_link = ShareLink(id=uuid.uuid4(), token=f"zip{uuid.uuid4().hex[:8]}",
                           folder_id=world["root"].id, created_by=world["owner"].id,
                           permission=SharePermission.view, allowed_download_variants=["raw"])
    db.add(other_link); db.flush()
    theirs = ZipExport(id=uuid.uuid4(), cache_key="other", share_link_id=other_link.id,
                       project_id=world["proj"].id,
                       s3_key=f"zip-exports/{world['proj'].id}/link/{other_link.id}/x.zip")
    db.add(theirs); db.commit()

    deleted: list[str] = []
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=_NoCloseSession(db)), \
         patch("apps.api.tasks.zip_tasks.s3_service.delete_object", side_effect=deleted.append):
        from apps.api.tasks.zip_tasks import purge_share_link_zips
        purge_share_link_zips(str(world["link"].id))

    assert deleted == [mine.s3_key]
    assert db.query(ZipExport).filter(ZipExport.id == mine.id).first() is None
    assert db.query(ZipExport).filter(ZipExport.id == theirs.id).first() is not None


def test_purge_refuses_a_key_outside_its_own_prefix(world, db):
    """The guard that stops a bad row pointing the delete at raw/."""
    from apps.api.models.zip_export import ZipExport

    bad = ZipExport(id=uuid.uuid4(), cache_key="bad", share_link_id=world["link"].id,
                    project_id=world["proj"].id, s3_key="raw/some/original.mov")
    db.add(bad); db.commit()

    deleted: list[str] = []
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=_NoCloseSession(db)), \
         patch("apps.api.tasks.zip_tasks.s3_service.delete_object", side_effect=deleted.append):
        from apps.api.tasks.zip_tasks import purge_share_link_zips
        purge_share_link_zips(str(world["link"].id))

    assert deleted == [], "a non-zip-export key must never be deleted"


def test_deactivating_a_link_dispatches_the_purge(world, db):
    from apps.api.routers import share as share_router

    with patch.object(share_router, "send_task_safe") as sent:
        share_router._purge_link_zips(world["link"].id)
    assert sent.called
    assert str(world["link"].id) in [str(a) for a in sent.call_args[0]]


def test_the_sweep_deletes_only_expired_rows(world, db):
    from apps.api.models.zip_export import ZipExport, ZipExportStatus

    fresh = ZipExport(id=uuid.uuid4(), cache_key="f", project_id=world["proj"].id,
                      share_link_id=world["link"].id, status=ZipExportStatus.ready,
                      s3_key=f"zip-exports/{world['proj'].id}/link/a/fresh.zip",
                      expires_at=datetime.now(timezone.utc) + timedelta(days=1))
    stale = ZipExport(id=uuid.uuid4(), cache_key="s", project_id=world["proj"].id,
                      share_link_id=world["link"].id, status=ZipExportStatus.ready,
                      s3_key=f"zip-exports/{world['proj'].id}/link/a/stale.zip",
                      expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    db.add_all([fresh, stale]); db.commit()

    deleted: list[str] = []
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=_NoCloseSession(db)), \
         patch("apps.api.tasks.zip_tasks.s3_service.delete_object", side_effect=deleted.append):
        from apps.api.tasks.zip_tasks import sweep_zip_exports
        sweep_zip_exports()

    assert stale.s3_key in deleted
    assert fresh.s3_key not in deleted


def test_the_sweep_also_refuses_a_key_outside_its_prefix(world, db):
    """Same guard as the purge, and it needs its own test.

    An expired row is exactly the case that reaches the delete, so a row
    whose key somehow points at raw/ must be refused there too — the sweep
    runs unattended on a schedule, with nobody watching.
    """
    from apps.api.models.zip_export import ZipExport, ZipExportStatus

    bad = ZipExport(id=uuid.uuid4(), cache_key="b", project_id=world["proj"].id,
                    share_link_id=world["link"].id, status=ZipExportStatus.ready,
                    s3_key="processed/some/derivative.webp",
                    expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    db.add(bad); db.commit()

    deleted: list[str] = []
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=_NoCloseSession(db)), \
         patch("apps.api.tasks.zip_tasks.s3_service.delete_object", side_effect=deleted.append):
        from apps.api.tasks.zip_tasks import sweep_zip_exports
        sweep_zip_exports()

    assert "processed/some/derivative.webp" not in deleted
