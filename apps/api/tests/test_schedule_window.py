"""The wall-clock gate on the daily maintenance jobs (§182).

Celery's own timezone stays "UTC" permanently. The jobs that care about a
wall-clock hour — `purge_expired_trash` and `reconcile_file_sizes` — tick
every 15 minutes and decide for themselves whether it is their hour in
`site_settings.timezone`.

Two properties are worth more than the rest and are tested hardest:

  * DST. A fixed UTC hour drifts by an hour twice a year relative to any
    zone that observes it, which is the whole reason the old
    `crontab(hour=3)` only accidentally meant "out of hours". Tested on a
    real winter date AND a real summer date.
  * Non-whole-hour offsets. Asia/Kolkata is UTC+5:30, so an implementation
    that added an offset to an hour number rather than converting an
    instant would fire at the wrong wall-clock time there — and would pass
    every test that only used whole-hour zones.
"""

from datetime import datetime, timedelta, timezone

import pytest

from apps.api.services.schedule_window import (
    DEFAULT_TIMEZONE,
    WINDOW_MINUTES,
    in_daily_window,
    is_valid_timezone,
    local_now,
    resolve_zone,
)


def utc(y, m, d, hh, mm=0):
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


# ── DST: the same local hour, two different UTC instants ────────────────────

class TestDaylightSaving:
    """Vienna is UTC+1 in winter (CET) and UTC+2 in summer (CEST)."""

    def test_winter_03_00_local_is_02_00_utc(self):
        # 15 January — CET, UTC+1.
        assert in_daily_window("Europe/Vienna", 3, now=utc(2026, 1, 15, 2, 0)) is True

    def test_summer_03_00_local_is_01_00_utc(self):
        # 15 July — CEST, UTC+2. A full hour earlier in UTC than the winter
        # case above, for the same local time.
        assert in_daily_window("Europe/Vienna", 3, now=utc(2026, 7, 15, 1, 0)) is True

    def test_the_winter_instant_is_the_wrong_hour_in_summer(self):
        """The drift, stated as an assertion. 02:00 UTC is 03:00 in Vienna
        in January and 04:00 in July — so a fixed UTC schedule cannot mean
        one local hour all year, which is exactly what the old crontab
        claimed to."""
        assert in_daily_window("Europe/Vienna", 3, now=utc(2026, 7, 15, 2, 0)) is False
        assert local_now("Europe/Vienna", utc(2026, 7, 15, 2, 0)).hour == 4

    def test_a_southern_hemisphere_zone_drifts_the_other_way(self):
        """Sydney is UTC+11 in January (AEDT) and UTC+10 in July (AEST) —
        the opposite sign to Vienna, which a hardcoded +1/+2 would get
        backwards."""
        assert in_daily_window("Australia/Sydney", 3, now=utc(2026, 1, 14, 16, 0)) is True
        assert in_daily_window("Australia/Sydney", 3, now=utc(2026, 7, 14, 17, 0)) is True

    def test_a_zone_without_dst_is_the_same_instant_all_year(self):
        for month in (1, 7):
            assert in_daily_window("Asia/Tokyo", 3, now=utc(2026, month, 15, 18, 0)) is True


# ── non-whole-hour offsets ──────────────────────────────────────────────────

class TestHalfHourOffsets:
    """The case an hour-arithmetic implementation gets silently wrong."""

    def test_kolkata_at_utc_plus_5_30(self):
        # 21:30 UTC is 03:00 the next day in Kolkata.
        assert in_daily_window("Asia/Kolkata", 3, now=utc(2026, 1, 14, 21, 30)) is True

    def test_kolkata_on_the_hour_is_NOT_the_window(self):
        """22:00 UTC is 03:30 local — past the 15-minute window. An
        implementation that rounded to whole hours would fire here."""
        assert in_daily_window("Asia/Kolkata", 3, now=utc(2026, 1, 14, 22, 0)) is False

    def test_kolkata_is_really_offset_by_thirty_minutes(self):
        local = local_now("Asia/Kolkata", utc(2026, 1, 14, 21, 30))
        assert (local.hour, local.minute) == (3, 0)
        assert local.utcoffset() == timedelta(hours=5, minutes=30)

    def test_kathmandu_at_utc_plus_5_45(self):
        """A 45-minute offset, because those exist too."""
        assert in_daily_window("Asia/Kathmandu", 3, now=utc(2026, 1, 14, 21, 15)) is True

    def test_chatham_at_a_45_minute_offset_with_dst(self):
        """Both complications at once: +12:45 in winter, +13:45 in summer."""
        assert in_daily_window("Pacific/Chatham", 3, now=utc(2026, 7, 14, 14, 15)) is True
        assert in_daily_window("Pacific/Chatham", 3, now=utc(2026, 1, 14, 13, 15)) is True


