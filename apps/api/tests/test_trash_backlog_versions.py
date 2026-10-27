"""§239 decision 3 — what the purge and the trash report do with a version
that was deleted on its own.

The answer, found rather than assumed, is: **nothing, ever, while the
asset is alive.**

  * `purge_expired` selects on `Asset.deleted_at` and `Folder.deleted_at`
    only. A soft-deleted version of a LIVE asset is never due, so it is
    never purged — correct for safety (§239 frees no bytes by design) and
    permanent: its objects sit in the bucket with nothing scheduled to
    collect them.
  * `purge_asset`, when the whole asset does eventually go, takes
    `AssetVersion.asset_id == asset_id` with no `deleted_at` filter and
    clears `raw|processed|sidecars|proxies/{project}/{asset_id}` by
    PREFIX. So soft-deleted versions are not *missed* then — they are
    collected with everything else. Nothing is wrongly kept at that
    point, and nothing is wrongly purged before it.
  * `scripts/report_trash_backlog.py`'s `bytes_due` therefore has to KEEP
    counting soft-deleted versions: it reports what the purge would free,
    and the purge frees them. §239 deliberately did not add
    `deleted_at IS NULL` there, although it added it to all eight quota
    aggregates — that is the one site where the two questions give
    different answers.

What §239 added to that script is the gap's size: a line counting
versions deleted on their own inside live assets, so the storage they
hold is visible rather than silently accumulating. Report-only, like the
rest of the script — no writes, no S3 calls.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from unittest.mock import MagicMock, patch

from .version_world_239 import (
    PG_URL,
    SIZES,
    build_world,
    realdb,
    teardown_world,
)

pytestmark = realdb


@pytest.fixture(scope="module")
def sessionmaker_():
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


@pytest.fixture
def world(sessionmaker_):
    session = sessionmaker_()
    bag = build_world(session)
    try:
        yield bag
    finally:
        teardown_world(bag)


def soft_delete_version(world, key):
    version = world["versions"][key]
    version.deleted_at = datetime.now(timezone.utc)
    world["session"].commit()
    return version


# ── The purge ────────────────────────────────────────────────────────────

def test_the_sweep_never_touches_a_deleted_version_of_a_live_asset(world):
    """Not "should not" — does not, because it does not look at versions
    at all. Asserted so a future sweep that DOES look at them has to come
    past this test."""
    from apps.api.models.asset import AssetVersion
    from apps.api.services.purge_service import purge_expired

    session = world["session"]
    version = soft_delete_version(world, ("clip", 2))
    # Older than any retention window, so "not due yet" cannot be the
    # reason it survives.
    version.deleted_at = datetime.now(timezone.utc) - timedelta(days=365)
    session.commit()

    fake_s3 = MagicMock()
    fake_s3.get_paginator.return_value.paginate.return_value = []
    with patch("apps.api.services.s3_service.get_s3_client", return_value=fake_s3), \
         patch("apps.api.services.s3_service.delete_object") as delete_object:
        purge_expired(session)

    session.expire_all()
    row = session.query(AssetVersion).filter(AssetVersion.id == version.id).first()
    assert row is not None, "the version row was purged"
    assert row.deleted_at is not None
    # And none of its objects were deleted either.
    for call in delete_object.call_args_list:
        assert str(version.id) not in str(call)


def test_purging_the_whole_asset_does_collect_its_deleted_versions(world):
    """The other half: once the ASSET is in the trash and due, the
    soft-deleted version is not skipped — its row goes and its prefix is
    cleared with the rest."""
    from apps.api.models.asset import AssetVersion
    from apps.api.services.purge_service import purge_asset

    session = world["session"]
    version_id = soft_delete_version(world, ("clip", 2)).id
    clip = world["clip"]
    clip_id = clip.id
    clip.deleted_at = datetime.now(timezone.utc)
    session.commit()

    prefixes = []

    class _Paginator:
        def paginate(self, Bucket=None, Prefix=None):  # noqa: N803
            prefixes.append(Prefix)
            return []

    fake_s3 = MagicMock()
    fake_s3.get_paginator.return_value = _Paginator()
    with patch("apps.api.services.s3_service.get_s3_client", return_value=fake_s3), \
         patch("apps.api.services.s3_service.delete_object"):
        stats = purge_asset(session, clip)
        session.commit()

    assert stats["versions"] == 3, "the soft-deleted version was not counted"
    session.expire_all()
    # Ids captured BEFORE the purge: touching an attribute of a deleted
    # instance raises ObjectDeletedError, which would look like a test
    # failure rather than the pass it is.
    assert session.query(AssetVersion).filter(AssetVersion.id == version_id).first() is None
    # By prefix, which is what covers every version of the asset at once.
    assert any(f"/{clip_id}" in p for p in prefixes)


# ── The report ───────────────────────────────────────────────────────────

def run_report(session, argv=()):
    """The script's `main`, with its own SessionLocal replaced by this
    test's session so it reads the rows the fixture built."""
    from apps.api.scripts import report_trash_backlog

    with patch.object(report_trash_backlog, "SessionLocal", lambda: session):
        # `main` closes the session it is given; keep ours usable after.
        with patch.object(session, "close", lambda: None):
            rc = report_trash_backlog.main(list(argv))
    assert rc == 0
    return rc


def test_the_report_names_deleted_versions_of_live_assets(world, capsys):
    session = world["session"]
    soft_delete_version(world, ("clip", 2))
    run_report(session)
    out = capsys.readouterr().out
    assert "deleted VERSIONS of live assets" in out
    # One version, and its size, named rather than rolled into a total.
    line = next(l for l in out.splitlines() if "deleted VERSIONS" in l)
    assert "2.0 KB" in line
    assert "nothing purges these" in out


def test_the_report_is_read_only(world, capsys):
    """Stated in the script's own docstring; held here because a report
    that writes is the one thing it must never become."""
    from apps.api.models.asset import AssetVersion

    session = world["session"]
    version = soft_delete_version(world, ("clip", 2))
    before = {
        v.id: v.deleted_at for v in session.query(AssetVersion)
        .filter(AssetVersion.asset_id == world["clip"].id).all()
    }
    with patch("apps.api.services.s3_service.get_s3_client") as s3:
        run_report(session)
        assert not s3.called
    session.expire_all()
    after = {
        v.id: v.deleted_at for v in session.query(AssetVersion)
        .filter(AssetVersion.asset_id == world["clip"].id).all()
    }
    assert before == after
    assert after[version.id] is not None


def test_bytes_due_still_counts_a_soft_deleted_version(world, capsys):
    """The one aggregate §239 deliberately left unfiltered.

    `clip` goes into the trash, past retention, with v2 already deleted on
    its own. The purge would free ALL THREE versions' bytes, so that is
    what the report has to say — filtering v2 out here (the change the
    advisor's site list suggested) would under-report by exactly 2 KiB.
    """
    session = world["session"]
    soft_delete_version(world, ("clip", 2))
    world["clip"].deleted_at = datetime.now(timezone.utc) - timedelta(days=365)
    session.commit()

    run_report(session)
    out = capsys.readouterr().out
    storage_line = next(l for l in out.splitlines() if "storage they hold" in l)
    total_kib = sum(SIZES[("clip", n)] for n in (1, 2, 3)) / 1024
    assert f"{total_kib:.1f} KB" in storage_line
