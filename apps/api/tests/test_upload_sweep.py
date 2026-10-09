"""Reaping abandoned uploads (§215).

§213 made a failed upload KEEP its multipart session so it can be resumed,
which means abandoned uploads accumulate forever unless something reaps
them. This is that something — and it aborts data, so what is asserted
here is mostly what it must NOT touch.

THE TEST THAT MATTERS MOST is `test_an_upload_with_recent_parts_is_alive`:
an upload Initiated 30 days ago whose newest part is two hours old is a
live 100 GB offload, and killing it because its START date was old would
destroy every byte already transferred. Judging by `Initiated` alone is
the failure mode that would make this sweep dangerous.

Fake S3 throughout, the same shape the other `test_upload_*` files use.
There is no MinIO/AIStor here, so what is asserted is what the task does
with each answer the store could give — not the store's own behaviour.
Two things are therefore NOT proven by this file and are flagged in §215's
report: ListMultipartUploads' real `KeyMarker`/`UploadIdMarker` paging,
and that AIStor populates `LastModified` on ListParts at all.
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

GIB = 1024 ** 3
NOW = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)


# ── fakes ──────────────────────────────────────────────────────────────────


class FakeSession:
    """Just the query shapes the task uses, so the assertions stay readable.

    A MagicMock can be scripted into this, but then the test reads as a
    list of return values rather than as a description of the data, and the
    two query shapes here (a single-entity `.first()` and a two-entity
    `.join().all()`) are easy to mix up when they are both `.return_value`.
    """

    def __init__(self, media_files=None, versions=None, ghosts=None):
        self.media_files = media_files or {}      # s3_key_raw -> media_file
        self.versions = versions or {}            # version_id -> version
        self.ghosts = ghosts or []                # [(version, media_file)]
        self.committed = 0
        self.rolled_back = 0
        self.closed = False

    # The task only ever filters; the filter itself is re-expressed here as
    # "which lookup is this", which is what the task actually means.
    def query(self, *entities):
        return _FakeQuery(self, entities)

    def commit(self):
        self.committed += 1

    def rollback(self):
        self.rolled_back += 1

    def close(self):
        self.closed = True


class _FakeQuery:
    """Honours the criteria it is given, rather than ignoring them.

    That matters more than it looks. Pass 2's grace period lives ENTIRELY
    in its query (`created_at < ghost_cutoff`), so a fake that returned its
    ghost list regardless would make "a young row is left alone" a vacuous
    test — it would pass against a sweep with no grace period at all. The
    mutation sweep caught exactly that, and this is the fix.
    """

    def __init__(self, session, entities):
        self.session = session
        self.entities = entities
        self._key = None
        self._version_id = None
        self._created_before = None
        self._status = None

    def filter(self, *criteria):
        for c in criteria:
            # SQLAlchemy BinaryExpression: the column on the left, the bound
            # value on the right. Read by column NAME, so a criterion this
            # fake does not understand is a visible miss rather than a
            # silently dropped filter.
            left = getattr(c, "left", None)
            right = getattr(c, "right", None)
            name = getattr(left, "name", None) or getattr(left, "key", None)
            value = getattr(right, "value", None)
            op = getattr(getattr(c, "operator", None), "__name__", "")
            if name == "s3_key_raw":
                self._key = value
            elif name == "id":
                self._version_id = value
            elif name == "created_at" and op in ("lt", "__lt__"):
                self._created_before = value
            elif name == "processing_status":
                self._status = value
        return self

    def join(self, *a, **k):
        return self

    def all(self):
        rows = []
        for version, media_file in self.session.ghosts:
            if self._status is not None and version.processing_status != self._status:
                continue
            if self._created_before is not None and not (
                    version.created_at < self._created_before):
                continue
            if version.deleted_at is not None:
                continue
            rows.append((version, media_file))
        return rows

    def first(self):
        if self._key is not None:
            return self.session.media_files.get(self._key)
        if self._version_id is not None:
            return self.session.versions.get(self._version_id)
        return None


def make_version(status, created_at=None, version_id=None):
    from apps.api.models.asset import ProcessingStatus

    v = MagicMock()
    v.id = version_id or uuid.uuid4()
    v.asset_id = uuid.uuid4()
    v.processing_status = status if isinstance(status, ProcessingStatus) else status
    v.created_at = created_at or (NOW - timedelta(days=30))
    v.deleted_at = None
    return v


def make_media_file(key, version_id):
    mf = MagicMock()
    mf.s3_key_raw = key
    mf.version_id = version_id
    return mf


def upload(key, days_ago, upload_id="u-1"):
    return {"Key": key, "UploadId": upload_id, "Initiated": NOW - timedelta(days=days_ago)}


def parts(count=3, size=16 * 1024 * 1024, newest_hours_ago=None, newest_days_ago=None):
    if newest_hours_ago is not None:
        newest = NOW - timedelta(hours=newest_hours_ago)
    elif newest_days_ago is not None:
        newest = NOW - timedelta(days=newest_days_ago)
    else:
        newest = None
    out = []
    for n in range(1, count + 1):
        out.append({
            "PartNumber": n, "ETag": f'"e{n}"', "Size": size,
            "LastModified": newest if n == count else None,
        })
    return out


def run_sweep(
    *,
    uploads=None,
    parts_by_key=None,
    session=None,
    exists=None,
    abort_raises=None,
    uploads_raises=None,
    parts_raises=None,
    **overrides,
):
    """Run the real task against a fake store, and report what it called."""
    from apps.api.tasks import upload_sweep_tasks as mod

    calls = {"aborted": [], "list_parts": [], "exists": [], "list_uploads": 0}

    def fake_list_uploads(prefix):
        calls["list_uploads"] += 1
        if uploads_raises:
            raise uploads_raises
        # The prefix restriction is the store's job AND the helper's; here
        # the task's own choice of prefix is what is observable.
        calls["prefix"] = prefix
        return list(uploads or [])

    def fake_list_parts(key, upload_id):
        calls["list_parts"].append(key)
        if parts_raises and key in parts_raises:
            raise parts_raises[key]
        return list((parts_by_key or {}).get(key, []))

    def fake_abort(key, upload_id):
        calls["aborted"].append(key)
        if abort_raises and key in abort_raises:
            raise abort_raises[key]

    def fake_exists(key):
        calls["exists"].append(key)
        if exists is None:
            return False
        value = exists.get(key, False)
        if isinstance(value, Exception):
            raise value
        return value

    db = session or FakeSession()

    class FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return NOW

    defaults = {
        "upload_sweep_enabled": True,
        "upload_sweep_dry_run": False,
        "upload_abandon_days": 14,
        "upload_ghost_grace_hours": 24,
        "upload_sweep_max_aborts": 50,
    }
    defaults.update(overrides)

    with patch.object(mod, "list_multipart_uploads_all", fake_list_uploads), \
         patch.object(mod, "list_multipart_parts", fake_list_parts), \
         patch.object(mod, "abort_multipart_upload", fake_abort), \
         patch.object(mod, "object_exists", fake_exists), \
         patch.object(mod, "SessionLocal", lambda: db), \
         patch.object(mod, "datetime", FixedDatetime):
        for k, v in defaults.items():
            patch.object(mod.settings, k, v, create=True).start()
        try:
            result = mod.sweep_abandoned_uploads()
        finally:
            patch.stopall()
    return result, calls, db


# ── a — the signal ─────────────────────────────────────────────────────────


class TestWhatCountsAsAbandoned:
    def test_an_upload_with_recent_parts_is_alive(self):
        """THE test. Started 30 days ago, newest part 2 hours old.

        A 100 GB offload legitimately runs for days and resumes across
        quits. Reaping it because its start date is old destroys every
        byte already sent — the one outcome worse than leaving litter.
        """
        key = "raw/p/a/v/original.mxf"
        result, calls, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=6000, newest_hours_ago=2)},
        )
        assert calls["aborted"] == []
        assert result["alive"] == 1
        assert result["aborted"] == 0

    def test_an_upload_with_no_activity_for_the_ttl_is_abandoned(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading())
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
        )
        result, calls, db = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=4, newest_days_ago=20)},
            session=session,
        )
        assert calls["aborted"] == [key]
        assert result["aborted"] == 1
        assert version.processing_status == _failed()
        assert result["versions_failed"] == 1
        assert db.committed >= 1

    def test_a_recent_upload_is_skipped_without_listing_its_parts(self):
        """The cheap filter. A 100 GB upload is six ListParts round trips;
        an upload that cannot be abandoned must not pay for them."""
        key = "raw/p/a/v/original.mxf"
        result, calls, _ = run_sweep(
            uploads=[upload(key, days_ago=1)],
            parts_by_key={key: parts(count=10)},
        )
        assert calls["list_parts"] == []
        assert result["list_parts_calls"] == 0
        assert calls["aborted"] == []
        assert result["skipped_recent"] == 1

    def test_the_boundary_is_the_ttl_not_the_start_date(self):
        """Two uploads, same age; only the one with no recent parts goes."""
        dead = "raw/p/a/dead/original.mxf"
        live = "raw/p/a/live/original.mxf"
        result, calls, _ = run_sweep(
            uploads=[upload(dead, days_ago=40, upload_id="u-dead"),
                     upload(live, days_ago=40, upload_id="u-live")],
            parts_by_key={
                dead: parts(count=2, newest_days_ago=39),
                live: parts(count=2, newest_hours_ago=1),
            },
        )
        assert calls["aborted"] == [dead]
        assert result["alive"] == 1

    def test_an_upload_that_vanished_between_listing_and_reading_is_not_an_error(self):
        from apps.api.services.s3_service import NoSuchUploadError

        key = "raw/p/a/v/original.mxf"
        result, calls, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_raises={key: NoSuchUploadError("gone")},
        )
        assert calls["aborted"] == []
        assert result["errors"] == 0


# ── b — what must never be touched ─────────────────────────────────────────


def _uploading():
    from apps.api.models.asset import ProcessingStatus
    return ProcessingStatus.uploading


def _failed():
    from apps.api.models.asset import ProcessingStatus
    return ProcessingStatus.failed


def _processing():
    from apps.api.models.asset import ProcessingStatus
    return ProcessingStatus.processing


def _ready():
    from apps.api.models.asset import ProcessingStatus
    return ProcessingStatus.ready


class TestWhatItRefusesToTouch:
    @pytest.mark.parametrize("status_fn", [_processing, _ready])
    def test_a_finished_version_is_never_failed(self, status_fn):
        """Its leftover session is litter; the asset works. Failing the row
        would break something that is live."""
        key = "raw/p/a/v/original.mxf"
        version = make_version(status_fn())
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
        )
        result, calls, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=session,
        )
        # The session IS aborted — it can never be completed.
        assert calls["aborted"] == [key]
        # The row is not.
        assert version.processing_status == status_fn()
        assert result["versions_failed"] == 0

    def test_an_old_upload_with_no_database_row_is_aborted_and_logged(self):
        """Parts with no owner: /upload/initiate creates the multipart
        upload before it commits, so a request that died in between leaves
        exactly this, and nothing else will ever clean it up."""
        key = "raw/p/a/v/original.mxf"
        result, calls, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=FakeSession(),
        )
        assert calls["aborted"] == [key]
        assert result["unmatched"] == 1
        assert result["versions_failed"] == 0

    def test_only_the_raw_prefix_is_ever_asked_for(self):
        """The whole safety boundary. Renditions, posters, LUT exports and
        zips are not upload sessions and must never be aborted."""
        from apps.api.tasks import upload_sweep_tasks as mod

        _, calls, _ = run_sweep(uploads=[])
        assert calls["prefix"] == "raw/"
        assert mod.RAW_PREFIX == "raw/"


# ── c — ghost rows ─────────────────────────────────────────────────────────


class TestGhostRows:
    def test_an_old_uploading_row_with_no_store_upload_is_failed(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, _, db = run_sweep(uploads=[], session=session)
        assert version.processing_status == _failed()
        assert result["ghosts_failed"] == 1
        assert db.committed >= 1

    def test_a_row_younger_than_the_grace_period_is_left_alone(self):
        """/upload/initiate creates the multipart upload BEFORE committing
        the row, so the only window where a live upload could look like a
        ghost is between those two statements — milliseconds. The grace
        period is many orders of magnitude wider than that.

        The row IS handed over; the task's own cutoff is what excludes it.
        An earlier version of this test passed an empty list and asserted
        nothing happened, which would have passed against a sweep with no
        grace period at all.
        """
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(hours=1))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, calls, _ = run_sweep(uploads=[], session=session)
        assert result["ghosts_failed"] == 0
        assert version.processing_status == _uploading()
        # Never even asked the store about it.
        assert calls["exists"] == []

    def test_a_row_just_past_the_grace_period_is_failed(self):
        """The paired half: the cutoff is a cutoff, not a blanket refusal."""
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(hours=25))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, _, _ = run_sweep(uploads=[], session=session)
        assert result["ghosts_failed"] == 1
        assert version.processing_status == _failed()

    def test_a_soft_deleted_row_is_never_touched(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        version.deleted_at = NOW - timedelta(days=1)
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, _, _ = run_sweep(uploads=[], session=session)
        assert result["ghosts_failed"] == 0
        assert version.processing_status == _uploading()

    def test_a_row_whose_object_already_exists_is_kept_with_a_warning(self):
        """/upload/complete reached S3 and the commit did not. The bytes are
        there; a person may want to finish it. Failing the row would hide a
        recoverable asset behind a terminal status."""
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, calls, _ = run_sweep(uploads=[], session=session, exists={key: True})
        assert calls["exists"] == [key]
        assert version.processing_status == _uploading()
        assert result["ghosts_failed"] == 0
        assert result["ghosts_kept_object_exists"] == 1

    def test_an_unanswerable_store_does_not_fail_the_row(self):
        """"The store did not answer" is not "the object is gone"."""
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, _, _ = run_sweep(
            uploads=[], session=session, exists={key: RuntimeError("502")})
        assert version.processing_status == _uploading()
        assert result["ghosts_failed"] == 0
        assert result["errors"] == 1

    def test_a_row_whose_upload_is_still_open_is_not_a_ghost(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        session = FakeSession(ghosts=[(version, make_media_file(key, version.id))])
        result, _, _ = run_sweep(
            uploads=[upload(key, days_ago=1)], session=session)
        assert version.processing_status == _uploading()
        assert result["ghosts_failed"] == 0

    def test_a_row_whose_upload_was_just_aborted_is_not_failed_twice(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=30))
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
            ghosts=[(version, make_media_file(key, version.id))],
        )
        result, _, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=session,
        )
        assert result["versions_failed"] == 1
        assert result["ghosts_failed"] == 0

    def test_dry_run_does_not_report_the_same_row_twice(self):
        """Found by running the logic, not by reading it.

        In a live run pass 1's status write plus its commit hide the row
        from pass 2's `uploading` filter, so a double count is invisible.
        DRY RUN writes nothing — so the same row was reported once as a
        failed version and again as a failed ghost, in precisely the mode
        that exists to be read before anyone trusts this task.
        """
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading(), created_at=NOW - timedelta(days=30))
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
            ghosts=[(version, make_media_file(key, version.id))],
        )
        result, _, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=session,
            upload_sweep_dry_run=True,
        )
        assert result["versions_failed"] == 1
        assert result["ghosts_failed"] == 0


# ── d — pagination ─────────────────────────────────────────────────────────


class TestPagination:
    def test_more_than_one_page_of_uploads_is_fully_read(self):
        """Asserted against the real paginator in s3_service, with a fake
        client: the task's own view is just a list."""
        from apps.api.services import s3_service

        pages = [
            {"Uploads": [{"Key": f"raw/k{i}", "UploadId": f"u{i}",
                          "Initiated": NOW} for i in range(1000)],
             "IsTruncated": True, "NextKeyMarker": "raw/k999", "NextUploadIdMarker": "u999"},
            {"Uploads": [{"Key": f"raw/k{i}", "UploadId": f"u{i}",
                          "Initiated": NOW} for i in range(1000, 1500)],
             "IsTruncated": False},
        ]
        s3 = MagicMock()
        s3.list_multipart_uploads.side_effect = pages
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            got = s3_service.list_multipart_uploads_all("raw/")
        assert len(got) == 1500
        assert s3.list_multipart_uploads.call_count == 2
        # BOTH markers are sent back. One key can hold several open uploads,
        # so advancing only the key marker loops or skips.
        second = s3.list_multipart_uploads.call_args_list[1].kwargs
        assert second["KeyMarker"] == "raw/k999"
        assert second["UploadIdMarker"] == "u999"

    def test_a_key_outside_the_prefix_is_dropped_even_if_the_store_returns_it(self):
        from apps.api.services import s3_service

        s3 = MagicMock()
        s3.list_multipart_uploads.return_value = {
            "Uploads": [
                {"Key": "raw/good", "UploadId": "u1", "Initiated": NOW},
                {"Key": "hls/bad", "UploadId": "u2", "Initiated": NOW},
            ],
            "IsTruncated": False,
        }
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            got = s3_service.list_multipart_uploads_all("raw/")
        assert [u["Key"] for u in got] == ["raw/good"]

    def test_a_truncated_page_with_no_marker_does_not_spin(self):
        from apps.api.services import s3_service

        s3 = MagicMock()
        s3.list_multipart_uploads.return_value = {
            "Uploads": [{"Key": "raw/a", "UploadId": "u", "Initiated": NOW}],
            "IsTruncated": True,
        }
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            got = s3_service.list_multipart_uploads_all("raw/")
        assert len(got) == 1
        assert s3.list_multipart_uploads.call_count == 1

    def test_parts_carry_last_modified_through_every_page(self):
        """§215 added LastModified to §213's paginator rather than writing a
        second one. Both pages must carry it."""
        from apps.api.services import s3_service

        t1 = NOW - timedelta(days=9)
        t2 = NOW - timedelta(hours=2)
        s3 = MagicMock()
        s3.list_parts.side_effect = [
            {"Parts": [{"PartNumber": n, "ETag": f'"e{n}"', "Size": 16,
                        "LastModified": t1} for n in range(1, 1001)],
             "IsTruncated": True, "NextPartNumberMarker": 1000},
            {"Parts": [{"PartNumber": 1001, "ETag": '"e1001"', "Size": 16,
                        "LastModified": t2}],
             "IsTruncated": False},
        ]
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            got = s3_service.list_multipart_parts("raw/k", "u")
        assert len(got) == 1001
        assert got[0]["LastModified"] == t1
        assert got[-1]["LastModified"] == t2


