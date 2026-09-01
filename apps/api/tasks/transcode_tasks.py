import uuid
import sys
import os
import asyncio
import json
import logging

# Ensure the workspace root is on the path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))))

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import AssetVersion, MediaFile, ProcessingStatus, AssetType
from ..models.asset import Asset
from ..models.project import Project
from ..services.s3_service import get_s3_client
from ..services.storage_prefix import prefix_for_project
from ..config import settings

logger = logging.getLogger(__name__)


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _notify_new_version(db, asset, version) -> None:
    """Notify the asset's assignee that a new version is ready (§108).

    Scoped to the assignee, matching the only assignment concept this app
    has (`Asset.assignee_id`, the same one the assignment-change
    notification uses). Deliberately NOT the whole project: "other uploads"
    on a busy project would be a firehose, and there is no per-project
    subscription model to narrow it with.

    Never fires for v1. Every asset's first version reaches `ready`, and a
    "new version" notice for the upload someone just performed is noise.
    """
    from ..models.activity import Notification, NotificationType
    from ..models.user import User
    from ..services.notification_prefs import should_create_notification, should_send_email
    from ..config import settings
    from .celery_app import send_task_safe
    from .email_tasks import send_new_version_email

    if version.version_number <= 1:
        return
    assignee_id = getattr(asset, "assignee_id", None)
    if not assignee_id or assignee_id == version.created_by:
        # Nobody assigned, or the assignee uploaded it themselves.
        return

    assignee = db.query(User).filter(User.id == assignee_id).first()
    if not assignee:
        return

    if should_create_notification(assignee, "other_uploads"):
        db.add(Notification(
            user_id=assignee_id,
            type=NotificationType.new_version,
            asset_id=asset.id,
        ))
        db.commit()

    if should_send_email(assignee, "other_uploads"):
        send_task_safe(
            send_new_version_email,
            to_email=assignee.email,
            uploader_name=version.created_by_name or "Someone",
            asset_name=asset.name,
            version_number=version.version_number,
            asset_link=f"{settings.frontend_url}/projects/{asset.project_id}/assets/{asset.id}",
        )


