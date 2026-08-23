"""30-day Recently Deleted retention.

Unlike the rest of this suite, the sweep tests run against a **real
database with foreign keys enforced**, not mocks. That is the whole point:
the risk in this feature is the FK ordering in purge_service, and a
MagicMock session will happily "delete" rows in any order and report
success. Only a real engine raises IntegrityError when a comment is left
pointing at a deleted asset.

SQLite is used rather than Postgres so this runs anywhere. `PRAGMA
foreign_keys=ON` makes SQLite enforce the same NO ACTION semantics that
these constraints have in Postgres (they were all created without an
ondelete in b4623f8f4339_initial.py), so a wrong deletion order fails here
exactly as it would in production.

What this does NOT cover, stated plainly rather than implied:
  * Postgres-specific behaviour — deferred constraints, enum types, the
    real ON DELETE CASCADE on sidecar_files. SQLite honours the CASCADE
    declared on the model, which is the same declaration Postgres has.
  * Real S3. The S3 client is replaced with a recorder, so the tests
    assert which prefixes and keys *would* be deleted. Deleting real
    objects out of the live AIStor bucket from a unit test would mean
    creating real objects there first, and a failed run would leave them
    behind — see the module note in test_purge_s3_contract below.
"""
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.project import ProjectRole


# ── Real-DB harness ──────────────────────────────────────────────────────

@pytest.fixture
def real_db():
    """A SQLite session with the full schema and FK enforcement on.

    Skips rather than fails when the Postgres-specific column types can't
    be compiled for SQLite — a missing shim should read as "not covered
    here", not as a broken purge.
    """
    sa = pytest.importorskip("sqlalchemy")
    from sqlalchemy import create_engine, event
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import sessionmaker

    # The models are declared with Postgres column types. Teach SQLite how
    # to render the two that appear in the tables under test; values are
    # still passed as native Python objects either way.
    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401  -- registers every table on Base

    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture
def s3_recorder():
    """Replace S3 with something that records instead of deleting."""
    calls = {"prefixes": [], "keys": []}

    def fake_delete_object(key):
        calls["keys"].append(key)

    class _FakePaginator:
        def paginate(self, Bucket=None, Prefix=None):  # noqa: N803
            calls["prefixes"].append(Prefix)
            return []

    fake_client = MagicMock()
    fake_client.get_paginator.return_value = _FakePaginator()

    with patch("apps.api.services.s3_service.get_s3_client", return_value=fake_client), \
         patch("apps.api.services.s3_service.delete_object", side_effect=fake_delete_object):
        yield calls