# ── e — safety ─────────────────────────────────────────────────────────────


class TestSafety:
    def test_dry_run_changes_nothing(self):
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading())
        ghost = make_version(_uploading(), created_at=NOW - timedelta(days=5))
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
            ghosts=[(ghost, make_media_file("raw/other", ghost.id))],
        )
        result, calls, db = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=session,
            upload_sweep_dry_run=True,
        )
        assert calls["aborted"] == []
        assert version.processing_status == _uploading()
        assert ghost.processing_status == _uploading()
        assert db.committed == 0
        # …but it still REPORTS what it would have done.
        assert result["dry_run"] is True
        assert result["aborted"] == 1
        assert result["versions_failed"] == 1
        assert result["ghosts_failed"] == 1

    def test_the_cap_stops_after_n_and_says_so(self):
        keys = [f"raw/p/a/v{i}/original.mxf" for i in range(5)]
        result, calls, _ = run_sweep(
            uploads=[upload(k, days_ago=30 + i, upload_id=f"u{i}")
                     for i, k in enumerate(keys)],
            parts_by_key={k: parts(count=1, newest_days_ago=30) for k in keys},
            upload_sweep_max_aborts=2,
        )
        assert len(calls["aborted"]) == 2
        assert result["aborted"] == 2
        assert result["capped"] is True

    def test_one_failing_abort_does_not_stop_the_others(self):
        keys = ["raw/a/original.mxf", "raw/b/original.mxf", "raw/c/original.mxf"]
        result, calls, _ = run_sweep(
            uploads=[upload(k, days_ago=30 + i, upload_id=f"u{i}")
                     for i, k in enumerate(keys)],
            parts_by_key={k: parts(count=1, newest_days_ago=30) for k in keys},
            abort_raises={keys[1]: RuntimeError("500 from the store")},
        )
        assert set(calls["aborted"]) == set(keys)      # all three attempted
        assert result["aborted"] == 2                  # two succeeded
        assert result["errors"] == 1

    def test_one_failing_parts_read_does_not_stop_the_others(self):
        keys = ["raw/a/original.mxf", "raw/b/original.mxf"]
        result, calls, _ = run_sweep(
            uploads=[upload(k, days_ago=30 + i, upload_id=f"u{i}")
                     for i, k in enumerate(keys)],
            parts_by_key={k: parts(count=1, newest_days_ago=30) for k in keys},
            parts_raises={keys[0]: RuntimeError("502")},
        )
        assert calls["aborted"] == [keys[1]]
        assert result["errors"] == 1

    def test_disabled_does_nothing_at_all(self):
        result, calls, _ = run_sweep(
            uploads=[upload("raw/a", days_ago=99)], upload_sweep_enabled=False)
        assert result == {"enabled": False}
        assert calls["list_uploads"] == 0

    def test_a_second_run_is_idempotent(self):
        """Nothing is left for the next tick to redo — the aborted upload is
        gone from the store, so the second run has no work."""
        key = "raw/p/a/v/original.mxf"
        version = make_version(_uploading())
        session = FakeSession(
            media_files={key: make_media_file(key, version.id)},
            versions={version.id: version},
        )
        first, calls1, _ = run_sweep(
            uploads=[upload(key, days_ago=30)],
            parts_by_key={key: parts(count=2, newest_days_ago=30)},
            session=session,
        )
        assert first["aborted"] == 1
        second, calls2, _ = run_sweep(uploads=[], session=session)
        assert second["aborted"] == 0
        assert second["ghosts_failed"] == 0
        assert calls2["aborted"] == []

    def test_a_failure_listing_uploads_rolls_back_and_raises(self):
        session = FakeSession()
        with pytest.raises(RuntimeError):
            run_sweep(uploads_raises=RuntimeError("store down"), session=session)
        assert session.rolled_back == 1
        assert session.closed is True