# The decorator belongs HERE, on the task, and had drifted onto the helper
# above when that helper was inserted between the two -- which left
# process_asset a plain function with no .delay(), so every dispatch
# raised AttributeError and no upload was ever processed.
@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)
def process_asset(self, asset_id: str, version_id: str):
    """Main processing task dispatched after upload completes."""
    db = SessionLocal()
    try:
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        if not version:
            return  # version already cleaned up

        # §114 — idempotency guard, required by task_acks_late.
        #
        # With late acks a task is redelivered if the worker dies before it
        # finishes, and "finishes" includes the window between the last line
        # of work and the ack itself. A redelivery in that window would redo
        # a full transcode of something already done.
        #
        # The work below is otherwise safe to repeat -- output_prefix is
        # derived from the ids, so a re-run overwrites its own objects rather
        # than orphaning new ones -- but it is minutes of CPU, so it is worth
        # not repeating. Only `ready` is skipped: `failed` must stay
        # retryable, and `processing` is exactly the state a genuinely lost
        # task is left in, which is what redelivery exists to rescue.
        if version.processing_status == ProcessingStatus.ready:
            logger.info(
                "process_asset: version %s is already ready, skipping redelivered task",
                version_id,
            )
            return

        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        if not asset:
            if version:
                version.processing_status = ProcessingStatus.failed
                db.commit()
            return

        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if not media_file:
            version.processing_status = ProcessingStatus.failed
            db.commit()
            return

        # Reset to processing status before each attempt
        version.processing_status = ProcessingStatus.processing
        db.commit()

        # The project's prefix is already frozen -- upload initiation locks
        # it before this task can ever be dispatched (§14) -- so this reads
        # the stored value rather than deriving anything.
        project = db.query(Project).filter(Project.id == asset.project_id).first()
        output_prefix = f"processed/{prefix_for_project(project)}/{asset_id}/{version_id}"
        s3 = get_s3_client()

        try:
            if asset.asset_type in (AssetType.video,):
                _process_video(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type == AssetType.audio:
                _process_audio(db, asset, version, media_file, s3, output_prefix)
            elif asset.asset_type in (AssetType.image, AssetType.image_carousel):
                _process_image(db, asset, version, media_file, s3, output_prefix)

            version.processing_status = ProcessingStatus.ready
            # A definite 100, not whatever the final report happened to be:
            # ffmpeg's last progress line is often a percent or two short, and
            # a finished asset showing 98% reads as stalled.
            version.processing_progress = 100
            db.commit()

            # Publish SSE event (best-effort)
            _publish_event(str(asset.project_id), "transcode_complete", {
                "asset_id": asset_id,
                "version_id": version_id,
            })

            # §108 — tell the asset's assignee a new version has landed.
            #
            # HERE rather than in initiate_new_version, and that is the whole
            # timing question: a version that is still uploading or
            # transcoding is not something a reviewer can open. This is the
            # line that makes it playable, and the two side-effects above it
            # are already best-effort for the same reason — nothing after the
            # commit may fail the (successful) transcode.
            try:
                _notify_new_version(db, asset, version)
            except Exception:
                pass

            # Speech-to-text runs as a separate, much slower stage on its own
            # queue -- the asset is already `ready` and playable above, and
            # nothing here is allowed to change that. Dispatch is swallowed
            # on failure for exactly that reason: if it were allowed to
            # raise, it would land in the except below and re-run the entire
            # (already successful) transcode.
            if asset.asset_type in (AssetType.video, AssetType.audio):
                try:
                    from .transcribe_tasks import transcribe_asset
                    transcribe_asset.delay(asset_id, version_id)
                except Exception:
                    logger.warning(
                        "Could not queue transcription for asset %s version %s",
                        asset_id, version_id, exc_info=True,
                    )

        except Exception as exc:
            version.processing_status = ProcessingStatus.failed
            db.commit()
            _publish_event(str(asset.project_id), "transcode_failed", {
                "asset_id": asset_id,
                "error": str(exc),
            })
            raise self.retry(exc=exc)

    finally:
        db.close()


# A source is "heavy" when re-encoding it per download is the expensive part
# (§57). Either test alone qualifies it.
HEAVY_BITRATE_BPS = 100_000_000  # 100 Mbit/s
# Compared against the LONGER side, not width: a 2160x3840 vertical shoot or
# an anamorphic 4K source is exactly as heavy to decode as a landscape one,
# and testing width alone would quietly exclude both.
HEAVY_LONG_EDGE = 3840


def _needs_download_proxy(result) -> bool:
    """Decided once, from the ffprobe pass the transcode already ran (§57).

    Deliberately reuses `result` rather than probing again: the numbers are
    already in hand, and a second ffprobe on a multi-GB original to learn
    what we just learned would cost more than the check saves.
    """
    bitrate = (result.technical_metadata or {}).get("video_bit_rate")
    if isinstance(bitrate, int) and bitrate > HEAVY_BITRATE_BPS:
        return True
    long_edge = max(result.width or 0, result.height or 0)
    return long_edge >= HEAVY_LONG_EDGE


def _process_video(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.ffmpeg_transcoder import FFmpegTranscoder
    from packages.transcoder.base import TranscodeJob

    transcoder = FFmpegTranscoder(s3, settings.s3_bucket, settings.s3_endpoint)
    job = TranscodeJob(
        media_id=str(asset.id),
        version_id=str(version.id),
        input_s3_key=media_file.s3_key_raw,
        output_s3_prefix=output_prefix,
        qualities=["1080p", "720p", "360p"],
    )

    # §113 — persist alongside the live event, not instead of it.
    #
    # The SSE event stays exactly as it was: it is what drives a panel that is
    # already open, and it is cheap. What it could not do is survive nobody
    # listening — Redis pub/sub has no replay, so a reload mid-transcode had
    # nothing to read and the panel fell back to a hardcoded 0/100 guess.
    #
    # Writes are THROTTLED to whole-percent changes. ffmpeg reports far more
    # often than that, and a row UPDATE per report would put thousands of
    # writes behind every transcode to move a number nobody can see change.
    last_written = {"pct": None}

    def _report_progress(percent: int) -> None:
        _publish_event(str(asset.project_id), "transcode_progress", {
            "asset_id": str(asset.id),
            "percent": percent,
        })
        pct = max(0, min(100, int(percent)))
        if last_written["pct"] == pct:
            return
        last_written["pct"] = pct
        try:
            version.processing_progress = pct
            db.commit()
        except Exception:
            # Progress is a convenience, never a reason to fail a transcode
            # that is otherwise succeeding. A rollback keeps the session
            # usable for the real work still to come.
            db.rollback()

    result = _run_async(transcoder.transcode(job, progress_callback=_report_progress))
    if not result.success:
        raise RuntimeError(f"Transcode failed: {result.error}")

    media_file.s3_key_processed = result.hls_prefix
    if result.thumbnail_keys:
        media_file.s3_key_thumbnail = result.thumbnail_keys[0]
    if result.width is not None:
        media_file.width = result.width
    if result.height is not None:
        media_file.height = result.height
    if result.duration_seconds is not None:
        media_file.duration_seconds = result.duration_seconds
    if result.fps is not None:
        media_file.fps = result.fps
    if result.technical_metadata:
        media_file.technical_metadata = result.technical_metadata

    # Built alongside the ladder rather than behind a separate trigger, so a
    # qualifying source has its proxy by the time anyone can ask to download
    # it. A failure here must NOT fail the upload: playback is already
    # complete and correct at this point, and the only consequence of no
    # proxy is that downloads re-encode from the original — which is exactly
    # what every non-qualifying asset does anyway.
    if _needs_download_proxy(result):
        # Same {project_prefix}/{asset}/{version} tail as the HLS output,
        # under its own area — which is what lets purge_service delete it by
        # prefix alongside `processed/` and `raw/` rather than needing the
        # exact key.
        proxy_key = f"{output_prefix.replace('processed/', 'proxies/', 1)}/1080p.mp4"
        try:
            transcoder.build_download_proxy(media_file.s3_key_raw, proxy_key)
            media_file.proxy_1080p_key = proxy_key
        except Exception:
            logger.exception(
                "Download proxy failed for asset %s; downloads will re-encode "
                "from the original", asset.id,
            )

    db.flush()


def _process_audio(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_audio
    result = process_audio(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("mp3_key")
    if result.get("waveform_key"):
        media_file.s3_key_thumbnail = result["waveform_key"]
    if result.get("duration_seconds") is not None:
        media_file.duration_seconds = result["duration_seconds"]
    if result.get("technical_metadata"):
        media_file.technical_metadata = result["technical_metadata"]
    db.flush()


def _process_image(db, asset, version, media_file, s3, output_prefix):
    from packages.transcoder.image_processor import process_image
    result = process_image(s3, settings.s3_bucket, media_file.s3_key_raw, output_prefix)
    media_file.s3_key_processed = result.get("webp_key")
    media_file.s3_key_thumbnail = result.get("thumbnail_key")
    if result.get("width") is not None:
        media_file.width = result["width"]
    if result.get("height") is not None:
        media_file.height = result["height"]
    if result.get("technical_metadata"):
        media_file.technical_metadata = result["technical_metadata"]
    db.flush()


def _publish_event(project_id: str, event_type: str, payload: dict):
    """Publish SSE event via Redis from Celery worker context."""
    try:
        import redis as sync_redis
        r = sync_redis.from_url(settings.redis_url, decode_responses=True)
        message = json.dumps({"type": event_type, "payload": payload})
        r.publish(f"project:{project_id}", message)
        r.close()
    except Exception:
        pass  # SSE publish is best-effort
