"""Why a 103-file zip used to never finish, and what now stops it (§146).

Three independent failures were in play and each has its own test here:

  1. the build fetched one object at a time, so a real batch simply ran
     past the client's 30-minute deadline with nothing stuck;
  2. no Celery task in this codebase had a time limit, so a genuinely
     wedged build held its row at "building" forever;
  3. the status route echoed that row verbatim, so the client polled a
     dead build until it timed out and blamed itself.
"""
import time
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.zip_export import ZipExportStatus


# ── 1. bounded concurrency actually overlaps the fetches ─────────────────

class _SlowBody:
    """An S3 body whose read costs real wall time, like a network fetch."""

    def __init__(self, payload: bytes, delay: float):
        self._payload = payload
        self._delay = delay
        self._done = False

    def read(self, _n=None):
        if self._done:
            return b""
        time.sleep(self._delay)
        self._done = True
        return self._payload


def _client_with_delay(delay: float, calls: list):
    client = MagicMock()

    def get_object(Bucket=None, Key=None):
        calls.append(Key)
        return {"Body": _SlowBody(b"x" * 32, delay)}

    client.get_object.side_effect = get_object
    return client


def _export(n_files: int):
    export = MagicMock()
    export.id = uuid.uuid4()
    export.status = ZipExportStatus.pending
    export.s3_key = f"zip-exports/p/link/l/{export.id}.zip"
    export.manifest = [
        {"s3_key": f"raw/{i}.bin", "path": f"f{i}.bin", "needs_render": False}
        for i in range(n_files)
    ]
    export.files_done = 0
    return export


def _run_build(export, client):
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = export
    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.zip_tasks.s3_service.get_s3_client", return_value=client), \
         patch("apps.api.tasks.zip_tasks.delete_zip_export"):
        from apps.api.tasks.zip_tasks import build_zip_export
        start = time.monotonic()
        build_zip_export.run(str(export.id))
        return time.monotonic() - start


def test_files_are_fetched_concurrently_not_one_at_a_time():
    """The actual fix for "it just keeps working and working".

    12 files x 0.25s is 3s strictly sequentially. With the pool it must come
    in near 12/6 x 0.25 = 0.5s — the assertion is deliberately loose (under
    half the sequential time) so it measures overlap rather than a
    particular machine's speed.
    """
    from apps.api.tasks.zip_tasks import _CONCURRENT_FETCHES

    n, delay = 12, 0.25
    sequential = n * delay
    calls: list = []
    export = _export(n)
    elapsed = _run_build(export, _client_with_delay(delay, calls))

    assert len(calls) == n, "every file must still be fetched exactly once"
    assert export.status == ZipExportStatus.ready
    assert elapsed < sequential / 2, (
        f"took {elapsed:.2f}s for {n} files; sequential would be ~{sequential:.2f}s "
        f"— the fetches are not overlapping"
    )
    assert _CONCURRENT_FETCHES > 1


def test_every_file_still_lands_in_the_archive():
    """Concurrency must not lose or duplicate a member."""
    import io, zipfile

    uploaded = {}
    client = _client_with_delay(0.0, [])
    client.put_object.side_effect = lambda **kw: uploaded.update(
        {"body": kw["Body"].read()}
    )
    export = _export(9)
    _run_build(export, client)

    z = zipfile.ZipFile(io.BytesIO(uploaded["body"]))
    assert sorted(z.namelist()) == sorted(f"f{i}.bin" for i in range(9))
    assert export.files_done == 9


def test_one_unreadable_file_does_not_lose_the_others():
    calls: list = []
    client = _client_with_delay(0.0, calls)
    original = client.get_object.side_effect

    def flaky(Bucket=None, Key=None):
        if Key == "raw/3.bin":
            raise RuntimeError("object missing")
        return original(Bucket=Bucket, Key=Key)

    client.get_object.side_effect = flaky
    export = _export(6)
    _run_build(export, client)

    assert export.status == ZipExportStatus.ready
    bad = [e for e in export.manifest if e["s3_key"] == "raw/3.bin"][0]
    assert bad.get("skipped")
    assert all(not e.get("skipped") for e in export.manifest if e is not bad)


def test_progress_is_recorded_as_files_land():
    """`progress_at` is what staleness measures; a build that never set it
    would be declared dead the moment the threshold passed."""
    export = _export(4)
    _run_build(export, _client_with_delay(0.0, []))
    assert export.files_done == 4
    assert export.progress_at is not None


# ── 2. the time-limit backstop ───────────────────────────────────────────