# ── f — object_exists ──────────────────────────────────────────────────────


class TestObjectExists:
    def test_a_clean_404_is_false(self):
        from botocore.exceptions import ClientError
        from apps.api.services import s3_service

        s3 = MagicMock()
        s3.head_object.side_effect = ClientError(
            {"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            assert s3_service.object_exists("raw/k") is False

    def test_anything_else_raises_rather_than_reading_as_absent(self):
        """A False here fails a database row, so an unanswered store must
        never be flattened into "not there"."""
        from botocore.exceptions import ClientError
        from apps.api.services import s3_service

        s3 = MagicMock()
        s3.head_object.side_effect = ClientError(
            {"Error": {"Code": "InternalError", "Message": "boom"}}, "HeadObject")
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            with pytest.raises(ClientError):
                s3_service.object_exists("raw/k")

    def test_a_present_object_is_true(self):
        from apps.api.services import s3_service

        s3 = MagicMock()
        s3.head_object.return_value = {"ContentLength": 10}
        with patch.object(s3_service, "get_s3_client", return_value=s3):
            assert s3_service.object_exists("raw/k") is True


# ── g — the wiring, read from the REAL config ──────────────────────────────


class TestItActuallyReachesAWorker:
    """A test of the function alone would pass for a task that never runs.

    Five tasks in `celery_app.py` reached production unrouted and silently
    never executed (§126, §143, §182). So this reads the LIVE
    `celery_app.conf`, not the source text: `task_routes` as Celery has
    parsed it, and `beat_schedule` as beat would read it.
    """

    def test_the_task_is_registered_under_its_name(self):
        from apps.api.tasks.celery_app import celery_app
        import apps.api.tasks.upload_sweep_tasks  # noqa: F401 — registers it

        assert "sweep_abandoned_uploads" in celery_app.tasks

    def test_it_is_routed_to_a_queue_by_its_bare_name(self):
        """It declares `name=`, so a module glob cannot match it — the exact
        trap that stranded apply_watermark and purge_expired_trash."""
        from apps.api.tasks.celery_app import celery_app

        routes = celery_app.conf.task_routes
        assert routes.get("sweep_abandoned_uploads") == {"queue": "transcoding"}

    def test_the_module_glob_is_there_too_for_anything_added_later(self):
        from apps.api.tasks.celery_app import celery_app

        routes = celery_app.conf.task_routes
        assert routes.get("apps.api.tasks.upload_sweep_tasks.*") == {"queue": "transcoding"}

    def test_it_is_scheduled(self):
        from apps.api.tasks.celery_app import celery_app

        tasks = {e["task"] for e in celery_app.conf.beat_schedule.values()}
        assert "sweep_abandoned_uploads" in tasks

    def test_transcoding_is_a_declared_queue(self):
        from apps.api.tasks.celery_app import celery_app

        names = {q.name for q in celery_app.conf.task_queues}
        assert "transcoding" in names

    def test_it_is_not_on_the_knowingly_unrouted_list(self):
        from apps.api.tasks.celery_app import KNOWN_UNROUTED

        assert "sweep_abandoned_uploads" not in KNOWN_UNROUTED
