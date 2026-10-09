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
#
# §219 — that last paragraph was true only of a version a worker had
# actually started. The same status is also worn by a version merely QUEUED
# behind other work, which has no heartbeat of any kind because its task has
# not run yet. The sweep below therefore splits the two on
# `processing_started_at` rather than treating the status as one state.
STUCK_STATUSES = (ProcessingStatus.processing,)


@celery_app.task(name="sweep_stuck_processing")
def sweep_stuck_processing():
    """Fail any version that has been silently mid-processing for too long.

    TWO rules, because `processing` covers two states that look identical in
    the database and are not remotely alike (§219).

    A version is set to `processing` at DISPATCH, by whoever queues the work.
    Until a worker frees up, nothing touches that row: the progress callback
    cannot run, because the task has not started. On a busy `transcoding`
    queue (concurrency 2, prefetch 1, multi-hour ffmpeg jobs) that wait is
    legitimately hours long. Measured on the live server during a 641 GiB
    import, the single-rule version of this sweep relabelled two healthy
    95 GiB originals `failed` while they were still sitting in the queue.

    So `processing_started_at` splits them:

      * STARTED (it is set) -- staleness is measured against `updated_at`,
        as before. §113's progress callback commits this row on every new
        whole percent, and §219 added byte-driven heartbeats to the long
        silent phases that have no percent to report (the EXIF download, the
        HLS upload, and an encode whose duration ffprobe could not read), so
        a living task touches the row every minute or so regardless of what
        it is doing. Silence here really does mean nothing is working on it.

      * QUEUED (it is NULL) -- `updated_at` says only when the row was
        dispatched, so the minutes rule is meaningless against it and is
        never applied. The one failure that stays real is a task lost from
        the broker entirely, which nothing will ever pick up; that is caught
        by STUCK_QUEUED_HOURS, a week by default. Long on purpose: this is a
        backstop against a row claiming `processing` forever, not a promise
        to reap it promptly, and the cost of being wrong here is destroying
        a user's place in the queue.
    """
    db = SessionLocal()
    try:
        minutes = max(1, int(settings.stuck_processing_minutes))
        queued_hours = max(1, int(settings.stuck_queued_hours))
        now = datetime.now(timezone.utc)
        started_cutoff = now - timedelta(minutes=minutes)
        queued_cutoff = now - timedelta(hours=queued_hours)

        # Two queries rather than one with an OR over both thresholds: they
        # ask genuinely different questions, the log line has to say WHICH
        # rule fired, and the counts are reported separately.
        started_stale = (
            db.query(AssetVersion)
            .filter(
                AssetVersion.processing_status.in_(STUCK_STATUSES),
                # The whole point. Without this, every queued row in the
                # table is eligible for the 45-minute rule again.
                AssetVersion.processing_started_at.isnot(None),
                AssetVersion.updated_at < started_cutoff,
                AssetVersion.deleted_at.is_(None),
            )
            .all()
        )

        queued_stale = (
            db.query(AssetVersion)
            .filter(
                AssetVersion.processing_status.in_(STUCK_STATUSES),
                AssetVersion.processing_started_at.is_(None),
                AssetVersion.updated_at < queued_cutoff,
                AssetVersion.deleted_at.is_(None),
            )
            .all()
        )

        for version in started_stale:
            # WARNING, not INFO: every Celery service runs at
            # --loglevel=warning in production (docker-compose.prod.yml), so
            # an INFO line here would be invisible in exactly the environment
            # this exists to make debuggable.
            logger.warning(
                "Stuck processing swept: version %s (asset %s) STARTED at %s "
                "and has shown no activity since %s (> %d min); marking failed",
                version.id, version.asset_id, version.processing_started_at,
                version.updated_at, minutes,
            )
            version.processing_status = ProcessingStatus.failed

        for version in queued_stale:
            # Deliberately says "never started": this row's updated_at is
            # its dispatch time, and reading it as "no activity since" is
            # the exact misreading that failed two healthy files.
            logger.warning(
                "Stuck QUEUED swept: version %s (asset %s) was dispatched at "
                "%s and never started (> %d h); the task is presumed lost "
                "from the broker; marking failed",
                version.id, version.asset_id, version.updated_at, queued_hours,
            )
            version.processing_status = ProcessingStatus.failed

        result = {
            "swept": len(started_stale),
            "threshold_minutes": minutes,
            "swept_queued": len(queued_stale),
            "threshold_queued_hours": queued_hours,
        }

        if not started_stale and not queued_stale:
            return result

        db.commit()
        logger.warning(
            "Stuck processing sweep: %d started version(s) and %d queued "
            "version(s) marked failed",
            len(started_stale), len(queued_stale),
        )
        return result
    except Exception:
        db.rollback()
        # Logged rather than swallowed: a sweeper that fails silently is
        # indistinguishable from one that found nothing, which is the exact
        # failure mode this whole change is about.
        logger.exception("Stuck processing sweep failed")
        raise
    finally:
        db.close()