def _seed_asset(db, *, deleted_days_ago: float | None, name="clip.mov"):
    """A soft-deleted asset wired up to one row in every table that
    references it, so the FK ordering is actually under test rather than
    trivially satisfied."""
    from apps.api.models.approval import Approval
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, MediaFile, FileType, ProcessingStatus,
    )
    from apps.api.models.comment import Annotation, Comment, CommentAttachment, CommentReaction
    from apps.api.models.activity import ActivityLog, Mention, Notification, NotificationType
    from apps.api.models.metadata import AssetMetadata, MetadataField, FieldType
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.share import AssetShare, ShareLink, ShareLinkItem
    from apps.api.models.sidecar import SidecarFile, SidecarType
    from apps.api.models.user import User, UserStatus, UserGlobalRole
    from apps.api.models.vote import Vote

    # `name` is a derived property (first_name + last_name), not a column.
    user = User(
        id=uuid.uuid4(), email=f"{uuid.uuid4().hex[:8]}@example.com",
        first_name="Test", last_name="User",
        password_hash="x", status=UserStatus.active, role=UserGlobalRole.superuser,
    )
    # Flushed one at a time: FKs are enforced here, so a batched add_all
    # can insert the project before the user it references.
    db.add(user)
    db.flush()
    project = Project(
        id=uuid.uuid4(), name="P", project_type=ProjectType.personal, created_by=user.id,
    )
    db.add(project)
    db.flush()

    deleted_at = (
        None if deleted_days_ago is None
        else datetime.now(timezone.utc) - timedelta(days=deleted_days_ago)
    )

    asset = Asset(
        id=uuid.uuid4(), project_id=project.id, name=name,
        asset_type=AssetType.video, created_by=user.id, deleted_at=deleted_at,
    )
    db.add(asset)
    db.flush()

    version = AssetVersion(
        id=uuid.uuid4(), asset_id=asset.id, version_number=1,
        processing_status=ProcessingStatus.ready, created_by=user.id,
    )
    db.add(version)
    db.flush()

    media = MediaFile(
        id=uuid.uuid4(), version_id=version.id, file_type=FileType.video,
        original_filename=name, mime_type="video/quicktime", file_size_bytes=123,
        s3_key_raw=f"raw/{project.id}/{asset.id}/{version.id}/original.mov",
        s3_key_processed=f"processed/{project.id}/{asset.id}/{version.id}/hls",
        s3_key_thumbnail=f"processed/{project.id}/{asset.id}/{version.id}/thumb.jpg",
    )
    comment = Comment(
        id=uuid.uuid4(), asset_id=asset.id, version_id=version.id,
        author_id=user.id, body="nice",
    )
    db.add_all([media, comment])
    db.flush()

    field = MetadataField(id=uuid.uuid4(), project_id=project.id, name="Scene", field_type=FieldType.text)
    link = ShareLink(id=uuid.uuid4(), asset_id=asset.id, token=uuid.uuid4().hex, created_by=user.id)
    db.add_all([field, link])
    db.flush()

    db.add_all([
        Annotation(id=uuid.uuid4(), comment_id=comment.id, drawing_data={}),
        CommentAttachment(
            id=uuid.uuid4(), comment_id=comment.id, file_type="image/png",
            s3_key=f"comment-attachments/{comment.id}/x/a.png",
            original_filename="a.png", file_size_bytes=1,
        ),
        CommentReaction(id=uuid.uuid4(), comment_id=comment.id, user_id=user.id, emoji="+1"),
        Mention(id=uuid.uuid4(), comment_id=comment.id, mentioned_user_id=user.id),
        Notification(id=uuid.uuid4(), user_id=user.id, asset_id=asset.id,
                     comment_id=comment.id, type=NotificationType.comment),
        Approval(id=uuid.uuid4(), asset_id=asset.id, version_id=version.id, user_id=user.id),
        Vote(id=uuid.uuid4(), asset_id=asset.id, user_id=user.id, stars=5),
        AssetMetadata(id=uuid.uuid4(), asset_id=asset.id, field_id=field.id, value="1"),
        ActivityLog(id=uuid.uuid4(), project_id=project.id, asset_id=asset.id,
                    user_id=user.id, action="deleted", payload={}),
        AssetShare(id=uuid.uuid4(), asset_id=asset.id, shared_with_user_id=user.id, shared_by=user.id),
        ShareLinkItem(id=uuid.uuid4(), share_link_id=link.id, asset_id=asset.id),
        SidecarFile(
            id=uuid.uuid4(), asset_id=asset.id, sidecar_type=SidecarType.cdl,
            original_filename="a.cdl", s3_key=f"sidecars/{project.id}/{asset.id}/a.cdl",
            uploaded_by=user.id,
        ),
    ])
    db.commit()
    return project, asset, version, comment


# ── The sweep ────────────────────────────────────────────────────────────

def test_sweep_purges_item_deleted_31_days_ago(real_db, s3_recorder):
    """The headline behaviour: past the window, it's gone — rows and all."""
    from apps.api.models.asset import Asset, AssetVersion, MediaFile
    from apps.api.models.comment import Comment
    from apps.api.services.purge_service import purge_expired

    _project, asset, version, _comment = _seed_asset(real_db, deleted_days_ago=31)
    # Snapshot the ids: committing the purge expires these instances, and
    # reading an attribute afterwards would try to refresh a deleted row.
    asset_id, version_id = asset.id, version.id

    result = purge_expired(real_db)

    assert result["failed"] == 0, "a FK ordering mistake would surface here"
    assert result["assets"] == 1
    assert real_db.query(Asset).filter(Asset.id == asset_id).first() is None
    # Children too — any one of these left behind is a FK violation waiting
    # to happen, or an orphan row nothing can reach.
    assert real_db.query(AssetVersion).filter(AssetVersion.asset_id == asset_id).count() == 0
    assert real_db.query(MediaFile).filter(MediaFile.version_id == version_id).count() == 0
    assert real_db.query(Comment).filter(Comment.asset_id == asset_id).count() == 0


