"""`preparing` — the state that replaced `building` (§217).

A streamed export is never built. What used to be a BUILD is a FREEZE: the
ordered list of (path, size, CRC-32, timestamp) is pinned once, and from
then on every byte of the archive is a pure function of it. The expensive
input is the CRC, so the freeze finishes in two halves and the row reports
`preparing` in between.

Three things have to be true of that state, and each has a specific failure
behind it:

  * **It must not look hung.** Reading a 105 GB original takes minutes, and
    the owner's library has hundreds of GB with no CRC. So the payload
    carries `files_prepared/files_total` AND a byte estimate — 8 of 9 files
    tells a reassuring lie when the ninth is the 105 GB one.
  * **One unreadable file must not hold the other ninety-nine.** The build
    path skipped a member it could not read and still produced a usable
    archive; the freeze has to do the same, or one deleted object strands a
    whole selection for its entire TTL.
  * **`ready` must mean the layout is computable** — and nothing else. No
    file is written anywhere, so `archive_size` and `etag` are the only
    evidence that the freeze finished.

Against a REAL Postgres: every assertion here is about a row and a JSONB
column, which a mocked session would simply agree with.
"""
import os
import uuid
import zlib
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)

BLOBS = {
    "small": b"a still image" * 3,
    "large": bytes(range(256)) * 40,
    "gone": b"this one gets deleted",
}


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
    """A share link over three ready videos of very different sizes."""
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.share import DownloadVariant, ShareLink, SharePermission
    from apps.api.models.user import User

    owner = User(id=uuid.uuid4(), email=f"prep-{uuid.uuid4().hex[:8]}@e.com",
                 first_name="P", last_name="R", password_hash="x")
    db.add(owner); db.flush()
    proj = Project(id=uuid.uuid4(), name="Preparing", created_by=owner.id)
    db.add(proj); db.flush()
    root = Folder(id=uuid.uuid4(), name="Root", project_id=proj.id, created_by=owner.id)
    db.add(root); db.flush()

    assets = {}
    for label, blob in BLOBS.items():
        a = Asset(id=uuid.uuid4(), name=label, project_id=proj.id, folder_id=root.id,
                  asset_type=AssetType.video, created_by=owner.id,
                  created_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc))
        db.add(a); db.flush()
        v = AssetVersion(id=uuid.uuid4(), asset_id=a.id, version_number=1,
                         processing_status=ProcessingStatus.ready, created_by=owner.id)
        db.add(v); db.flush()
        mf = MediaFile(id=uuid.uuid4(), version_id=v.id,
                       s3_key_raw=f"raw/{uuid.uuid4().hex}/{label}.mov",
                       file_size_bytes=len(blob), mime_type="video/quicktime",
                       file_type=FileType.video, original_filename=f"{label}.mov")
        db.add(mf); db.flush()
        assets[label] = (a, v, mf)

    link = ShareLink(id=uuid.uuid4(), token=f"pr{uuid.uuid4().hex[:10]}", folder_id=root.id,
                     created_by=owner.id, permission=SharePermission.view,
                     allowed_download_variants=[v.value for v in DownloadVariant])
    db.add(link); db.commit()
    return dict(db=db, owner=owner, proj=proj, root=root, link=link, assets=assets)


