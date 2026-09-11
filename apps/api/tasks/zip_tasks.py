"""Build and reap server-side zip downloads (CLAUDE.md §143).

Mirrors lut_tasks' lifecycle deliberately — dedicated prefix, countdown
delete, periodic sweep as the backstop for the countdown that a worker
restart drops — because that shape has already been debugged here and a
second, differently-shaped one would have to earn its differences.

§146 note, recorded because it is a gap rather than a decision: this is the
ONLY Celery task in this codebase carrying a time limit. Nothing else —
including burn_lut_export, the transcode tasks, or the transcription
worker — has `soft_time_limit`/`time_limit` set, so any of them can wedge a
worker indefinitely. Scoped here on purpose; a sweep across every task is
its own pass with its own per-task ceilings to choose.

One real divergence: a zip is built to a temp FILE and uploaded whole
(§143.4), not streamed to the client. Streaming would mean no cache, no
resume, no progress, and a request that dies if the connection blinks.
"""
import logging
import os
import queue
import shutil
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

from celery.exceptions import SoftTimeLimitExceeded

from ..config import settings
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.zip_export import ZipExport, ZipExportStatus
from ..services import s3_service
from ..services import zip_export_service
from ..services.zip_export_service import ZIP_PREFIX, ZIP_TTL_SECONDS
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: Stream each member in chunks rather than reading it whole. A camera
#: original is routinely multi-GB and a worker holds one at a time.
_CHUNK = 8 * 1024 * 1024

#: How many objects are pulled from storage at once (§146).
#:
#: The bug this fixes: fetching 103 files strictly one at a time, each a
#: full S3 round trip, ran past the client's 30-minute deadline on a real
#: 13.25GB batch with nothing actually stuck — the task was simply serial.
#: Mirrors upload-store.ts's CONCURRENT_PARTS worker pool: N workers pull
#: from a shared counter until the work runs out.
#:
#: Six, not more: the bottleneck is one worker's network link to AIStor, and
#: past roughly this point the connections compete for the same pipe while
#: each one's memory buffer and open socket still costs. It is also a
#: deliberate ceiling on how hard one zip can hammer storage that every
#: upload and transcode shares.
_CONCURRENT_FETCHES = 6

#: zipfile.ZipFile is NOT thread-safe, so the concurrency is in the FETCH
#: only: workers download to temp files, and a single consumer writes them
#: into the archive. The queue is bounded to the worker count so at most a
#: handful of members sit on disk at once — unbounded, a 13GB batch would
#: try to stage all 103 originals before writing any of them.
_FETCH_QUEUE_DEPTH = _CONCURRENT_FETCHES

#: Ceilings for one build (§146). Ordering is deliberate and load-bearing:
#: soft (20m) < hard (21m) < the status endpoint's staleness threshold <
#: the browser's own 30-minute deadline. The server therefore resolves a
#: doomed build into a real `failed` BEFORE the client gives up, so someone
#: sees an error they can act on instead of "taking longer than expected".
#: 13.25GB over a LAN is a couple of minutes of pure transfer, so 20 minutes
#: is generous for the concurrent version rather than tight.
ZIP_SOFT_TIME_LIMIT = 20 * 60
ZIP_HARD_TIME_LIMIT = 21 * 60


