"""Scheduled recovery of versions left stranded mid-processing (§114).

The primary fix for lost transcodes is `task_acks_late` in celery_app.py: a
task is now acked when it finishes rather than when it is picked up, so a
worker killed by a deploy has its work redelivered instead of silently
dropped. This is the backstop for what that still cannot save --

  * a worker lost inside the ack window itself,
  * a task that hangs rather than dies (a wedged ffmpeg, a stalled S3 read),
    which is never redelivered because from the broker's point of view it is
    still running,
  * anything already stranded before that config change ever shipped.

In all three the symptom is identical and, until now, permanent: an
AssetVersion sitting at `processing` with nothing anywhere working on it, no
error, and a UI spinner that never stops. This job gives that state a floor.

It marks stale rows `failed`, deliberately, rather than re-dispatching them.
Failure is a state the app already knows how to show and the user can act on
by re-uploading; automatic re-dispatch would risk a loop where whatever
wedged the first attempt wedges every retry, at real CPU cost, invisibly.
"""

import logging
from datetime import datetime, timedelta, timezone

from ..config import settings
from ..database import SessionLocal
from ..models.asset import AssetVersion, ProcessingStatus
from .celery_app import celery_app

logger = logging.getLogger(__name__)

# `processing` ONLY, and `uploading` is excluded deliberately.
#
# An abandoned upload leaves a version stranded at `uploading` just as
# permanently, so sweeping it looks like the obvious completion of this job.
# It is not: nothing touches the version row between /upload/initiate and
# /upload/complete -- the parts go straight from the browser to S3 -- so
# updated_at does not move for the entire duration of an upload. A large
# source on a slow connection legitimately takes longer than any threshold
# short enough to be useful here, and would be marked failed while it was
# still uploading perfectly well.
#
# `processing` is safe from that precisely because §113's progress callback
# commits this row on every new whole percent, so the heartbeat exists for
# the one state being swept. Reaping abandoned uploads needs a different
# signal (S3 multipart age, or a client heartbeat) and is out of scope.
STUCK_STATUSES = (ProcessingStatus.processing,)


@celery_app.task(name="sweep_stuck_processing")
def sweep_stuck_processing():
    """Fail any version that has been silently mid-processing for too long.

    Staleness is measured against `updated_at`, not `created_at`. A large
    transcode legitimately runs for an hour or more, so an age-based cutoff
    would have to be either long enough to be useless or short enough to kill
    live work. `updated_at` moves on every progress commit (§113), so the
    question this asks is "has anything happened to this row recently", which
    is the one that actually distinguishes a running job from a dead one.
    """
    db = SessionLocal()
    try:
        minutes = max(1, int(settings.stuck_processing_minutes))
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)

        stale = (
            db.query(AssetVersion)
            .filter(
                AssetVersion.processing_status.in_(STUCK_STATUSES),
                AssetVersion.updated_at < cutoff,
                AssetVersion.deleted_at.is_(None),
            )
            .all()
        )

        if not stale:
            return {"swept": 0, "threshold_minutes": minutes}

        for version in stale:
            # WARNING, not INFO: every Celery service runs at
            # --loglevel=warning in production (docker-compose.prod.yml), so
            # an INFO line here would be invisible in exactly the environment
            # this exists to make debuggable.
            logger.warning(
                "Stuck processing swept: version %s (asset %s) sat at %s "
                "with no activity since %s (> %d min); marking failed",
                version.id, version.asset_id, version.processing_status.value,
                version.updated_at, minutes,
            )
            version.processing_status = ProcessingStatus.failed

        db.commit()
        logger.warning("Stuck processing sweep: %d version(s) marked failed", len(stale))
        return {"swept": len(stale), "threshold_minutes": minutes}
    except Exception:
        db.rollback()
        # Logged rather than swallowed: a sweeper that fails silently is
        # indistinguishable from one that found nothing, which is the exact
        # failure mode this whole change is about.
        logger.exception("Stuck processing sweep failed")
        raise
    finally:
        db.close()