def test_soft_time_limit_marks_the_row_failed_rather_than_wedged():
    """The row must not be left at "building" for the TTL.

    Not retried either: the build already had its full budget, and a retry
    would occupy a worker for another 20 minutes to hit the same wall.
    """
    from celery.exceptions import SoftTimeLimitExceeded

    export = _export(3)
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = export
    client = MagicMock()
    client.get_object.side_effect = SoftTimeLimitExceeded()

    with patch("apps.api.tasks.zip_tasks.SessionLocal", return_value=db), \
         patch("apps.api.tasks.zip_tasks.s3_service.get_s3_client", return_value=client):
        from apps.api.tasks.zip_tasks import build_zip_export
        build_zip_export.run(str(export.id))   # must not raise / retry

    assert export.status == ZipExportStatus.failed
    assert "too long" in (export.error or "")


def test_the_task_declares_time_limits_at_all():
    """Before §146 no task in this codebase had one — that is the gap."""
    from apps.api.tasks.zip_tasks import (
        ZIP_HARD_TIME_LIMIT, ZIP_SOFT_TIME_LIMIT, build_zip_export,
    )

    assert build_zip_export.soft_time_limit == ZIP_SOFT_TIME_LIMIT
    assert build_zip_export.time_limit == ZIP_HARD_TIME_LIMIT
    assert ZIP_SOFT_TIME_LIMIT < ZIP_HARD_TIME_LIMIT


def test_the_ceilings_are_ordered_so_the_server_fails_before_the_client():
    """Ordering is the whole point: soft < hard < staleness < the browser's
    30-minute deadline, so a doomed build becomes a real error the user can
    act on instead of "taking longer than expected"."""
    from apps.api.tasks.zip_tasks import ZIP_HARD_TIME_LIMIT, ZIP_SOFT_TIME_LIMIT
    from apps.api.services.zip_export_service import ZIP_STALE_AFTER_SECONDS

    CLIENT_DEADLINE = 30 * 60
    assert ZIP_SOFT_TIME_LIMIT < ZIP_HARD_TIME_LIMIT < ZIP_STALE_AFTER_SECONDS < CLIENT_DEADLINE


# ── 3. staleness resolves the ROW, not just one response ─────────────────

def _row(status, *, progress_age_s=None, created_age_s=0, files_done=0):
    now = datetime.now(timezone.utc)
    r = MagicMock()
    r.id = uuid.uuid4()
    r.status = status
    r.files_done = files_done
    r.created_at = now - timedelta(seconds=created_age_s)
    r.progress_at = None if progress_age_s is None else now - timedelta(seconds=progress_age_s)
    r.s3_key = f"zip-exports/p/link/l/{r.id}.zip"
    r.error = None
    return r


def test_a_build_making_progress_is_never_declared_stale():
    """A slow but advancing build must survive — failing it would be worse
    than the bug."""
    from apps.api.services.zip_export_service import is_stale

    assert not is_stale(_row(ZipExportStatus.building, progress_age_s=60, created_age_s=99999))


def test_a_build_whose_progress_stopped_is_stale():
    from apps.api.services.zip_export_service import ZIP_STALE_AFTER_SECONDS, is_stale

    assert is_stale(_row(ZipExportStatus.building, progress_age_s=ZIP_STALE_AFTER_SECONDS + 60))


def test_a_build_that_died_before_its_first_file_is_stale():
    """No progress_at at all — measured from created_at instead."""
    from apps.api.services.zip_export_service import ZIP_STALE_AFTER_SECONDS, is_stale

    assert is_stale(_row(ZipExportStatus.pending, created_age_s=ZIP_STALE_AFTER_SECONDS + 60))


@pytest.mark.parametrize("status", [ZipExportStatus.ready, ZipExportStatus.failed])
def test_a_finished_build_is_never_stale(status):
    from apps.api.services.zip_export_service import is_stale

    assert not is_stale(_row(status, created_age_s=10 ** 6))


def test_the_status_route_WRITES_the_failure_not_just_reports_it():
    """The fix must resolve the row, not change one response.

    A compute-on-read that only altered the payload would leave the next
    poll — and the sweep, and the cache-reuse lookup — still seeing
    "building".
    """
    from apps.api.routers.share import _resolve_if_stale
    from apps.api.services.zip_export_service import ZIP_STALE_AFTER_SECONDS

    row = _row(ZipExportStatus.building, progress_age_s=ZIP_STALE_AFTER_SECONDS + 60)
    db = MagicMock()
    _resolve_if_stale(db, row)

    assert row.status == ZipExportStatus.failed
    assert row.error
    assert db.commit.called, "the row must be persisted, not just mutated in memory"


def test_the_status_route_leaves_a_healthy_build_alone():
    from apps.api.routers.share import _resolve_if_stale

    row = _row(ZipExportStatus.building, progress_age_s=5)
    db = MagicMock()
    _resolve_if_stale(db, row)

    assert row.status == ZipExportStatus.building
    assert not db.commit.called
