"""Reap abandoned uploads — the part §213 deliberately left for later (§215).

§213's contract is that a failed upload KEEPS its S3 multipart session so
it can be resumed. That is the whole point of it, and it has a cost this
module exists to pay: an upload nobody ever comes back to accumulates
forever. Its parts sit in the bucket, counted as storage and invisible
from inside the app, and its `AssetVersion` sits at `uploading` with no
error and no end. An earlier incident left **92.3 GiB** of orphaned parts
and five ghost rows, cleaned up by hand.

`cleanup_tasks.py` already explains, above `STUCK_STATUSES`, why
`sweep_stuck_processing` cannot do this job: nothing touches the version
row between `/upload/initiate` and `/upload/complete`, so `updated_at`
never moves during an upload, and any age cutoff short enough to be
useful would kill a large upload that is still running perfectly well. It
ends by naming what would be needed — "S3 multipart age, or a client
heartbeat". This is the first of those.

── The signal ────────────────────────────────────────────────────────────
`last_activity = max(Initiated, newest part's LastModified)`, and an
upload is abandoned only when NOTHING has happened for the whole TTL.

That distinction is the entire safety of this sweep. Judging by
`Initiated` alone would kill a 100 GB offload that began three weeks ago
and sent a part two minutes ago — a live upload, destroyed, with every
transferred byte lost. The part timestamp is what moves while an upload
is alive, so it is what gets asked.

And when it is not answered, nothing is judged. An upload that HAS parts
but whose parts carry no `LastModified` is skipped, loudly, rather than
falling back to `Initiated` — because that fallback is the dangerous
reading above, reached by a different route. Whether AIStor populates
`LastModified` on ListParts at all is not proven anywhere but against a
fake; if it does not, this is what makes the sweep a loud no-op instead
of a silent reaping of every large upload in the bucket. An upload with
ZERO parts is a separate case and still judged by `Initiated`: nothing
was ever sent, so that is the only event there has ever been.

── Two passes, because there are two kinds of leftover ───────────────────
Pass 1  an open multipart upload at the store with no recent activity:
        abort it, and fail its version if that row is still `uploading`.
Pass 2  a row claiming `uploading` with NO open upload at the store: the
        shape the incident's five hand-cleaned uploads left behind. Fail
        the row — unless the object actually exists, which means the
        bytes landed and only the commit was lost, and a person may still
        want it.
"""

import logging
from datetime import datetime, timedelta, timezone

from ..config import settings
from ..database import SessionLocal
from ..models.asset import AssetVersion, MediaFile, ProcessingStatus
from ..services.s3_service import (
    NoSuchUploadError,
    abort_multipart_upload,
    list_multipart_parts,
    list_multipart_uploads_all,
    object_exists,
)
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: Only ever this prefix. Originals live under `raw/`; renditions, posters,
#: LUT exports, zips and brand images do not, and none of them is an upload
#: session. Passed explicitly rather than relied on as a default.
RAW_PREFIX = "raw/"

GIB = 1024 ** 3


def _aware(value):
    """A timezone-aware datetime, or None.

    boto3 returns aware datetimes; a fake, a fixture or a stub may not, and
    comparing naive to aware raises TypeError — inside a per-upload try that
    would silently turn into "skipped, could not judge" for every upload at
    once.
    """
    if value is None:
        return None
    if getattr(value, "tzinfo", None) is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _last_activity(key: str, upload_id: str, initiated, counters: dict):
    """When something last happened to this upload, and its size so far.

    Returns `(last_activity, bytes_so_far, parts, timestamped_parts)`.
    `list_multipart_parts` is §213's paginator, reused rather than
    reimplemented — it already walks every page, which matters here because
    a 100 GB upload is ~6,000 parts over six pages.

    `timestamped_parts` is counted separately and is NOT a statistic. It is
    how the caller can tell "every part is older than the TTL" apart from
    "no part carried a timestamp at all", which otherwise look identical:
    both leave `newest` sitting at `initiated`. The second case is the one
    where judging by `Initiated` would destroy a live upload, so the caller
    has to be able to see it.
    """
    counters["list_parts_calls"] += 1
    parts = list_multipart_parts(key, upload_id)
    newest = initiated
    total = 0
    timestamped = 0
    for part in parts:
        total += int(part.get("Size") or 0)
        when = _aware(part.get("LastModified"))
        if when is None:
            continue
        timestamped += 1
        if newest is None or when > newest:
            newest = when
    return newest, total, len(parts), timestamped