@celery_app.task(
    bind=True,
    max_retries=1,
    default_retry_delay=60,
    name="build_zip_export",
    # §146 — the first time limits anywhere in this codebase. Scoped to this
    # task deliberately; see the module docstring note about the wider gap.
    soft_time_limit=ZIP_SOFT_TIME_LIMIT,
    time_limit=ZIP_HARD_TIME_LIMIT,
)
def build_zip_export(self, export_id: str):
    """Assemble one archive from an already-resolved manifest.

    The manifest is written by the endpoint, not recomputed here: it
    encodes permission decisions (which variant each asset was allowed to
    produce), and re-deriving those in a worker would be a second copy of a
    permission rule.
    """
    db = SessionLocal()
    work_dir = None
    try:
        export = db.query(ZipExport).filter(ZipExport.id == uuid.UUID(export_id)).first()
        if not export:
            logger.warning("zip export %s vanished before the build started", export_id)
            return
        if export.status == ZipExportStatus.ready:
            return  # another worker already finished it

        export.status = ZipExportStatus.building
        db.commit()

        work_dir = tempfile.mkdtemp(prefix=f"zipexport_{export_id}_")
        zip_path = os.path.join(work_dir, "bundle.zip")
        client = s3_service.get_s3_client()
        done = 0

        entries = [
            e for e in (export.manifest or [])
            if e.get("s3_key") and e.get("path")
        ]

        # Entries that must never be fetched are settled up front, so the
        # worker pool below deals only with real downloads.
        for entry in entries:
            if entry.get("needs_render"):
                # Unreachable by construction: the batch picker only offers
                # variants backed by a stored object (§143 scope decision).
                # Kept as a guard because the alternative failure is silent
                # and worse — `s3_key` is the RENDER INPUT for such an
                # entry, so zipping it would hand someone the original under
                # a filename promising a proxy or a graded copy.
                logger.error(
                    "zip %s: refusing entry that needs a render (%s)",
                    export_id, entry.get("path"),
                )
                entry["skipped"] = (
                    "this option needs rendering and is not available in a batch download"
                )

        fetchable = [e for e in entries if not e.get("needs_render")]

        # ── Fetch concurrently, write serially ───────────────────────────
        # The split is forced by zipfile not being thread-safe, and it is
        # also the right shape: the slow part is the network round trip, and
        # writing an already-downloaded file into a ZIP_STORED archive is
        # local disk I/O.
        staging = os.path.join(work_dir, "staging")
        os.makedirs(staging, exist_ok=True)
        ready: "queue.Queue" = queue.Queue(maxsize=_FETCH_QUEUE_DEPTH)
        next_index = [0]
        index_lock = threading.Lock()
        stop = threading.Event()
        # A timeout that lands in a worker must NOT be treated as "this one
        # file was unreadable". Celery raises SoftTimeLimitExceeded in the
        # main thread, but a worker blocked in read() can surface it too —
        # and the broad `except Exception` below would then mark every
        # remaining file skipped and upload a "ready" archive containing
        # nothing, which is worse than failing. Captured here and re-raised
        # by the consumer so it takes the timeout path.
        fatal: list = []

        def claim_next():
            with index_lock:
                i = next_index[0]
                if i >= len(fetchable):
                    return None
                next_index[0] = i + 1
                return i

        def fetch_worker():
            while not stop.is_set():
                i = claim_next()
                if i is None:
                    return
                entry = fetchable[i]
                local = os.path.join(staging, f"{i}.part")
                try:
                    obj = client.get_object(
                        Bucket=settings.s3_bucket, Key=entry["s3_key"]
                    )
                    body = obj["Body"]
                    with open(local, "wb") as fh:
                        while True:
                            if stop.is_set():
                                return
                            chunk = body.read(_CHUNK)
                            if not chunk:
                                break
                            fh.write(chunk)
                    ready.put((entry, local, None))
                except SoftTimeLimitExceeded as exc:
                    fatal.append(exc)
                    stop.set()
                    ready.put((entry, None, "timed out"))
                    return
                except Exception as exc:
                    # One unreadable member must not lose the other 102.
                    logger.warning(
                        "zip %s: skipping %s (%s)", export_id, entry["s3_key"], exc
                    )
                    ready.put((entry, None, str(exc)[:200]))

        workers = [
            threading.Thread(target=fetch_worker, daemon=True)
            for _ in range(min(_CONCURRENT_FETCHES, max(1, len(fetchable))))
        ]
        for w in workers:
            w.start()

        try:
            with zipfile.ZipFile(
                zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True
            ) as zf:
                # ZIP_STORED, not DEFLATE, on purpose: the payload is already
                # compressed video and images, so deflate spends CPU on every
                # byte to save ~nothing. Zip64 because a folder of originals
                # passes 4GB easily.
                for _ in range(len(fetchable)):
                    if fatal:
                        raise fatal[0]
                    entry, local, err = ready.get()
                    if err is not None:
                        entry["skipped"] = err
                    else:
                        try:
                            with open(local, "rb") as src, zf.open(entry["path"], "w") as dest:
                                shutil.copyfileobj(src, dest, _CHUNK)
                        except Exception as exc:
                            logger.warning(
                                "zip %s: could not add %s (%s)",
                                export_id, entry["path"], exc,
                            )
                            entry["skipped"] = str(exc)[:200]
                        finally:
                            # Deleted as soon as it is in the archive, so the
                            # staging area never holds more than the queue.
                            try:
                                os.remove(local)
                            except OSError:
                                pass
                    done += 1
                    export.files_done = done
                    export.progress_at = datetime.now(timezone.utc)
                    db.commit()
                # Entries refused above still count as handled.
                done += len(entries) - len(fetchable)
                export.files_done = done
                export.progress_at = datetime.now(timezone.utc)
                db.commit()
        finally:
            stop.set()
            for w in workers:
                w.join(timeout=5)
        if fatal:
            raise fatal[0]

        size = os.path.getsize(zip_path)
        with open(zip_path, "rb") as fh:
            client.put_object(
                Bucket=settings.s3_bucket,
                Key=export.s3_key,
                Body=fh,
                ContentType="application/zip",
            )

        export.status = ZipExportStatus.ready
        export.total_bytes = size
        export.files_done = done
        export.expires_at = datetime.now(timezone.utc) + timedelta(seconds=ZIP_TTL_SECONDS)
        # Reassign so SQLAlchemy sees the in-place `skipped` edits above.
        export.manifest = list(export.manifest or [])
        db.commit()

        delete_zip_export.apply_async(
            args=[export.s3_key, str(export.id)], countdown=ZIP_TTL_SECONDS
        )
        logger.info("zip export %s ready: %s files, %s bytes", export_id, done, size)

    except SoftTimeLimitExceeded:
        # §146 — the backstop. Deliberately NOT retried: the build already
        # had its full budget, and a retry would occupy a worker for another
        # 20 minutes to reach the same wall. Marking the row failed is what
        # lets the polling client stop and say something true, instead of
        # sitting on a row wedged at "building" forever.
        logger.error("zip export %s exceeded its time limit", export_id)
        try:
            export = db.query(ZipExport).filter(ZipExport.id == uuid.UUID(export_id)).first()
            if export:
                export.status = ZipExportStatus.failed
                export.error = (
                    "Preparing this download took too long. Try selecting fewer files."
                )
                db.commit()
        except Exception:
            logger.exception("could not mark zip export %s failed after timeout", export_id)
        return
    except Exception as exc:
        logger.exception("zip export %s failed", export_id)
        try:
            export = db.query(ZipExport).filter(ZipExport.id == uuid.UUID(export_id)).first()
            if export:
                export.status = ZipExportStatus.failed
                export.error = str(exc)[:500]
                db.commit()
        except Exception:
            pass
        raise self.retry(exc=exc)
    finally:
        db.close()
        if work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=300, name="delete_zip_export")