def test_sweep_leaves_item_deleted_29_days_ago(real_db, s3_recorder):
    """The other half of a retention policy: it has to *retain*."""
    from apps.api.models.asset import Asset
    from apps.api.services.purge_service import purge_expired

    _project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=29)

    result = purge_expired(real_db)

    assert result["assets"] == 0
    assert result["objects"] == 0, "nothing should have been deleted from storage either"
    assert real_db.query(Asset).filter(Asset.id == asset.id).first() is not None


def test_sweep_ignores_live_items(real_db, s3_recorder):
    """An asset that was never deleted must be untouchable by the sweep,
    however old it is."""
    from apps.api.models.asset import Asset
    from apps.api.services.purge_service import purge_expired

    _project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=None)

    purge_expired(real_db)

    assert real_db.query(Asset).filter(Asset.id == asset.id).first() is not None


def test_boundary_is_exactly_30_days(real_db, s3_recorder):
    """Just inside stays, just outside goes — the edge, not a round number
    either side of it."""
    from apps.api.models.asset import Asset
    from apps.api.services.purge_service import purge_expired

    _p1, keep, _v, _c = _seed_asset(real_db, deleted_days_ago=30 - (1 / 24), name="keep.mov")
    _p2, drop, _v2, _c2 = _seed_asset(real_db, deleted_days_ago=30 + (1 / 24), name="drop.mov")

    purge_expired(real_db)

    assert real_db.query(Asset).filter(Asset.id == keep.id).first() is not None
    assert real_db.query(Asset).filter(Asset.id == drop.id).first() is None


def test_purged_asset_clears_its_storage(real_db, s3_recorder):
    """Storage is the reason this feature exists — a purge that frees no
    bytes is just a slower delete."""
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, comment = _seed_asset(real_db, deleted_days_ago=31)
    project_id, asset_id, comment_id = project.id, asset.id, comment.id

    purge_expired(real_db)

    prefixes = s3_recorder["prefixes"]
    # By prefix, not by key: s3_key_processed holds an HLS *prefix* for
    # video, so deleting it as an object would strand every segment.
    assert f"raw/{project_id}/{asset_id}/" in prefixes
    assert f"processed/{project_id}/{asset_id}/" in prefixes
    assert f"sidecars/{project_id}/{asset_id}/" in prefixes
    # Comment attachments are keyed by comment, not asset, so they need
    # their own prefix derived from the comments being deleted.
    assert f"comment-attachments/{comment_id}/" in prefixes


def test_purge_clears_a_persisted_download_proxy(real_db, s3_recorder):
    """§57's proxy is permanent — unlike an export nothing else ever deletes
    it, so a purge that missed it would leak a 1080p file per heavy asset."""
    from apps.api.models.asset import MediaFile
    from apps.api.services.purge_service import purge_expired

    project, asset, version, _c = _seed_asset(real_db, deleted_days_ago=31)
    proxy_key = f"proxies/{project.id}/{asset.id}/{version.id}/1080p.mp4"
    real_db.query(MediaFile).filter(MediaFile.version_id == version.id).update(
        {"proxy_1080p_key": proxy_key}
    )
    real_db.commit()
    project_id, asset_id = project.id, asset.id

    purge_expired(real_db)

    # Both routes, deliberately: by prefix alongside raw/processed, and by
    # the exact stored key as a backstop. Listing a prefix that holds
    # nothing is a cheap no-op; missing one leaks silently.
    assert f"proxies/{project_id}/{asset_id}/" in s3_recorder["prefixes"]
    assert proxy_key in s3_recorder["keys"]


def test_multi_item_share_link_survives_losing_one_asset(real_db, s3_recorder):
    """Purging one asset out of a multi-asset share must not revoke the
    others — only its own entry goes."""
    from apps.api.models.share import ShareLink, ShareLinkItem
    from apps.api.models.asset import Asset, AssetType
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)

    survivor = Asset(
        id=uuid.uuid4(), project_id=project.id, name="keep.mov",
        asset_type=AssetType.video, created_by=asset.created_by,
    )
    real_db.add(survivor)
    real_db.flush()
    shared = ShareLink(id=uuid.uuid4(), project_id=project.id, token=uuid.uuid4().hex, created_by=asset.created_by)
    real_db.add(shared)
    real_db.flush()
    real_db.add_all([
        ShareLinkItem(id=uuid.uuid4(), share_link_id=shared.id, asset_id=asset.id),
        ShareLinkItem(id=uuid.uuid4(), share_link_id=shared.id, asset_id=survivor.id),
    ])
    real_db.commit()

    purge_expired(real_db)

    assert real_db.query(ShareLink).filter(ShareLink.id == shared.id).first() is not None
    remaining = real_db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id == shared.id).all()
    assert [i.asset_id for i in remaining] == [survivor.id]


