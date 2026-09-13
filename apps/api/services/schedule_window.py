"""Deciding whether a ticking task is inside its daily wall-clock window (§182).

Celery's own `timezone` stays "UTC" permanently and is deliberately NOT
derived from `site_settings.timezone`. A running beat scheduler does not
reliably pick up a timezone change — it would need a restart at best, and
its behaviour mid-flight is exactly the kind of thing that cannot be
verified from here. Rather than build on that, the wall-clock-sensitive
jobs (`purge_expired_trash`, `reconcile_file_sizes`) are scheduled every 15
minutes in UTC and each asks, on every tick, "is it my hour where the admin
actually lives?"

Two consequences worth stating, because they are the point:

  * A timezone change takes effect on the NEXT TICK. No restart, no
    redeploy, no Celery involvement at all — the value is read from the
    database inside the task body, not captured at import or at worker
    start.
  * Tick granularity and window width are the same 15 minutes on purpose.
    A window narrower than the tick could be stepped over entirely; a wider
    one would let the job run twice in a day.

Non-whole-hour offsets are handled for free by `zoneinfo` and are covered
by tests: Asia/Kolkata (UTC+5:30) crosses the hour boundary at :30 past,
so a naive hour-offset implementation would fire at the wrong wall-clock
time there — which is precisely why this converts an instant rather than
adding an offset to an hour number.
"""

import logging
from datetime import datetime, timezone as dt_timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

#: Must match the beat cadence of the jobs that use this. See the module
#: docstring: window width and tick interval are deliberately equal.
WINDOW_MINUTES = 15

DEFAULT_TIMEZONE = "UTC"


def resolve_zone(name: str | None) -> ZoneInfo:
    """An IANA zone, falling back to UTC rather than raising.

    A bad value here would otherwise take down a maintenance sweep on every
    tick, forever, over a settings-page typo. UTC is the same thing the
    column defaults to, so the failure mode is "runs at the old time",
    not "stops running" — and it is logged so it is findable.
    """
    if not name:
        return ZoneInfo(DEFAULT_TIMEZONE)
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        logger.warning(
            "site_settings.timezone is %r, which is not a known IANA zone; "
            "falling back to %s", name, DEFAULT_TIMEZONE,
        )
        return ZoneInfo(DEFAULT_TIMEZONE)


def is_valid_timezone(name: str) -> bool:
    """Whether a string names a real zone — for validating admin input."""
    try:
        ZoneInfo(name)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def local_now(tz_name: str | None, now: datetime | None = None) -> datetime:
    """`now` as wall-clock time in `tz_name`.

    Converts an instant rather than adding an offset to an hour number,
    which is what makes half-hour zones (Asia/Kolkata, +5:30) and DST
    transitions come out right without special cases.
    """
    instant = now or datetime.now(dt_timezone.utc)
    if instant.tzinfo is None:
        # A naive datetime from a caller is UTC by this codebase's
        # convention; assuming local time here would silently shift every
        # window by the host's own zone.
        instant = instant.replace(tzinfo=dt_timezone.utc)
    return instant.astimezone(resolve_zone(tz_name))


def in_daily_window(
    tz_name: str | None,
    hour: int,
    minute: int = 0,
    now: datetime | None = None,
    window_minutes: int = WINDOW_MINUTES,
) -> bool:
    """Is it currently within `window_minutes` of `hour`:`minute` locally?

    `minute` must be a multiple of the window so a window cannot straddle
    an hour boundary — with 15-minute ticks the only sensible starts are
    :00, :15, :30 and :45, and each of those is exactly one tick.

    Returns True for exactly one tick per day in that zone. On the day a
    zone springs forward and the target hour does not exist locally, that
    day's run is skipped — deliberately: these are daily maintenance jobs
    whose work is cumulative and idempotent, so one skipped night costs
    nothing, whereas inventing a substitute hour would make the rule harder
    to reason about than the thing it protects. On the day a zone falls
    back, the hour repeats and the job runs twice; both jobs behind this
    are idempotent (one deletes what is past its retention, the other
    verifies what is unverified), so a second pass finds nothing to do.
    """
    local = local_now(tz_name, now)
    return local.hour == hour and minute <= local.minute < minute + window_minutes