def delete_zip_export(self, s3_key: str, export_id: str = ""):
    """Delete one archive from storage.

    Prefix-guarded exactly like delete_lut_export, and for the same reason:
    this takes a raw key off the broker, and a bug or a malformed retry must
    not be able to point it at `raw/` or `processed/`.
    """
    if not s3_key.startswith(ZIP_PREFIX):
        logger.error("Refusing to delete non-zip-export key: %s", s3_key)
        return
    try:
        s3_service.delete_object(s3_key)
        logger.info("Deleted zip export %s", s3_key)
    except Exception as exc:
        logger.warning("Could not delete zip export %s: %s", s3_key, exc)
        raise self.retry(exc=exc)

    if export_id:
        db = SessionLocal()
        try:
            db.query(ZipExport).filter(ZipExport.id == uuid.UUID(export_id)).delete()
            db.commit()
        except Exception:
            db.rollback()
        finally:
            db.close()


@celery_app.task(name="purge_share_link_zips")
def purge_share_link_zips(share_link_id: str):
    """Destroy every archive belonging to one share link (§143.5).

    The half with no precedent in this codebase: the LUT export TTL is
    purely time-based, so "deleted when the link is deactivated" is new
    wiring. Called from the PATCH handler when `is_enabled` goes false and
    from the revoke endpoint.

    Deliberately driven from the DATABASE rows rather than an S3 prefix
    listing, so it deletes only keys this app recorded writing — the same
    instinct as the prefix guard, one level up.
    """
    db = SessionLocal()
    try:
        rows = db.query(ZipExport).filter(
            ZipExport.share_link_id == uuid.UUID(share_link_id)
        ).all()
        for row in rows:
            if not row.s3_key.startswith(ZIP_PREFIX):
                logger.error("Refusing to delete non-zip-export key: %s", row.s3_key)
                continue
            try:
                s3_service.delete_object(row.s3_key)
            except Exception as exc:
                logger.warning("purge: could not delete %s: %s", row.s3_key, exc)
            db.delete(row)
        db.commit()
        logger.info("Purged %s zip export(s) for share link %s", len(rows), share_link_id)
    except Exception:
        db.rollback()
        logger.exception("Failed purging zip exports for share link %s", share_link_id)
    finally:
        db.close()


@celery_app.task(name="sweep_zip_exports")
def sweep_zip_exports():
    """Backstop for the countdown-scheduled deletes above.

    Same reasoning as sweep_lut_exports: a countdown task lives in the
    worker's memory once prefetched, and this project restarts every worker
    on every deploy, so any delete scheduled shortly before a release is
    simply lost. Without this, an archive would outlive the three days it
    promises.
    """
    db = SessionLocal()
    deleted = 0
    stuck = 0
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=ZIP_TTL_SECONDS)
        rows = db.query(ZipExport).all()

        # §146 — resolve wedged builds for anyone NOT polling. The status
        # route does this on read for an active viewer; a build abandoned
        # when its tab closed has nobody to trigger that, and would sit at
        # "building" until its TTL.
        for row in rows:
            if zip_export_service.is_stale(row, now=now):
                row.status = ZipExportStatus.failed
                row.error = "Preparing this download stopped unexpectedly."
                stuck += 1
        if stuck:
            db.commit()
            logger.warning("Marked %s wedged zip export(s) failed", stuck)

        for row in rows:
            expired = (row.expires_at and row.expires_at <= now) or (
                row.expires_at is None and row.created_at and row.created_at <= cutoff
            )
            if not expired:
                continue
            if not row.s3_key.startswith(ZIP_PREFIX):
                logger.error("Refusing to delete non-zip-export key: %s", row.s3_key)
                continue
            try:
                s3_service.delete_object(row.s3_key)
            except Exception as exc:
                logger.warning("sweep: could not delete %s: %s", row.s3_key, exc)
            db.delete(row)
            deleted += 1
        db.commit()
        if deleted:
            logger.info("Swept %s expired zip export(s)", deleted)
    except Exception:
        db.rollback()
        logger.exception("sweep_zip_exports failed")
    finally:
        db.close()
    return deleted