def test_folder_purge_takes_its_contents(real_db, s3_recorder):
    from apps.api.models.asset import Asset
    from apps.api.models.folder import Folder
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)
    deleted_at = asset.deleted_at

    parent = Folder(id=uuid.uuid4(), project_id=project.id, name="Day 01",
                    created_by=asset.created_by, deleted_at=deleted_at)
    real_db.add(parent)
    real_db.flush()
    child = Folder(id=uuid.uuid4(), project_id=project.id, name="A Cam", parent_id=parent.id,
                   created_by=asset.created_by, deleted_at=deleted_at)
    real_db.add(child)
    real_db.flush()
    asset.folder_id = child.id
    real_db.commit()
    asset_id, parent_id, child_id = asset.id, parent.id, child.id

    result = purge_expired(real_db)

    assert result["failed"] == 0
    assert real_db.query(Folder).filter(Folder.id.in_([parent_id, child_id])).count() == 0
    assert real_db.query(Asset).filter(Asset.id == asset_id).first() is None


def test_folder_purge_rescues_a_live_asset_instead_of_deleting_it(real_db, s3_recorder):
    """A live asset inside a trashed folder is moved to the project root,
    not destroyed. Deleting something the user never deleted is the one
    outcome this feature must never produce."""
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.folder import Folder
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)

    folder = Folder(id=uuid.uuid4(), project_id=project.id, name="Trashed",
                    created_by=asset.created_by, deleted_at=asset.deleted_at)
    real_db.add(folder)
    real_db.flush()
    live = Asset(
        id=uuid.uuid4(), project_id=project.id, name="live.mov",
        asset_type=AssetType.video, created_by=asset.created_by,
        folder_id=folder.id, deleted_at=None,
    )
    real_db.add(live)
    real_db.commit()

    purge_expired(real_db)

    survivor = real_db.query(Asset).filter(Asset.id == live.id).first()
    assert survivor is not None, "a live asset must never be purged"
    assert survivor.folder_id is None, "and should end up at the project root"


def test_one_bad_item_does_not_abort_the_sweep(real_db, s3_recorder):
    """A failure has to cost only itself. Otherwise a single undeletable
    asset freezes retention for the whole platform, silently."""
    from apps.api.models.asset import Asset
    from apps.api.services import purge_service

    _p1, good, _v, _c = _seed_asset(real_db, deleted_days_ago=31, name="good.mov")
    _p2, bad, _v2, _c2 = _seed_asset(real_db, deleted_days_ago=31, name="bad.mov")

    real_purge = purge_service.purge_asset

    def flaky(db, asset):
        if asset.id == bad.id:
            raise RuntimeError("simulated FK violation from a table added later")
        return real_purge(db, asset)

    with patch.object(purge_service, "purge_asset", side_effect=flaky):
        result = purge_service.purge_expired(real_db)

    assert result["failed"] == 1
    assert result["assets"] == 1
    assert real_db.query(Asset).filter(Asset.id == good.id).first() is None
    assert real_db.query(Asset).filter(Asset.id == bad.id).first() is not None


# ── The endpoint gate ────────────────────────────────────────────────────
#
# Mock-based, matching the rest of this suite: what's under test is the
# permission gate, not the SQL.

def _member(project_id, user_id, role):
    m = MagicMock()
    m.id = uuid.uuid4()
    m.project_id = project_id
    m.user_id = user_id
    m.role = role
    m.deleted_at = None
    return m


def _deleted_asset(project_id):
    a = MagicMock()
    a.id = uuid.uuid4()
    a.project_id = project_id
    a.deleted_at = datetime.now(timezone.utc) - timedelta(days=1)
    return a