def _request(db, world, labels=None):
    """Ask for a batch, exactly as the share endpoint does."""
    from apps.api.models.share import ALL_DOWNLOAD_VARIANTS, DownloadVariant
    from apps.api.routers.share import _resolve_zip_selection, _start_or_reuse_zip
    from apps.api.schemas.share import ZipExportItem

    labels = labels or list(BLOBS)
    items = [ZipExportItem(asset_id=world["assets"][l][0].id) for l in labels]
    resolved, plan = _resolve_zip_selection(
        db, items=items, variant=DownloadVariant.raw, link=world["link"],
        root_folder_id=world["root"].id, allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    sent = []
    with patch("apps.api.routers.share.send_task_safe",
               side_effect=lambda t, *a, **k: sent.append((t.name, a))):
        export, reused = _start_or_reuse_zip(
            db, plan=plan, resolved=resolved, scope_kind="link",
            scope_id=world["link"].id, project_id=world["proj"].id,
            share_link_id=world["link"].id, created_by=None,
        )
    return export, reused, sent


def _poll(db, export):
    from apps.api.routers.share import _advance_preparation, _zip_status_payload

    sent = []
    with patch("apps.api.routers.share.send_task_safe",
               side_effect=lambda t, *a, **k: sent.append((t.name, a))):
        _advance_preparation(db, export)
    return _zip_status_payload(db, export), sent


def _verify(db, world, label):
    """Pretend the CRC task has read this object."""
    from apps.api.services import checksum_service as cs

    mf = world["assets"][label][2]
    blob = BLOBS[label]
    return cs.record_checksum(
        db, mf.s3_key_raw, crc32=zlib.crc32(blob) & 0xFFFFFFFF,
        bytes_read=len(blob), content_length=len(blob),
    )


def _give_up(db, world, label):
    from apps.api.config import settings
    from apps.api.services import checksum_service as cs

    mf = world["assets"][label][2]
    for _ in range(settings.crc_max_attempts):
        cs.begin_attempt(db, mf.s3_key_raw)
    cs.mark_attempt_failed(db, mf.s3_key_raw, "could not open: NoSuchKey")


# ── it starts preparing, and says so usefully ──────────────────────────────

def test_a_fresh_request_is_preparing_and_asks_for_the_crcs_it_needs(world, db):
    from apps.api.models.zip_export import ZipExportStatus

    export, reused, sent = _request(db, world)
    assert reused is False
    assert export.is_streamed is True
    assert export.status == ZipExportStatus.preparing
    assert export.archive_size is None and export.etag is None

    asked = {args[0] for name, args in sent if name == "compute_object_crc32"}
    assert asked == {world["assets"][l][2].s3_key_raw for l in BLOBS}
    assert "build_zip_export" not in [name for name, _ in sent]


def test_the_payload_reports_progress_per_file_and_per_byte(world, db):
    """"preparing, 3 of 9 files" plus a byte estimate, rather than looking
    hung. Both, because 8 of 9 files tells a reassuring lie when the ninth
    is a 105 GB original."""
    export, _r, _s = _request(db, world)

    payload, _sent = _poll(db, export)
    assert payload.status == "preparing"
    assert payload.ready is False and payload.url is None
    assert payload.files_total == 3 and payload.files_prepared == 0
    assert payload.bytes_total == sum(len(b) for b in BLOBS.values())
    assert payload.bytes_prepared == 0

    _verify(db, world, "small")
    payload, _sent = _poll(db, export)
    assert (payload.files_prepared, payload.files_total) == (1, 3)
    assert payload.bytes_prepared == len(BLOBS["small"])
    # The byte estimate is what makes the difference visible: one of three
    # files is done, but almost none of the bytes.
    assert payload.bytes_prepared * 3 < payload.bytes_total


def test_a_poll_re_asks_for_whatever_is_still_missing(world, db):
    """Deliberate, not belt-and-braces: a CRC task lost to the worker
    restart that every deploy performs would otherwise leave the export at
    `preparing` with nothing running and no way to notice."""
    export, _r, _s = _request(db, world)
    _verify(db, world, "small")

    _payload, sent = _poll(db, export)
    asked = {args[0] for name, args in sent if name == "compute_object_crc32"}
    assert asked == {
        world["assets"]["large"][2].s3_key_raw,
        world["assets"]["gone"][2].s3_key_raw,
    }
    assert world["assets"]["small"][2].s3_key_raw not in asked


# ── it becomes ready, and ready means the layout is computable ─────────────

def test_it_becomes_ready_once_every_crc_is_known(world, db):
    from apps.api.models.zip_export import ZipExportStatus
    from apps.api.services import zip_export_service as zx
    from apps.api.services import zip_stream as zs

    export, _r, _s = _request(db, world)
    for label in BLOBS:
        _verify(db, world, label)

    payload, _sent = _poll(db, export)
    assert export.status == ZipExportStatus.ready
    assert payload.ready is True and payload.url
    assert payload.files_prepared == payload.files_total == 3

    # `ready` means exactly this and nothing else: the archive's byte layout
    # is determinable. No file was written anywhere.
    entries = zx.streamable_entries(export.manifest)
    assert len(entries) == 3
    assert export.archive_size == zs.layout(entries).total_size
    assert export.etag == zs.archive_etag(entries)
    assert payload.archive_size == export.archive_size
    assert payload.etag == export.etag


def test_an_already_checksummed_selection_is_ready_inside_the_request(world, db):
    """The common case after the backfill has run, and after §217's
    post-upload dispatch: nobody ever sees `preparing`."""
    from apps.api.models.zip_export import ZipExportStatus

    for label in BLOBS:
        _verify(db, world, label)
    export, _reused, _sent = _request(db, world)
    assert export.status == ZipExportStatus.ready
    assert export.archive_size and export.etag


def test_the_frozen_timestamp_comes_from_the_asset_not_the_clock(world, db):
    """Two bytes of difference inside a header is enough to make a spliced
    resume extract to garbage, so the timestamp must not be "now"."""
    from apps.api.services.zip_stream import dos_timestamp

    export, _r, _s = _request(db, world)
    expected = list(
        dos_timestamp(datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc))
    )
    assert [e["mtime"] for e in export.manifest] == [expected] * 3
    assert dos_timestamp(datetime.now(timezone.utc)) != tuple(expected)


