"""Folder-share listing: visibility, sort and totals (CLAUDE.md §140).

Runs against a REAL Postgres. Every bug covered here is a SQL bug — a
missing predicate, a missing ORDER BY, an aggregate over the wrong row set
— and the mock session the rest of this suite uses cannot express any of
them. A MagicMock returns whatever the test tells it to, which is precisely
how a listing that counted abandoned uploads stayed green.

    docker run -d --name ff-pg -e POSTGRES_USER=user -e POSTGRES_PASSWORD=pass \
      -e POSTGRES_DB=freeframe_test -p 55432:5432 postgres:15-alpine
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:55432/freeframe_test \
      pytest apps/api/tests/test_share_folder_listing.py
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")

pytestmark = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a SQL "
           "predicate is not something a mock session can express",
)


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def db(sessionmaker_):
    session = sessionmaker_()
    try:
        yield session
    finally:
        session.rollback()
        session.close()


@pytest.fixture
def world(db):
    """A project + folder holding assets in every processing state.

    Sizes and timestamps are deliberately all distinct and deliberately
    NOT in the same order as the names, so a test asserting one ordering
    cannot pass by accidentally observing another.
    """
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project
    from apps.api.models.user import User

    owner = User(
        id=uuid.uuid4(), email=f"owner-{uuid.uuid4().hex[:8]}@example.com",
        first_name="Owner", last_name="Person", password_hash="x",
    )
    db.add(owner)
    db.flush()

    project = Project(id=uuid.uuid4(), name="Share Listing", created_by=owner.id)
    db.add(project)
    db.flush()

    folder = Folder(
        id=uuid.uuid4(), name="Dailies", project_id=project.id, created_by=owner.id,
    )
    db.add(folder)
    db.flush()

    base = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)

    def make(name, status, size, minutes, deleted=False):
        a = Asset(
            id=uuid.uuid4(), name=name, project_id=project.id,
            folder_id=folder.id, asset_type=AssetType.video,
            created_by=owner.id, created_at=base + timedelta(minutes=minutes),
        )
        if deleted:
            a.deleted_at = datetime.now(timezone.utc)
        db.add(a)
        db.flush()
        if status is not None:
            v = AssetVersion(
                id=uuid.uuid4(), asset_id=a.id, version_number=1,
                processing_status=status, created_by=owner.id,
            )
            db.add(v)
            db.flush()
            db.add(MediaFile(
                id=uuid.uuid4(), version_id=v.id, s3_key_raw=f"raw/{a.id}",
                file_size_bytes=size, mime_type="video/mp4",
                file_type=FileType.video, original_filename=f"{name}.mp4",
            ))
        db.flush()
        return a

    ready = {
        # name,            status,   bytes,   created-offset
        "charlie": make("charlie", ProcessingStatus.ready, 300, 30),
        "alpha":   make("alpha",   ProcessingStatus.ready, 100, 10),
        "bravo":   make("bravo",   ProcessingStatus.ready, 200, 20),
    }
    hidden = {
        "zulu-uploading": make("zulu-uploading", ProcessingStatus.uploading, 9_000, 40),
        "yankee-failed":  make("yankee-failed",  ProcessingStatus.failed,    8_000, 50),
        "xray-deleted":   make("xray-deleted",   ProcessingStatus.ready,     7_000, 60, deleted=True),
    }
    # Mid-flight but real: `processing` is NOT hidden — the file arrived, the
    # transcoder simply has not finished. It has no *ready* version, so it
    # contributes to the count while showing no size.
    processing = make("delta-processing", ProcessingStatus.processing, 400, 35)
    db.flush()
    return {
        "project": project, "folder": folder, "owner": owner,
        "ready": ready, "hidden": hidden, "processing": processing,
    }


# ── A. incomplete uploads are excluded ────────────────────────────────────

def test_uploading_failed_and_deleted_assets_are_all_excluded(db, world):
    from apps.api.models.asset import Asset
    from apps.api.services.asset_visibility import usable_asset_filter

    rows = db.query(Asset).filter(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    ).all()
    names = {a.name for a in rows}

    assert names == {"alpha", "bravo", "charlie", "delta-processing"}
    for gone in ("zulu-uploading", "yankee-failed", "xray-deleted"):
        assert gone not in names


def test_an_asset_with_no_versions_at_all_is_kept(db, world):
    """Matches list_assets' own "just created" branch.

    Dropping this clause would make an asset vanish between its own INSERT
    and its version's — and would silently hide every asset whose versions
    were soft-deleted individually.
    """
    from apps.api.models.asset import Asset, AssetType
    from apps.api.services.asset_visibility import usable_asset_filter

    bare = Asset(
        id=uuid.uuid4(), name="no-versions-yet", project_id=world["project"].id,
        folder_id=world["folder"].id, asset_type=AssetType.video,
        created_by=world["owner"].id,
    )
    db.add(bare)
    db.flush()

    names = {a.name for a in db.query(Asset).filter(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    ).all()}
    assert "no-versions-yet" in names


def test_folder_item_count_excludes_incomplete_uploads(db, world):
    from apps.api.routers.folders import _compute_item_count

    # 4 visible assets, 0 subfolders — not the 6 undeleted rows present.
    assert _compute_item_count(db, world["folder"].id) == 4


def test_folder_total_size_excludes_incomplete_uploads(db, world):
    """Storage consumed, minus the rows whose bytes never arrived.

    Note this is deliberately NOT the same number as the share viewer's
    `total_size_bytes` (600, asserted below). They answer different
    questions and both are right: this one is "how much storage does this
    folder hold", so a `processing` asset counts — its file is on S3, the
    transcoder simply has not finished. The share total is "sum of the
    sizes shown on screen", and a processing asset shows none.

    What both must exclude is `uploading`/`failed`/deleted, whose 9000,
    8000 and 7000 byte counts came from `initiate` and describe files that
    are not there.
    """
    from apps.api.routers.folders import _compute_folder_total_size

    assert _compute_folder_total_size(db, world["folder"].id) == 1000


# ── B. sort is applied in SQL, and is stable across pages ────────────────

def _sorted_names(db, world, sort, offset=0, limit=50):
    from apps.api.models.asset import Asset
    from apps.api.routers.share import _apply_share_sort
    from apps.api.services.asset_visibility import usable_asset_filter

    q = db.query(Asset).filter(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    )
    return [a.name for a in _apply_share_sort(q, sort).offset(offset).limit(limit).all()]


def test_sort_by_name_is_ascending(db, world):
    assert _sorted_names(db, world, "name") == [
        "alpha", "bravo", "charlie", "delta-processing",
    ]


def test_sort_by_file_size_is_largest_first(db, world):
    # delta-processing has no *ready* version, so it shows no size and sorts
    # last at 0 — the same value its row displays.
    assert _sorted_names(db, world, "file_size") == [
        "charlie", "bravo", "alpha", "delta-processing",
    ]


def test_sort_by_created_at_is_newest_first(db, world):
    assert _sorted_names(db, world, "created_at") == [
        "delta-processing", "charlie", "bravo", "alpha",
    ]


@pytest.mark.parametrize("sort", ["name", "created_at", "file_size"])
def test_paging_never_repeats_or_drops_a_row(db, world, sort):
    """The actual load-more bug: page 2 must continue page 1, not reshuffle.

    Asserted per sort key, because the ordering is what the frontend used to
    redo client-side over the whole accumulated array.
    """
    whole = _sorted_names(db, world, sort)
    paged = (
        _sorted_names(db, world, sort, offset=0, limit=2)
        + _sorted_names(db, world, sort, offset=2, limit=2)
    )
    assert paged == whole
    assert len(set(paged)) == len(paged)


@pytest.mark.parametrize("sort", ["name", "created_at", "file_size"])
def test_every_sort_ends_in_a_unique_tiebreak(db, world, sort):
    """Structural assertion, and deliberately so.

    Two assets sharing a name (or a byte count) have no defined relative
    order without a tiebreak, so Postgres MAY return them consistently
    across two LIMIT queries and MAY not — a behavioural test here passes
    or fails on the planner's mood, which is worse than no test. This
    asserts the ORDER BY actually carries `assets.id`, which is the thing
    that makes the order total.
    """
    from apps.api.models.asset import Asset
    from apps.api.routers.share import _apply_share_sort

    # Asserted on the ORDER BY *terms*, not on the compiled string. The
    # file_size term is a correlated subquery whose own SQL contains
    # "assets.id" (it joins on it), so a substring check passes even with
    # the tiebreak deleted — it did, until this was rewritten.
    clauses = _apply_share_sort(db.query(Asset), sort).statement._order_by_clauses
    last = clauses[-1]
    element = getattr(last, "element", last)
    # .compare(), not `is`: SQLAlchemy hands back a fresh annotated column
    # object here, so identity is always False even when it is the right one.
    assert element.compare(Asset.id.__clause_element__()), (
        f"{sort} does not end in a unique tiebreak; last term is {last!r}"
    )


def test_duplicate_names_and_sizes_still_page_without_repeating(db, world):
    """The tiebreak's real job, exercised end to end.

    Three assets share one name and one size, so `name` and `file_size`
    alone cannot order them.
    """
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )

    for i in range(3):
        a = Asset(
            id=uuid.uuid4(), name="same-name", project_id=world["project"].id,
            folder_id=world["folder"].id, asset_type=AssetType.video,
            created_by=world["owner"].id,
            created_at=datetime(2026, 3, 2, 12, 0, tzinfo=timezone.utc),
        )
        db.add(a)
        db.flush()
        v = AssetVersion(
            id=uuid.uuid4(), asset_id=a.id, version_number=1,
            processing_status=ProcessingStatus.ready, created_by=world["owner"].id,
        )
        db.add(v)
        db.flush()
        db.add(MediaFile(
            id=uuid.uuid4(), version_id=v.id, s3_key_raw=f"raw/{a.id}",
            file_size_bytes=500, mime_type="video/mp4",
            file_type=FileType.video, original_filename="same-name.mp4",
        ))
    db.flush()

    for sort in ("name", "file_size", "created_at"):
        whole = _sorted_names(db, world, sort)
        paged: list[str] = []
        for offset in range(0, len(whole), 2):
            paged += _sorted_names(db, world, sort, offset=offset, limit=2)
        assert paged == whole, f"{sort} reordered across pages"


def test_unknown_sort_key_is_not_accepted_silently_as_sql(db, world):
    """An unrecognised key falls back to the default order, never injects."""
    from apps.api.routers.share import SHARE_SORT_KEYS

    assert set(SHARE_SORT_KEYS) == {"name", "created_at", "file_size"}
    assert _sorted_names(db, world, "name; DROP TABLE assets") == _sorted_names(
        db, world, "created_at"
    )


# ── C. totals cover the whole link, not the loaded page ──────────────────

def test_total_size_sums_every_visible_asset_not_just_a_page(db, world):
    import sqlalchemy
    from apps.api.models.asset import Asset
    from apps.api.routers.share import _sum_asset_bytes
    from apps.api.services.asset_visibility import usable_asset_filter

    f = sqlalchemy.and_(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    )
    # Independent of any LIMIT — this is the whole point of the field.
    assert _sum_asset_bytes(db, f) == 600


def test_total_size_counts_each_asset_once_not_once_per_version(db, world):
    """A join instead of a correlated subquery would double this."""
    import sqlalchemy
    from apps.api.models.asset import (
        Asset, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.routers.share import _sum_asset_bytes
    from apps.api.services.asset_visibility import usable_asset_filter

    alpha = world["ready"]["alpha"]
    v2 = AssetVersion(
        id=uuid.uuid4(), asset_id=alpha.id, version_number=2,
        processing_status=ProcessingStatus.ready, created_by=world["owner"].id,
    )
    db.add(v2)
    db.flush()
    db.add(MediaFile(
        id=uuid.uuid4(), version_id=v2.id, s3_key_raw=f"raw/{v2.id}",
        file_size_bytes=150, mime_type="video/mp4",
        file_type=FileType.video, original_filename="alpha.mp4",
    ))
    db.flush()

    f = sqlalchemy.and_(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    )
    # v2 (150) replaces v1 (100) — it does not add to it. 150+200+300.
    assert _sum_asset_bytes(db, f) == 650


def test_total_size_matches_the_size_each_row_actually_displays(db, world):
    """The aggregate and the per-row figure must share one definition.

    If they diverge, the footer stops equalling the visible rows — the same
    class of bug, just moved.
    """
    import sqlalchemy
    from apps.api.models.asset import Asset
    from apps.api.routers.share import _get_latest_media_file, _sum_asset_bytes
    from apps.api.services.asset_visibility import usable_asset_filter

    f = sqlalchemy.and_(
        Asset.folder_id == world["folder"].id,
        Asset.deleted_at.is_(None),
        usable_asset_filter(),
    )
    rows = db.query(Asset).filter(f).all()
    per_row = 0
    for a in rows:
        mf = _get_latest_media_file(db, a.id)
        per_row += (mf.file_size_bytes if mf else 0) or 0

    assert _sum_asset_bytes(db, f) == per_row