@pytest.mark.parametrize("role", [ProjectRole.editor, ProjectRole.reviewer, ProjectRole.viewer])
def test_purge_endpoint_rejects_below_admin(client, auth_headers, mock_db, test_user, role):
    """403 from the server, not merely a hidden button.

    editor is the interesting one: it can soft-delete and restore, so if
    the gate were copied from the rest of this router it would pass here
    and let any editor destroy footage permanently.
    """
    project_id = uuid.uuid4()
    asset = _deleted_asset(project_id)

    mock_db.query.return_value.filter.return_value.first.side_effect = [
        asset,                                  # the deleted asset lookup
        _member(project_id, test_user.id, role),  # require_project_role
    ]

    resp = client.post(f"/assets/{asset.id}/purge", headers=auth_headers)
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize("role", [ProjectRole.owner, ProjectRole.admin])
def test_purge_endpoint_allows_owner_and_admin(client, auth_headers, mock_db, test_user, role):
    """admin is the role labelled "Manager" — there is no separate one."""
    project_id = uuid.uuid4()
    asset = _deleted_asset(project_id)

    mock_db.query.return_value.filter.return_value.first.side_effect = [
        asset,
        _member(project_id, test_user.id, role),
    ]

    with patch("apps.api.routers.folders.purge_asset", return_value={"asset_id": str(asset.id), "objects": 3, "versions": 1}) as p:
        resp = client.post(f"/assets/{asset.id}/purge", headers=auth_headers)

    assert resp.status_code == 200, resp.text
    assert p.called


def test_purge_endpoint_refuses_a_live_asset(client, auth_headers, mock_db, test_user):
    """Purge is a trash operation, not a way to skip the trash: the query
    filters on deleted_at, so a live asset is simply not found."""
    mock_db.query.return_value.filter.return_value.first.return_value = None

    resp = client.post(f"/assets/{uuid.uuid4()}/purge", headers=auth_headers)
    assert resp.status_code == 404, resp.text


# ── §14: purge across BOTH key formats ───────────────────────────────────
#
# Since the human-readable-prefix change, an object's project segment is
# either `{project_id}` or `{YYMMDD}_{slug}_{project_id}`. Nothing was
# migrated, so both coexist permanently — and they coexist within a single
# asset, because an asset uploaded before the change keeps its old-format
# v1 and gets a new-format v2 the next time someone uploads to it.
#
# Purge must follow what was actually WRITTEN, not what would be written
# today. These are the tests for that; the prefix-building itself is
# covered in test_storage_prefix.py.

def _seed_versions_with_prefixes(db, project, asset, prefixes):
    """Give `asset` one version per project-prefix, keyed accordingly."""
    from apps.api.models.asset import (
        AssetVersion, MediaFile, FileType, ProcessingStatus,
    )
    for i, prefix in enumerate(prefixes, start=2):
        v = AssetVersion(
            id=uuid.uuid4(), asset_id=asset.id, version_number=i,
            processing_status=ProcessingStatus.ready, created_by=asset.created_by,
        )
        db.add(v)
        db.flush()
        db.add(MediaFile(
            id=uuid.uuid4(), version_id=v.id, file_type=FileType.video,
            original_filename="clip.mov", mime_type="video/quicktime",
            file_size_bytes=1,
            s3_key_raw=f"raw/{prefix}/{asset.id}/{v.id}/original.mov",
            s3_key_processed=f"processed/{prefix}/{asset.id}/{v.id}/hls",
        ))
    db.commit()


def test_purge_clears_old_format_only_project(real_db, s3_recorder):
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)
    project_id, asset_id = project.id, asset.id

    purge_expired(real_db)

    prefixes = s3_recorder["prefixes"]
    for area in ("raw", "processed", "sidecars"):
        assert f"{area}/{project_id}/{asset_id}/" in prefixes


def test_purge_clears_new_format_only_project(real_db, s3_recorder):
    """A project whose very first upload postdates §14 has no old-format
    objects at all — but the bare-id prefix is still swept as a harmless
    backstop, which is the deliberate bias: a no-op list call costs
    nothing, a missed prefix leaks silently."""
    from apps.api.models.project import Project
    from apps.api.services.purge_service import purge_expired

    project, asset, version, _c = _seed_asset(real_db, deleted_days_ago=31)
    project_id, asset_id = project.id, asset.id
    new_prefix = f"260811_beach_{project_id}"

    real_db.query(Project).filter(Project.id == project_id).update(
        {"storage_slug": "beach", "storage_date_prefix": "260811"}
    )
    # Re-key the only version onto the new format, as a genuinely
    # post-§14 project would be.
    from apps.api.models.asset import MediaFile
    real_db.query(MediaFile).filter(MediaFile.version_id == version.id).update({
        "s3_key_raw": f"raw/{new_prefix}/{asset_id}/{version.id}/original.mov",
        "s3_key_processed": f"processed/{new_prefix}/{asset_id}/{version.id}/hls",
        "s3_key_thumbnail": None,
    })
    real_db.commit()

    purge_expired(real_db)

    prefixes = s3_recorder["prefixes"]
    for area in ("raw", "processed", "sidecars"):
        assert f"{area}/{new_prefix}/{asset_id}/" in prefixes, f"missed {area} under the new format"


