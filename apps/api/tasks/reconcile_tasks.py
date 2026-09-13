"""Nightly file-size reconciliation sweep (§181 backfill, scheduled by §182).

§180 made every new upload check its own size against S3 at completion, and
left `media_files.size_verified_at` NULL on everything older and on any row
whose check failed. §181 built the backfill that works that queue; this is
the same code on a schedule, so the queue drains and stays drained rather
than needing someone to remember to run a script.

The work is NOT reimplemented here. `scripts/reconcile_file_sizes.py` owns
the batching, the inter-batch pause, the missing-object categorisation and
the report; this module calls into it. A second implementation would drift
from the first exactly where it matters least visibly — which of the three
failure categories a 404 lands in, say.

Ticks every 15 minutes and no-ops unless it is 03:45–04:00 in the admin's
own timezone (`site_settings.timezone`). See services/schedule_window.py for
why the gate lives here rather than in Celery's own timezone config.
"""

import logging

from ..database import SessionLocal
from ..models.site_settings import SiteSettings
from ..services.schedule_window import in_daily_window, local_now
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: 03:45 local. Offset from purge_expired_trash's 03:00 window deliberately:
#: both issue real volumes of S3 calls against the same AIStor endpoint, and
#: they are individually cheap only in the common case where there is
#: nothing to do.
RUN_HOUR = 3
RUN_MINUTE_FROM = 45

#: Gentler than a manual backlog run. This shares the endpoint with live
#: traffic every night, where the one-off backfill was a supervised event.
BATCH_SIZE = 100
SLEEP_BETWEEN_BATCHES = 1.0


def _configured_timezone() -> str:
    """Read fresh from the DB on every tick — that is the whole mechanism.

    Captured at import or at worker start, a timezone change would need a
    restart to take effect, which is precisely what this design avoids.
    """
    db = SessionLocal()
    try:
        row = db.query(SiteSettings).first()
        return (row.timezone if row else None) or "UTC"
    finally:
        db.close()


@celery_app.task(name="reconcile_file_sizes")
def reconcile_file_sizes():
    """Verify a night's worth of unverified file sizes against S3.

    Returns a small dict rather than nothing so a skipped tick is
    distinguishable from a tick that ran and found no work — the two look
    identical in a log otherwise, which is the shape of bug §182 exists to
    stop repeating.
    """
    tz_name = _configured_timezone()

    # 03:45–04:00 local. The task ticks every 15 minutes; all but one of
    # those ticks end here, having done one cheap SELECT.
    if not in_daily_window(tz_name, RUN_HOUR, RUN_MINUTE_FROM):
        local = local_now(tz_name)
        return {"skipped": True, "timezone": tz_name, "local_time": local.isoformat()}

    local = local_now(tz_name)
    logger.warning(
        "File-size reconciliation sweep starting (%s local in %s)",
        local.strftime("%H:%M"), tz_name,
    )

    # Imported here, not at module scope: the script imports the S3 service
    # and the models, and a scheduled task module should not widen what the
    # API process pulls in at startup just by existing.
    from ..scripts.reconcile_file_sizes import main as run_backfill

    exit_code = run_backfill([
        "--write",
        "--batch-size", str(BATCH_SIZE),
        "--sleep", str(SLEEP_BETWEEN_BATCHES),
    ])

    # Non-zero means the script found something needing a human: an object
    # missing from S3 on a version that claims to be ready, or storage that
    # would not answer. It is NOT raised — a sweep that crashes on a
    # finding stops sweeping, and the finding is already in the log with
    # the detail a person needs.
    if exit_code:
        logger.warning(
            "File-size reconciliation finished with findings (exit %s) — "
            "see the report above for missing objects or storage errors",
            exit_code,
        )
    return {"skipped": False, "timezone": tz_name, "exit_code": exit_code}
