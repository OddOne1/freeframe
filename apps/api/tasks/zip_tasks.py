"""Build and reap server-side zip downloads (CLAUDE.md §143).

Mirrors lut_tasks' lifecycle deliberately — dedicated prefix, countdown
delete, periodic sweep as the backstop for the countdown that a worker
restart drops — because that shape has already been debugged here and a
second, differently-shaped one would have to earn its differences.

One real divergence: a zip is built to a temp FILE and uploaded whole
(§143.4), not streamed to the client. Streaming would mean no cache, no
resume, no progress, and a request that dies if the connection blinks.
"""
import logging
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

from ..config import settings
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.zip_export import ZipExport, ZipExportStatus
from ..services import s3_service
from ..services.zip_export_service import ZIP_PREFIX, ZIP_TTL_SECONDS
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: Stream each member in chunks rather than reading it whole. A camera
#: original is routinely multi-GB and a worker holds one at a time.
_CHUNK = 8 * 1024 * 1024


@celery_app.task(bind=True, max_retries=1, default_retry_delay=60, name="build_zip_export")
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

        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            # ZIP_STORED, not DEFLATE, on purpose: the payload is already
            # compressed video and images, so deflate spends CPU on every
            # byte to save ~nothing. Zip64 because a folder of originals
            # passes 4GB easily.
            for entry in export.manifest or []:
                s3_key = entry.get("s3_key")
                path = entry.get("path")
                if not s3_key or not path:
                    continue
                if entry.get("needs_render"):
                    # Unreachable by construction: the batch picker only
                    # offers variants backed by a stored object (§143 scope
                    # decision), so nothing here is an ffmpeg product. Kept
                    # as a guard rather than an assert because the
                    # alternative failure is silent and worse — `s3_key` is
                    # the RENDER INPUT for such an entry, so zipping it
                    # would hand someone the original under a filename
                    # promising a proxy or a graded copy.
                    logger.error(
                        "zip %s: refusing entry that needs a render (%s)", export_id, path
                    )
                    entry["skipped"] = "this option needs rendering and is not available in a batch download"
                    done += 1
                    export.files_done = done
                    db.commit()
                    continue
                try:
                    obj = client.get_object(Bucket=settings.s3_bucket, Key=s3_key)
                    with zf.open(path, "w") as dest:
                        body = obj["Body"]
                        while True:
                            chunk = body.read(_CHUNK)
                            if not chunk:
                                break
                            dest.write(chunk)
                except Exception as exc:
                    # One unreadable member must not lose the other 19 files.
                    # It is recorded on the entry so the UI can say which.
                    logger.warning("zip %s: skipping %s (%s)", export_id, s3_key, exc)
                    entry["skipped"] = str(exc)[:200]
                done += 1
                export.files_done = done
                db.commit()

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
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=ZIP_TTL_SECONDS)
        rows = db.query(ZipExport).all()
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