def _version_for_key(db, key: str):
    """The AssetVersion behind an s3 key, via its MediaFile. None if unowned.

    An upload with no row is a real case — /upload/initiate creates the
    multipart upload before it commits, so a request that died in between
    leaves parts nobody owns — and those are exactly the ones nothing else
    will ever clean up.
    """
    media_file = db.query(MediaFile).filter(MediaFile.s3_key_raw == key).first()
    if not media_file:
        return None
    return (
        db.query(AssetVersion)
        .filter(AssetVersion.id == media_file.version_id)
        .first()
    )


@celery_app.task(name="sweep_abandoned_uploads")
def sweep_abandoned_uploads():
    """Abort multipart uploads nobody is going to finish, and clear ghosts.

    Every action is logged at WARNING: every Celery service in
    docker-compose.prod.yml runs at `--loglevel=warning`, so an INFO line
    here would be invisible in exactly the environment this exists to make
    debuggable.
    """
    if not settings.upload_sweep_enabled:
        logger.warning("Abandoned-upload sweep is disabled (UPLOAD_SWEEP_ENABLED=false)")
        return {"enabled": False}

    dry_run = bool(settings.upload_sweep_dry_run)
    ttl_days = max(1, int(settings.upload_abandon_days))
    grace_hours = max(1, int(settings.upload_ghost_grace_hours))
    cap = max(1, int(settings.upload_sweep_max_aborts))

    now = datetime.now(timezone.utc)
    abandon_cutoff = now - timedelta(days=ttl_days)
    ghost_cutoff = now - timedelta(hours=grace_hours)

    counters = {
        "open_uploads": 0,
        "skipped_recent": 0,
        "alive": 0,
        "no_part_timestamps": 0,
        "aborted": 0,
        "unmatched": 0,
        "versions_failed": 0,
        "ghosts_failed": 0,
        "ghosts_kept_object_exists": 0,
        "errors": 0,
        "capped": False,
        "list_parts_calls": 0,
        "bytes_freed": 0,
    }

    db = SessionLocal()
    try:
        # ── Pass 1 — stale multipart uploads at the store ───────────────
        #
        # This listing has to be COMPLETE, not merely best-effort, and the
        # dependency is pass 2's: it reads "absent from this listing" as
        # "no open upload exists" and marks the matching row `failed`. A
        # listing cut short by broken paging would hand it a live upload
        # dressed as a ghost. `list_multipart_uploads_all` raises rather
        # than returning a short list for exactly that reason (§215a), and
        # the raise is let through: the whole run is given up, before
        # anything is aborted and before any status is written, and the
        # next hourly tick tries again.
        try:
            uploads = list_multipart_uploads_all(RAW_PREFIX)
        except Exception:
            logger.exception("Abandoned-upload sweep: could not list multipart uploads")
            raise

        counters["open_uploads"] = len(uploads)
        # Oldest first, so a capped run makes progress on the worst
        # offenders rather than on whatever the store happened to list.
        uploads.sort(key=lambda u: (_aware(u.get("Initiated")) or now))

        # Keys pass 1 already adjudicated, so pass 2 does not look at them
        # again. In a live run the status write plus the commit below would
        # hide them anyway (pass 2 only selects rows still `uploading`), but
        # DRY RUN writes nothing — so without this the same row is reported
        # once as a failed version and again as a failed ghost, in exactly
        # the mode that exists to be read before trusting this task.
        handled_keys = set()

        for upload in uploads:
            key = upload["Key"]
            upload_id = upload["UploadId"]
            initiated = _aware(upload.get("Initiated"))

            # THE CHEAP FILTER, and it is first on purpose. An upload that
            # started inside the TTL cannot be abandoned however its parts
            # look, so it never pays for ListParts — which for a 100 GB
            # upload is six round trips.
            if initiated is not None and initiated > abandon_cutoff:
                counters["skipped_recent"] += 1
                continue

            try:
                last_activity, size, part_count, timestamped = _last_activity(
                    key, upload_id, initiated, counters)
            except NoSuchUploadError:
                # It went away between the listing and now — somebody
                # completed or aborted it. Nothing to do and not an error.
                counters["skipped_recent"] += 1
                continue
            except Exception:
                counters["errors"] += 1
                logger.warning(
                    "Abandoned-upload sweep: could not read parts of %s (upload %s); "
                    "leaving it alone", key, upload_id, exc_info=True,
                )
                continue

            if part_count > 0 and timestamped == 0:
                # NOT JUDGED. Parts exist, so bytes were sent after
                # `Initiated` — but not one of them carried a
                # `LastModified`, so there is no way to know WHEN. Falling
                # back to `Initiated` here would be the exact failure the
                # whole signal exists to prevent: a 100 GB offload that
                # started three weeks ago and sent a part two minutes ago
                # looks, by `Initiated` alone, precisely like an abandoned
                # one, and aborting it destroys every transferred byte.
                #
                # Whether AIStor populates LastModified on ListParts at all
                # is asserted nowhere but against a fake (§215's own
                # report says so). If it does not, this branch is what
                # turns that into a loud no-op instead of a silent reaping
                # of every large upload in the bucket.
                #
                # An upload with ZERO parts is a different case and is NOT
                # caught here: nothing was ever sent, so `Initiated` is the
                # only event that ever happened to it and judging by it is
                # correct.
                counters["no_part_timestamps"] += 1
                logger.warning(
                    "Abandoned-upload sweep: %s (upload %s) has %d part(s) but NONE "
                    "carries a LastModified timestamp — refusing to judge it by "
                    "Initiated (%s) alone; left alone. If every upload reports this, "
                    "the store does not return LastModified on ListParts and this "
                    "sweep cannot tell a live upload from an abandoned one.",
                    key, upload_id, part_count, initiated,
                )
                continue

            if last_activity is not None and last_activity > abandon_cutoff:
                # ALIVE. An upload whose start date is old but whose parts
                # are recent is the failure mode that would make this sweep
                # dangerous, and this is the branch that prevents it.
                counters["alive"] += 1
                logger.warning(
                    "Abandoned-upload sweep: %s is still ALIVE (started %s, "
                    "last part %s, %d parts, %.2f GiB) — left alone",
                    key, initiated, last_activity, part_count, size / GIB,
                )
                continue

            if counters["aborted"] >= cap:
                counters["capped"] = True
                continue

            version = _version_for_key(db, key)
            if version is None:
                counters["unmatched"] += 1

            logger.warning(
                "Abandoned-upload sweep: %s%s (upload %s) — %d part(s), %.2f GiB, "
                "no activity since %s (> %d days)%s",
                "WOULD abort " if dry_run else "aborting ",
                key, upload_id, part_count, size / GIB, last_activity, ttl_days,
                "" if version is not None else " [no database row — unmatched parts]",
            )

            if not dry_run:
                try:
                    abort_multipart_upload(key, upload_id)
                except Exception:
                    # One failure must not stop the others: contain, count,
                    # carry on. A 500 from the store on one key says nothing
                    # about the next.
                    counters["errors"] += 1
                    logger.warning(
                        "Abandoned-upload sweep: abort FAILED for %s (upload %s)",
                        key, upload_id, exc_info=True,
                    )
                    continue

            counters["aborted"] += 1
            counters["bytes_freed"] += size
            handled_keys.add(key)

            # Only a row still claiming `uploading` is touched. A
            # `processing` or `ready` version describes a finished upload
            # whose leftover session is just litter — failing it would
            # break a working asset.
            if version is not None and version.processing_status == ProcessingStatus.uploading:
                logger.warning(
                    "Abandoned-upload sweep: %sversion %s (asset %s) as failed",
                    "WOULD mark " if dry_run else "marking ",
                    version.id, version.asset_id,
                )
                if not dry_run:
                    version.processing_status = ProcessingStatus.failed
                counters["versions_failed"] += 1
            elif version is not None:
                logger.warning(
                    "Abandoned-upload sweep: version %s is %s, not uploading — "
                    "status left untouched (only its leftover session was aborted)",
                    version.id, version.processing_status.value,
                )

        if not dry_run:
            db.commit()

        # ── Pass 2 — ghost rows: `uploading` here, nothing at the store ──
        #
        # The shape the incident left: parts aborted by hand, rows never
        # updated. Nothing else in the codebase clears these — §114's
        # sweeper excludes `uploading` by design.
        # Everything pass 1 saw: still-open uploads (recent, alive, or an
        # abort that failed) AND the ones it just aborted. A key in either
        # set has already been judged, and must not be judged again.
        skip_keys = {u["Key"] for u in uploads} | handled_keys

        ghosts = (
            db.query(AssetVersion, MediaFile)
            .join(MediaFile, MediaFile.version_id == AssetVersion.id)
            .filter(
                AssetVersion.processing_status == ProcessingStatus.uploading,
                AssetVersion.deleted_at.is_(None),
                AssetVersion.created_at < ghost_cutoff,
            )
            .all()
        )

        for version, media_file in ghosts:
            key = media_file.s3_key_raw
            if key in skip_keys:
                # Still being uploaded (or still resumable), or already
                # dealt with by pass 1.
                continue

            # §215 — THE GUARD. An object at this key means /upload/complete
            # reached S3 and the database commit did not: the bytes are
            # there and a human may want to finish it. Failing the row would
            # hide a recoverable asset behind a terminal status.
            try:
                if object_exists(key):
                    counters["ghosts_kept_object_exists"] += 1
                    logger.warning(
                        "Abandoned-upload sweep: version %s (asset %s) says uploading and "
                        "has no open upload, BUT the object exists at %s — the upload "
                        "completed at the store and the commit was lost. Left alone; "
                        "this one needs a person.",
                        version.id, version.asset_id, key,
                    )
                    continue
            except Exception:
                # "The store did not answer" is not "the object is gone".
                counters["errors"] += 1
                logger.warning(
                    "Abandoned-upload sweep: could not check whether %s exists; "
                    "leaving version %s alone", key, version.id, exc_info=True,
                )
                continue

            logger.warning(
                "Abandoned-upload sweep: %sghost version %s (asset %s) failed — "
                "uploading since %s (> %d h), no multipart upload and no object at %s",
                "WOULD mark " if dry_run else "marking ",
                version.id, version.asset_id, version.created_at, grace_hours, key,
            )
            if not dry_run:
                version.processing_status = ProcessingStatus.failed
            counters["ghosts_failed"] += 1

        if not dry_run:
            db.commit()

        if counters["capped"]:
            logger.warning(
                "Abandoned-upload sweep: hit the per-run cap of %d aborts; "
                "the rest waits for the next run", cap,
            )

        # One summary line, last, so a tick that did nothing is still
        # distinguishable from a tick that did not run.
        logger.warning(
            "Abandoned-upload sweep%s: %d open upload(s) under %s — %d recent, %d alive, "
            "%d with no part timestamps, %d aborted (%.2f GiB, %d unmatched), "
            "%d version(s) failed, %d ghost row(s) failed, "
            "%d kept because the object exists, %d error(s)%s",
            " [DRY RUN]" if dry_run else "",
            counters["open_uploads"], RAW_PREFIX, counters["skipped_recent"],
            counters["alive"], counters["no_part_timestamps"],
            counters["aborted"], counters["bytes_freed"] / GIB,
            counters["unmatched"], counters["versions_failed"],
            counters["ghosts_failed"], counters["ghosts_kept_object_exists"],
            counters["errors"], " [CAPPED]" if counters["capped"] else "",
        )

        return {
            "dry_run": dry_run,
            "ttl_days": ttl_days,
            "grace_hours": grace_hours,
            **counters,
        }
    except Exception:
        db.rollback()
        # Logged rather than swallowed: a sweeper that fails silently is
        # indistinguishable from one that found nothing, which is the exact
        # failure mode this whole class of task is about.
        logger.exception("Abandoned-upload sweep failed")
        raise
    finally:
        db.close()