def test_the_etag_changes_when_the_selection_does(world, db):
    export_a, _r, _s = _request(db, world, ["small", "large"])
    for label in ("small", "large", "gone"):
        _verify(db, world, label)
    _poll(db, export_a)

    export_b, _r, _s = _request(db, world, ["small", "large", "gone"])
    _poll(db, export_b)

    assert export_a.etag and export_b.etag
    assert export_a.etag != export_b.etag
    assert export_a.archive_size != export_b.archive_size


# ── one unreadable file does not poison the rest ───────────────────────────

def test_a_file_that_can_never_be_read_is_skipped_and_the_rest_still_ready(
    world, db
):
    """The §217 requirement, and the behaviour the build path already had:
    one missing member must not cost the other ninety-nine."""
    from apps.api.models.zip_export import ZipExportStatus

    export, _r, _s = _request(db, world)
    _verify(db, world, "small")
    _verify(db, world, "large")
    _give_up(db, world, "gone")

    payload, _sent = _poll(db, export)
    assert export.status == ZipExportStatus.ready
    assert payload.ready is True

    by_path = {f.path: f for f in payload.files}
    gone_path = next(
        e["path"] for e in export.manifest
        if e["s3_key"] == world["assets"]["gone"][2].s3_key_raw
    )
    assert by_path[gone_path].skipped, "the UI has to be able to say which one"
    assert "NoSuchKey" in by_path[gone_path].skipped

    # And the skipped entry is not in the archive at all.
    from apps.api.services import zip_export_service as zx

    paths = [e.path for e in zx.streamable_entries(export.manifest)]
    assert gone_path not in paths and len(paths) == 2


def test_a_skipped_entry_counts_as_settled_in_the_progress(world, db):
    """It is settled, so leaving it out would hold the bar permanently
    short of 100% for an export that is already servable."""
    export, _r, _s = _request(db, world)
    _give_up(db, world, "gone")
    payload, _sent = _poll(db, export)
    assert payload.files_prepared >= 1
    assert payload.bytes_prepared >= len(BLOBS["gone"])


def test_an_export_where_nothing_can_be_read_fails_rather_than_offering_nothing(
    world, db
):
    from apps.api.models.zip_export import ZipExportStatus

    export, _r, _s = _request(db, world)
    for label in BLOBS:
        _give_up(db, world, label)
    payload, _sent = _poll(db, export)
    assert export.status == ZipExportStatus.failed
    assert payload.ready is False
    assert "could be read" in (payload.error or ""), payload.error


# ── reuse ─────────────────────────────────────────────────────────────────

def test_a_second_identical_request_shares_the_freeze(world, db):
    """Two viewers asking for the same selection must share one manifest and
    one set of CRC reads — queueing the same 105 GB read twice is the thing
    `cache_key` exists to prevent."""
    first, reused_first, _s = _request(db, world)
    second, reused_second, sent = _request(db, world)
    assert reused_first is False and reused_second is True
    assert second.id == first.id


def test_a_failed_freeze_is_not_reused(world, db):
    from apps.api.models.zip_export import ZipExportStatus

    first, _r, _s = _request(db, world)
    first.status = ZipExportStatus.failed
    db.commit()
    second, reused, _sent = _request(db, world)
    assert reused is False and second.id != first.id


def test_a_streamed_export_gets_the_long_ttl_not_the_archives_three_days(world, db):
    """The TTL that used to bound a second copy of the BYTES now bounds a
    few hundred rows of JSON — and it has to outlive the download, which is
    the whole point of §217. 641 GiB over a hotel connection is days."""
    from apps.api.services import zip_export_service as zx

    export, _r, _s = _request(db, world)
    for label in BLOBS:
        _verify(db, world, label)
    _poll(db, export)

    assert export.expires_at
    remaining = (export.expires_at - datetime.now(timezone.utc)).total_seconds()
    assert remaining > zx.ZIP_TTL_SECONDS, "a 3-day TTL cannot outlive a 6-day download"
    assert remaining <= zx.STREAMED_ZIP_TTL_SECONDS