def test_purge_clears_BOTH_formats_for_a_straddling_asset(real_db, s3_recorder):
    """An asset straddling the §14 change: old-format v1, new-format v2.

    Recomputing a SINGLE prefix from the project reaches one and strands
    the other, silently. Note this particular case is also covered by the
    computed backstop, since for a locked project the two computed
    candidates happen to be exactly the two formats — verified by
    mutation-testing, which leaves this test passing. The stored-key
    derivation is what carries the cases below, where the computed
    candidates cannot help.
    """
    from apps.api.models.project import Project
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)
    project_id, asset_id = project.id, asset.id
    new_prefix = f"260811_beach_{project_id}"

    real_db.query(Project).filter(Project.id == project_id).update(
        {"storage_slug": "beach", "storage_date_prefix": "260811"}
    )
    real_db.commit()
    # v1 (from _seed_asset) is old-format; add a new-format v2.
    _seed_versions_with_prefixes(real_db, project, asset, [new_prefix])

    purge_expired(real_db)

    prefixes = s3_recorder["prefixes"]
    for area in ("raw", "processed", "sidecars"):
        assert f"{area}/{project_id}/{asset_id}/" in prefixes, f"stranded OLD-format {area}"
        assert f"{area}/{new_prefix}/{asset_id}/" in prefixes, f"stranded NEW-format {area}"


def test_purge_follows_a_sidecar_uploaded_under_a_different_prefix(real_db, s3_recorder):
    """A sidecar carries whichever prefix was current when IT was
    uploaded, independently of the asset's media files — so its prefix is
    read off its own stored key, not inferred from the asset."""
    from apps.api.models.sidecar import SidecarFile
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)
    asset_id = asset.id
    odd_prefix = f"260811_beach_{project.id}"

    real_db.query(SidecarFile).filter(SidecarFile.asset_id == asset_id).update(
        {"s3_key": f"sidecars/{odd_prefix}/{asset_id}/a.cdl"}
    )
    real_db.commit()

    purge_expired(real_db)

    assert f"sidecars/{odd_prefix}/{asset_id}/" in s3_recorder["prefixes"]


def test_purge_does_not_delete_a_prefix_twice(real_db, s3_recorder):
    """The backstop must not turn into double work: an unlocked project's
    computed prefix and its stored keys are the same string, and each
    prefix should be listed once."""
    from apps.api.services.purge_service import purge_expired

    project, asset, _v, _c = _seed_asset(real_db, deleted_days_ago=31)
    project_id, asset_id = project.id, asset.id

    purge_expired(real_db)

    raw = [p for p in s3_recorder["prefixes"] if p == f"raw/{project_id}/{asset_id}/"]
    assert len(raw) == 1, f"prefix listed {len(raw)} times"


def test_purge_uses_stored_keys_when_the_project_no_longer_computes_them(real_db, s3_recorder):
    """The case only the stored key can solve.

    Here the object lives under a prefix the project would NOT generate
    today — its slug/date are absent, so the computed candidates are just
    the bare id. Recomputation reaches nothing; the stored key is the only
    record of where the bytes actually are. Mutation-tested: disabling the
    stored-key derivation fails this.
    """
    from apps.api.models.asset import MediaFile
    from apps.api.services.purge_service import purge_expired

    project, asset, version, _c = _seed_asset(real_db, deleted_days_ago=31)
    asset_id = asset.id
    written_prefix = f"260811_beach_{project.id}"   # project has no slug set

    real_db.query(MediaFile).filter(MediaFile.version_id == version.id).update({
        "s3_key_raw": f"raw/{written_prefix}/{asset_id}/{version.id}/original.mov",
        "s3_key_processed": f"processed/{written_prefix}/{asset_id}/{version.id}/hls",
        "s3_key_thumbnail": None,
    })
    real_db.commit()

    purge_expired(real_db)

    prefixes = s3_recorder["prefixes"]
    assert f"raw/{written_prefix}/{asset_id}/" in prefixes
    assert f"processed/{written_prefix}/{asset_id}/" in prefixes
