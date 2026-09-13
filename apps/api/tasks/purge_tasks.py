"""Scheduled permanent deletion of expired Recently Deleted items.

Recently Deleted was soft-delete-only with no expiry at all: an item sat
in the trash forever, and its footage sat in S3 forever with it. This is
the job that gives that trash a floor.

The actual work lives in services/purge_service.py, shared with the
owner/admin immediate-purge endpoints — see the FK and S3 audit in that
module's docstring, which is the part of this feature that can silently go
wrong.
"""

import logging

from ..database import SessionLocal
from ..models.site_settings import SiteSettings
from ..services.purge_service import RETENTION_DAYS, purge_expired
from ..services.schedule_window import in_daily_window, local_now
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: 03:00 local. Out of working hours wherever the admin actually is — which
#: is what the old `crontab(hour=3)` claimed and, running under Celery's
#: fixed UTC, only accidentally meant (§182).
RUN_HOUR = 3


def _configured_timezone() -> str:
    """Read fresh on every tick — that is the whole mechanism (§182).

    Captured at import or at worker start, a timezone change would need a
    restart to take effect, which is exactly what this design avoids.
    """
    db = SessionLocal()
    try:
        row = db.query(SiteSettings).first()
        return (row.timezone if row else None) or "UTC"
    finally:
        db.close()


@celery_app.task(name="purge_expired_trash")
def purge_expired_trash():
    """Permanently delete everything soft-deleted more than 30 days ago.

    Assets and folders are queried independently by their own `deleted_at`.
    That is sufficient rather than lazy: `delete_folder` cascade-stamps the
    same timestamp onto every descendant folder and asset in one
    transaction (folders.py:319-329), so a folder's contents are already
    due at the same moment the folder is, with no tree to walk.

    Individual failures are contained per item inside purge_expired: one
    asset that can't be deleted must not prevent the other 200 from being.

    §182 — ticks every 15 minutes and returns immediately unless it is
    03:00–03:15 in `site_settings.timezone`. Retention is measured in days
    and the cutoff is absolute, so which minute of the night this runs
    changes nothing about WHAT is deleted; the window exists only to keep
    a lot of S3 deletes out of working hours, wherever those are.
    """
    tz_name = _configured_timezone()
    local = local_now(tz_name)
    if not in_daily_window(tz_name, RUN_HOUR):
        return {"skipped": True, "timezone": tz_name, "local_time": local.isoformat()}

    logger.warning(
        "Trash purge starting (%s local in %s)", local.strftime("%H:%M"), tz_name,
    )

    db = SessionLocal()
    try:
        result = purge_expired(db)
        if result["assets"] or result["folders"] or result["failed"]:
            logger.info(
                "Trash purge (>%d days): %d asset(s), %d folder(s), %d S3 object(s), %d failure(s)",
                RETENTION_DAYS, result["assets"], result["folders"],
                result["objects"], result["failed"],
            )
        result["skipped"] = False
        result["timezone"] = tz_name
        return result
    finally:
        db.close()
