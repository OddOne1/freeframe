"""SocialSnippet clip exports: render one clip, and sweep expired ones.

Both run on the existing `transcoding` queue, the one whose worker already
has ffmpeg and its two slots: no new container, no docker-compose change.
Routed in celery_app.py in BOTH forms (module glob and bare name), because
each task here declares an explicit `name=` and a glob alone cannot match
that — the trap that silently stranded apply_watermark, the zip tasks and
purge_expired_trash (§126, §143, §182).

The rules (validation, input choice, argv, names) live in
services/snippet_export.py; this module is the plumbing around them.
"""

import logging
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

from .celery_app import celery_app
from .lut_tasks import _presigned_input_url
from ..config import settings
from ..database import SessionLocal
from ..models.asset import MediaFile
from ..models.snippet_export import EXPORT_PREFIX, SnippetExport
from ..services import s3_service, snippet_admin
from ..services import snippet_export as rules

logger = logging.getLogger(__name__)

#: How often a running render writes its progress to the row.
PROGRESS_WRITE_SECONDS = 1.0


def _set(db, export_id, **values):
    """Write fields on the row and commit, touching updated_at."""
    values["updated_at"] = datetime.now(timezone.utc)
    db.query(SnippetExport).filter(SnippetExport.id == export_id).update(
        values, synchronize_session=False
    )
    db.commit()


def _run_ffmpeg(cmd, clip_ms, on_progress, timeout_s):
    """Run ffmpeg, feeding `-progress` lines to on_progress(fraction).

    stderr goes to a temp file rather than a pipe, so a chatty failure can
    never fill a pipe buffer and deadlock against the stdout reader.
    Returns (returncode, stderr_text). Kills ffmpeg at the timeout.
    """
    with tempfile.TemporaryFile(mode="w+") as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True)
        killer = threading.Timer(timeout_s, proc.kill)
        killer.start()
        try:
            for line in proc.stdout:
                frac = rules.parse_progress(line, clip_ms)
                if frac is not None:
                    on_progress(frac)
            proc.wait()
        finally:
            killer.cancel()
        err.seek(0)
        return proc.returncode, err.read()


@celery_app.task(name="render_snippet_export", bind=True, max_retries=0)
def render_snippet_export(self, export_id: str):
    """Render one export row: ffmpeg, upload, mark done.

    No automatic retry: a failed export is retried by posting the same
    request again, which re-queues the same row (routers/snippet_export.py).
    Failure leaves `status = failed` with a one-line `error`, and removes
    whatever output exists, local and in S3.
    """
    db = SessionLocal()
    work_dir = None
    key = None
    uploaded = False
    try:
        try:
            eid = uuid.UUID(str(export_id))
        except ValueError:
            logger.error("render_snippet_export: bad id %r", export_id)
            return
        row = db.query(SnippetExport).filter(SnippetExport.id == eid).first()
        if row is None:
            return
        if row.status not in ("queued", "running"):
            # Done, failed or expired already; a duplicate message is a no-op.
            return
        media_file = (
            db.query(MediaFile).filter(MediaFile.id == row.media_file_id).first()
            if row.media_file_id else None
        )
        if media_file is None:
            _set(db, eid, status="failed", error="The source file no longer exists.")
            return

        clip_ms = row.end_ms - row.start_ms
        framing = rules.normalise_framing(row.framing)
        choice = rules.choose_input(media_file)
        key = rules.export_key(row.project_id, row.id)
        _set(db, eid, status="running", progress=0.0, error=None)
        logger.info("Snippet export %s: %s, %s", eid, row.aspect, choice.reason)

        work_dir = tempfile.mkdtemp(prefix=f"snippetexport_{eid}_")
        output = os.path.join(work_dir, "clip.mp4")
        cmd = rules.ffmpeg_command(
            _presigned_input_url(choice.s3_key), row.start_ms, row.end_ms,
            row.aspect, framing, output,
        )

        last = [0.0]

        def on_progress(frac):
            now = time.monotonic()
            if now - last[0] >= PROGRESS_WRITE_SECONDS:
                last[0] = now
                _set(db, eid, progress=frac)

        code, stderr = _run_ffmpeg(cmd, clip_ms, on_progress, rules.render_timeout_seconds(clip_ms))
        if code != 0 or not os.path.exists(output) or os.path.getsize(output) == 0:
            raise RuntimeError(rules.short_error(stderr, code))

        size = os.path.getsize(output)
        s3_service.get_s3_client().upload_file(
            output, settings.s3_bucket, key,
            ExtraArgs={"ContentType": "video/mp4"},
        )
        uploaded = True
        retention = snippet_admin.current_values(
            snippet_admin.settings_row(db, row.project_id)
        )["export_retention_days"]
        _set(
            db, eid, status="done", progress=1.0, s3_key=key, size_bytes=size,
            error=None, expires_at=rules.expires_at(retention),
        )
    except Exception as exc:  # noqa: BLE001 — every failure ends as a failed row
        logger.exception("Snippet export %s failed", export_id)
        db.rollback()
        if key and uploaded:
            try:
                s3_service.delete_object(key)
            except Exception:
                logger.warning("Could not remove partial export %s", key, exc_info=True)
        try:
            _set(db, uuid.UUID(str(export_id)), status="failed", progress=0.0,
                 s3_key=None, size_bytes=None, error=str(exc)[:300] or "The export failed.")
        except Exception:
            logger.warning("Could not mark export %s failed", export_id, exc_info=True)
    finally:
        db.close()
        if work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


@celery_app.task(name="sweep_snippet_exports")
def sweep_snippet_exports(now: Optional[str] = None) -> dict:
    """Delete the objects of exports past `expires_at` and mark them expired.

    Only rows WITH an `expires_at` are considered: NULL is the project
    saying "keep forever" (export_retention_days = NULL), and is never
    swept. The row stays, as `expired`, so a client polling its id learns
    it is gone. One commit per row: a failing delete leaves that row for
    the next pass instead of rolling back the others.
    """
    db = SessionLocal()
    try:
        cutoff = datetime.fromisoformat(now) if now else datetime.now(timezone.utc)
        rows = (
            db.query(SnippetExport)
            .filter(
                SnippetExport.status == "done",
                SnippetExport.expires_at.isnot(None),
                SnippetExport.expires_at <= cutoff,
            )
            .all()
        )
        swept = 0
        for row in rows:
            try:
                if row.s3_key:
                    if not row.s3_key.startswith(EXPORT_PREFIX):
                        logger.error("Refusing to delete non-export key %s", row.s3_key)
                        continue
                    s3_service.delete_object(row.s3_key)
                row.status = "expired"
                row.s3_key = None
                row.updated_at = datetime.now(timezone.utc)
                db.commit()
                swept += 1
            except Exception:
                db.rollback()
                logger.warning("Sweep could not expire export %s", row.id, exc_info=True)
        if swept:
            logger.info("Expired %d snippet export(s)", swept)
        return {"expired": swept}
    finally:
        db.close()
