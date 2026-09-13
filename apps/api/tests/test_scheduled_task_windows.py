"""The daily jobs read their timezone LIVE, on every tick (§182).

The design claim being tested: changing `site_settings.timezone` takes
effect on the next 15-minute tick, with no worker restart and no Celery
involvement. That only holds if the value is read from the database inside
the task body — captured at import, at worker start, or memoised anywhere,
the claim is false and nothing about the code's shape would say so.

So these call the real task functions twice with the DB returning a
DIFFERENT zone the second time, and assert the behaviour changes. A test
that only ran each task once would pass against an implementation that read
the setting once at import.
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest


def utc(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


def _db_returning(*timezones):
    """A SessionLocal whose successive calls see different saved zones.

    Mimics an admin changing the setting between two ticks of a
    long-running worker.
    """
    rows = [MagicMock(timezone=tz) for tz in timezones]
    calls = {"n": 0}

    def factory():
        db = MagicMock()
        idx = min(calls["n"], len(rows) - 1)
        calls["n"] += 1
        db.query.return_value.first.return_value = rows[idx]
        return db

    return factory


# ── purge_expired_trash ─────────────────────────────────────────────────────

class TestPurgeWindow:
    def _run(self, tz_factory, now):
        from apps.api.tasks import purge_tasks

        empty = {"assets": 0, "folders": 0, "objects": 0, "failed": 0, "cutoff": "x"}
        with patch.object(purge_tasks, "SessionLocal", tz_factory), \
             patch.object(purge_tasks, "purge_expired", return_value=dict(empty)) as purged, \
             patch("apps.api.services.schedule_window.datetime") as dt:
            dt.now.return_value = now
            # Only `datetime.now` is stubbed; everything else on the class
            # must keep working or astimezone() breaks.
            dt.side_effect = datetime
            result = purge_tasks.purge_expired_trash()
        return result, purged

    def test_it_no_ops_outside_its_local_window(self):
        # 02:00 UTC is 03:00 in Vienna in January — but this DB says UTC,
        # so locally it is 02:00 and the job must not run.
        result, purged = self._run(_db_returning("UTC"), utc(2026, 1, 15, 2, 0))

        assert result["skipped"] is True
        purged.assert_not_called()

    def test_it_runs_inside_its_local_window(self):
        result, purged = self._run(_db_returning("Europe/Vienna"), utc(2026, 1, 15, 2, 0))

        assert result.get("skipped") is False
        purged.assert_called_once()

    def test_the_same_instant_flips_behaviour_when_the_setting_changes(self):
        """The live-reload claim, at one fixed instant.

        Identical UTC time, identical code, different saved zone — one
        skips and one runs. Nothing was restarted between them.
        """
        instant = utc(2026, 1, 15, 2, 0)

        skipped, not_purged = self._run(_db_returning("UTC"), instant)
        ran, purged = self._run(_db_returning("Europe/Vienna"), instant)

        assert skipped["skipped"] is True and not_purged.call_count == 0
        assert ran["skipped"] is False and purged.call_count == 1

    def test_a_change_between_two_ticks_of_one_worker_takes_effect(self):
        """Sharper version: ONE factory, handing out a different saved zone
        on its second call — an admin saving the settings page between two
        ticks. The second tick must see it."""
        factory = _db_returning("UTC", "Europe/Vienna")
        instant = utc(2026, 1, 15, 2, 0)
        from apps.api.tasks import purge_tasks

        results = []
        with patch.object(purge_tasks, "SessionLocal", factory), \
             patch.object(purge_tasks, "purge_expired", return_value={
                 "assets": 0, "folders": 0, "objects": 0, "failed": 0, "cutoff": "x"}), \
             patch("apps.api.services.schedule_window.datetime") as dt:
            dt.now.return_value = instant
            dt.side_effect = datetime
            results.append(purge_tasks.purge_expired_trash())   # reads "UTC"
            results.append(purge_tasks.purge_expired_trash())   # reads "Europe/Vienna"

        assert results[0]["skipped"] is True, "first tick should have been outside the window"
        assert results[1]["skipped"] is False, (
            "the second tick did not see the new timezone — the setting is "
            "being cached somewhere instead of read per tick"
        )

    def test_the_timezone_is_read_on_every_single_tick(self):
        """Structural backstop for the above: a memoised read would still
        pass the two-tick test if the cache happened to expire."""
        import inspect
        from apps.api.tasks import purge_tasks

        body = inspect.getsource(purge_tasks.purge_expired_trash)
        assert "_configured_timezone()" in body
        src = inspect.getsource(purge_tasks._configured_timezone)
        assert "SessionLocal()" in src and "lru_cache" not in src


# ── reconcile_file_sizes ────────────────────────────────────────────────────

class TestReconcileWindow:
    def _run(self, tz, now):
        from apps.api.tasks import reconcile_tasks

        with patch.object(reconcile_tasks, "SessionLocal", _db_returning(tz)), \
             patch("apps.api.scripts.reconcile_file_sizes.main", return_value=0) as backfill, \
             patch("apps.api.services.schedule_window.datetime") as dt:
            dt.now.return_value = now
            dt.side_effect = datetime
            result = reconcile_tasks.reconcile_file_sizes()
        return result, backfill

    def test_it_no_ops_outside_the_window(self):
        result, backfill = self._run("Europe/Vienna", utc(2026, 1, 15, 2, 0))

        # 03:00 local — the purge's slot, not this one.
        assert result["skipped"] is True
        backfill.assert_not_called()

    def test_it_runs_at_03_45_local(self):
        result, backfill = self._run("Europe/Vienna", utc(2026, 1, 15, 2, 45))

        assert result["skipped"] is False
        backfill.assert_called_once()

    def test_summer_shifts_the_utc_instant_by_an_hour(self):
        """Same local 03:45, an hour earlier in UTC under CEST."""
        result, backfill = self._run("Europe/Vienna", utc(2026, 7, 15, 1, 45))

        assert result["skipped"] is False
        backfill.assert_called_once()

    def test_a_half_hour_offset_zone_lands_correctly(self):
        """Kolkata is +5:30, so 03:45 local is 22:15 UTC the day before."""
        result, backfill = self._run("Asia/Kolkata", utc(2026, 1, 14, 22, 15))

        assert result["skipped"] is False
        backfill.assert_called_once()

    def test_it_reuses_the_backfill_script_rather_than_reimplementing_it(self):
        """§181 owns the batching, the pause, and the missing-object
        categories. A second implementation would drift from the first
        exactly where it matters least visibly."""
        _result, backfill = self._run("Europe/Vienna", utc(2026, 1, 15, 2, 45))

        args = backfill.call_args[0][0]
        assert "--write" in args
        assert "--batch-size" in args, "the nightly run must batch"
        assert "--sleep" in args, "the nightly run must pace itself against live traffic"

    def test_a_findings_exit_code_does_not_raise(self):
        """A sweep that crashes on a finding stops sweeping. The finding is
        already in the log with the detail a person needs."""
        from apps.api.tasks import reconcile_tasks

        with patch.object(reconcile_tasks, "SessionLocal", _db_returning("UTC")), \
             patch("apps.api.scripts.reconcile_file_sizes.main", return_value=1), \
             patch("apps.api.services.schedule_window.datetime") as dt:
            dt.now.return_value = utc(2026, 1, 15, 3, 45)
            dt.side_effect = datetime
            result = reconcile_tasks.reconcile_file_sizes()

        assert result["exit_code"] == 1
        assert result["skipped"] is False

    def test_a_skipped_tick_is_distinguishable_from_an_empty_run(self):
        """Both look identical in a log otherwise — which is the shape of
        the bug §182 exists to stop repeating."""
        skipped, _ = self._run("Europe/Vienna", utc(2026, 1, 15, 12, 0))
        ran, _ = self._run("Europe/Vienna", utc(2026, 1, 15, 2, 45))

        assert skipped["skipped"] is True and "local_time" in skipped
        assert ran["skipped"] is False and "exit_code" in ran


# ── the two windows must not collide ────────────────────────────────────────

def test_the_two_jobs_never_run_on_the_same_tick():
    """Both issue real volumes of S3 calls against the same AIStor endpoint.
    Asserted from the tasks' own constants rather than by repeating the
    numbers here, so moving one moves this check with it."""
    from apps.api.tasks.purge_tasks import RUN_HOUR as PURGE_HOUR
    from apps.api.tasks.reconcile_tasks import RUN_HOUR, RUN_MINUTE_FROM
    from apps.api.services.schedule_window import WINDOW_MINUTES

    if PURGE_HOUR != RUN_HOUR:
        return  # different hours entirely; nothing to check
    assert RUN_MINUTE_FROM >= WINDOW_MINUTES, (
        "the reconcile window starts inside the purge window"
    )