# ── the window itself ───────────────────────────────────────────────────────

class TestTheWindow:
    def test_it_opens_exactly_on_the_hour(self):
        assert in_daily_window("UTC", 3, now=utc(2026, 3, 1, 3, 0)) is True

    @pytest.mark.parametrize("minute", [0, 7, 14])
    def test_every_minute_inside_the_window_counts(self, minute):
        assert in_daily_window("UTC", 3, now=utc(2026, 3, 1, 3, minute)) is True

    @pytest.mark.parametrize("minute", [15, 30, 45, 59])
    def test_it_closes_after_the_tick_interval(self, minute):
        """Window width equals tick interval on purpose: wider and the job
        runs twice a day, narrower and a tick could step over it."""
        assert in_daily_window("UTC", 3, now=utc(2026, 3, 1, 3, minute)) is False

    def test_exactly_one_tick_per_day_matches(self):
        """The property that makes a */15 schedule behave like a daily one."""
        start = utc(2026, 6, 1, 0, 0)
        hits = [
            start + timedelta(minutes=15 * i)
            for i in range(96)
            if in_daily_window("Europe/Vienna", 3, now=start + timedelta(minutes=15 * i))
        ]
        assert len(hits) == 1, [h.isoformat() for h in hits]

    def test_an_offset_window_does_not_overlap_the_hour_window(self):
        """purge runs at :00 and reconcile at :45 — they must never collide,
        since both hammer the same S3 endpoint."""
        start = utc(2026, 6, 1, 0, 0)
        for i in range(96):
            t = start + timedelta(minutes=15 * i)
            at_00 = in_daily_window("Europe/Vienna", 3, 0, now=t)
            at_45 = in_daily_window("Europe/Vienna", 3, 45, now=t)
            assert not (at_00 and at_45), t.isoformat()

    def test_the_offset_window_fires_once_too(self):
        start = utc(2026, 6, 1, 0, 0)
        hits = [
            i for i in range(96)
            if in_daily_window("Europe/Vienna", 3, 45, now=start + timedelta(minutes=15 * i))
        ]
        assert len(hits) == 1

    def test_the_window_matches_the_documented_constant(self):
        """If the beat cadence and this ever disagree, the job runs twice or
        not at all — so the constant is asserted, not assumed."""
        assert WINDOW_MINUTES == 15


# ── bad input must not stop the sweeps forever ──────────────────────────────

class TestBadZones:
    @pytest.mark.parametrize("bad", ["Mars/Olympus", "not a zone", "Europe/Viena", ""])
    def test_an_unknown_zone_falls_back_to_utc(self, bad):
        """Not an exception: a settings-page typo must not take a nightly
        maintenance job offline permanently."""
        assert str(resolve_zone(bad)) == DEFAULT_TIMEZONE

    def test_none_falls_back_too(self):
        assert str(resolve_zone(None)) == DEFAULT_TIMEZONE

    def test_a_bad_zone_still_runs_the_job_on_utc(self):
        assert in_daily_window("Mars/Olympus", 3, now=utc(2026, 1, 15, 3, 0)) is True

    @pytest.mark.parametrize("good", ["UTC", "Europe/Vienna", "Asia/Kolkata", "America/New_York"])
    def test_real_zones_validate(self, good):
        assert is_valid_timezone(good) is True

    @pytest.mark.parametrize("bad", ["Mars/Olympus", "CEST", "GMT+2:00", ""])
    def test_nonsense_does_not_validate(self, bad):
        assert is_valid_timezone(bad) is False

    def test_a_naive_datetime_is_read_as_utc(self):
        """Assuming host-local here would shift every window by whatever
        zone the container happens to be in."""
        naive = datetime(2026, 1, 15, 2, 0)
        assert local_now("Europe/Vienna", naive).hour == 3


def test_the_zone_database_is_actually_present():
    """The silent failure this whole design is exposed to.

    `resolve_zone` deliberately falls back to UTC rather than raising, so an
    image with no IANA database would run every nightly job at the wrong
    local hour and report nothing. That safety net is right for a typo and
    wrong for a missing dependency, so the dependency is asserted here
    instead — this is the only place the difference is visible.
    """
    assert str(resolve_zone("Europe/Vienna")) == "Europe/Vienna"
    assert str(resolve_zone("Asia/Kolkata")) == "Asia/Kolkata"
    assert local_now("Europe/Vienna", utc(2026, 1, 15, 2, 0)).hour == 3, (
        "the zone database is missing or empty; every scheduled job would "
        "silently fall back to UTC"
    )
