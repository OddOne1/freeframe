"""Graded exports: burn a .cube LUT into a one-off video, then delete it.

The core promise of this feature (user's words, 2026-07-30): "the footage
only gets the lut for that download and the file with the lut gets deleted
from the server after, so we only ever keep the basic files." So the export
lands under its own `lut-exports/` prefix — never `processed/` — and a
delayed cleanup task removes it an hour later.

Runs on the existing `transcoding` queue: same ffmpeg/CPU profile as a
normal transcode, so it shares the worker rather than needing its own the
way transcription did.
"""

import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timedelta, timezone

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.lut import Lut
from ..models.share import VARIANT_QUALITY, VARIANT_USES_LUT, DownloadVariant
from ..services import s3_service
from ..services.s3_service import get_s3_client, build_download_filename
from ..config import settings
from .transcode_tasks import _publish_event

logger = logging.getLogger(__name__)

# One hour. Long enough that a user who kicks off an export, gets distracted
# and comes back still finds their download; short enough that graded files
# are not meaningfully "kept" on the server.
EXPORT_TTL_SECONDS = 3600

# Everything graded lives under here and nowhere else -- both the targeted
# delete and the sweep refuse to touch anything outside it.
EXPORT_PREFIX = "lut-exports/"


def _presigned_input_url(s3_key: str, expires_in: int = 7200) -> str:
    """Presigned GET for ffmpeg's `-i`, so the source streams instead of
    being downloaded. Same approach as FFmpegTranscoder._get_presigned_url.

    Deliberately get_s3_client(), NOT _get_presign_client(): this URL is
    consumed by ffmpeg *inside the container*, where the LAN endpoint is the
    reachable one. The presign client exists for URLs handed to a browser,
    which is the opposite case.
    """
    return get_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.s3_bucket, "Key": s3_key},
        ExpiresIn=expires_in,
    )



# The transcode ladder's own rungs, verbatim from
# packages/transcoder/ffmpeg_transcoder.py's QUALITY_MAP (§30). Copied
# rather than imported because that module is a separate package built for
# the HLS pipeline; what matters is that the numbers match, and a drift
# would mean a file labelled "Proxy 720p" that is not the same 720p the
# player streams.
QUALITY_LADDER = {
    "1080p": ("1920:1080", 20),
    "720p": ("1280:720", 22),
}


def _build_export_command(variant: DownloadVariant, input_url: str, local_lut, output_path: str) -> list[str]:
    """ffmpeg argv for one download variant.

    Always a re-encode from the original, never a remux of the HLS
    renditions (§30): burning a LUT requires decode+encode anyway, and
    mixing the two would put two files with different quality
    characteristics under one label.
    """
    filters = []
    if VARIANT_USES_LUT[variant]:
        if not local_lut:
            raise ValueError(f"{variant.value} needs a LUT but none was resolved")
        # ffmpeg filtergraph syntax treats : and \ as special.
        escaped = local_lut.replace("\\", "\\\\").replace(":", "\\:")
        filters.append(f"lut3d='{escaped}'")

    quality = VARIANT_QUALITY[variant]
    if quality:
        scale, crf = QUALITY_LADDER[quality]
        preset = "fast"
        # Same scale/pad expression the ladder uses: fit inside the box
        # without distorting, then pad to even dimensions because H.264
        # cannot encode odd ones.
        filters.append(
            f"scale={scale}:force_original_aspect_ratio=decrease,"
            f"pad=ceil(iw/2)*2:ceil(ih/2)*2"
        )
    else:
        # The un-scaled variants keep the settings graded exports have
        # always used, so this generalisation does not silently change what
        # an existing "Download with LUT" produces.
        crf, preset = 18, "medium"

    if not filters:
        raise ValueError(
            f"{variant.value} needs no processing — it is the stored file, "
            "which is served directly rather than exported"
        )

    return [
        "ffmpeg", "-y", "-i", input_url,
        "-vf", ",".join(filters),
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        # The ladder has no -c:a at all and inherits ffmpeg's default for
        # mpegts. A standalone download must not: pin it.
        "-c:a", "aac", "-b:a", "192k",
        # HLS segments do not carry this; a single downloadable file should,
        # so it starts playing before it has fully downloaded.
        "-movflags", "+faststart",
        # Deliberately NO -r: neither ladder rung touches framerate, so
        # ffmpeg preserves the source's.
        output_path,
    ]


@celery_app.task(bind=True, max_retries=1, default_retry_delay=60)
def burn_lut_export(
    self,
    asset_id: str,
    version_id: str,
    lut_id: str,
    export_id: str,
    variant: str = DownloadVariant.raw_lut.value,
):
    """Render one download variant of `version_id`, upload, schedule deletion.

    Still named burn_lut_export, and still defaults to raw_lut, so the
    existing "Download with LUT" caller and any task already sitting on the
    broker keep working unchanged across a deploy (§30). `variant` widens
    it to the proxy renderings rather than forking a second task that would
    duplicate the upload / TTL / SSE plumbing.

    `lut_id` may be empty for a variant that burns no LUT.
    """
    db = SessionLocal()
    work_dir = None
    try:
        try:
            variant_enum = DownloadVariant(variant)
        except ValueError:
            logger.error("Unknown download variant %r for asset %s", variant, asset_id)
            return

        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        needs_lut = VARIANT_USES_LUT[variant_enum]
        lut = (
            db.query(Lut).filter(Lut.id == uuid.UUID(lut_id)).first()
            if lut_id else None
        )
        if not asset or not version:
            return
        if needs_lut and not lut:
            logger.error("Variant %s needs a LUT but %r did not resolve", variant, lut_id)
            return
        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if not media_file:
            return

        project_id = str(asset.project_id)
        export_key = f"{EXPORT_PREFIX}{project_id}/{asset_id}/{version_id}/{export_id}.mp4"

        try:
            work_dir = tempfile.mkdtemp(prefix=f"lutexport_{export_id}_")
            # The .cube genuinely has to be local -- ffmpeg's lut3d filter
            # takes a filesystem path, not a URL. The source video does not,
            # and streaming it avoids pulling multi-GB originals to disk.
            local_lut = None
            if needs_lut:
                local_lut = os.path.join(work_dir, "grade.cube")
                get_s3_client().download_file(settings.s3_bucket, lut.s3_key, local_lut)

            output_path = os.path.join(work_dir, "export.mp4")
            input_url = _presigned_input_url(media_file.s3_key_raw)

            cmd = _build_export_command(variant_enum, input_url, local_lut, output_path)
            subprocess.run(cmd, capture_output=True, check=True, timeout=14400)

            s3_service.get_s3_client().upload_file(
                output_path,
                settings.s3_bucket,
                export_key,
                ExtraArgs={"ContentType": "video/mp4", "CacheControl": "no-store"},
            )

            # Name it after what it actually is, so two variants of one
            # asset do not land in the downloads folder as the same file.
            suffix_parts = []
            if VARIANT_QUALITY[variant_enum]:
                suffix_parts.append(VARIANT_QUALITY[variant_enum])
            if needs_lut and lut:
                suffix_parts.append(lut.name)
            suffix = f" ({' - '.join(suffix_parts)})" if suffix_parts else ""
            download_name = build_download_filename(
                f"{asset.name}{suffix}",
                media_file.original_filename or media_file.s3_key_raw,
            )
            # .mp4 regardless of the source container -- that's what was
            # actually encoded above.
            download_name = os.path.splitext(download_name)[0] + ".mp4"

            # Schedule the delete BEFORE announcing readiness, so there is no
            # window where a client learns about a file that has no cleanup
            # queued behind it.
            delete_lut_export.apply_async(args=[export_key], countdown=EXPORT_TTL_SECONDS)

            _publish_event(project_id, "lut_export_ready", {
                "asset_id": asset_id,
                "version_id": version_id,
                "lut_id": lut_id,
                "variant": variant,
                "export_id": export_id,
                "expires_in": EXPORT_TTL_SECONDS,
                "download_filename": download_name,
            })

        except Exception as exc:
            logger.exception("LUT export failed for asset %s (lut %s)", asset_id, lut_id)
            _publish_event(project_id, "lut_export_failed", {
                "asset_id": asset_id,
                "variant": variant,
                "export_id": export_id,
                "error": str(exc),
            })
            raise self.retry(exc=exc)

    finally:
        db.close()
        if work_dir:
            shutil.rmtree(work_dir, ignore_errors=True)


@celery_app.task(bind=True, max_retries=3, default_retry_delay=300)
def delete_lut_export(self, export_key: str):
    """Delete one graded export from S3.

    Scheduled by burn_lut_export via apply_async(countdown=...). Guarded by
    the prefix check below: this task takes a raw key off the broker, and a
    bug or a malformed retry must not be able to point it at `processed/` or
    `raw/`.
    """
    if not export_key.startswith(EXPORT_PREFIX):
        logger.error("Refusing to delete non-export key: %s", export_key)
        return
    try:
        s3_service.delete_object(export_key)
        logger.info("Deleted graded export %s", export_key)
    except Exception as exc:
        logger.warning("Could not delete graded export %s: %s", export_key, exc)
        raise self.retry(exc=exc)


@celery_app.task(name="sweep_lut_exports")
def sweep_lut_exports():
    """Safety net for the countdown-scheduled deletes above.

    An ETA/countdown task lives in the worker's memory once it has been
    prefetched, so a worker restart between scheduling and firing can drop
    it -- and this project's deploy procedure restarts every worker on every
    release. Without this sweep, any export scheduled shortly before a
    deploy would be kept forever, quietly breaking the one hard promise this
    feature makes ("we only ever keep the basic files").

    Verified locally that countdown does produce a correct future eta on the
    right queue; what could not be verified without a live broker is that a
    worker survives to honour it. This closes that gap rather than assuming.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=EXPORT_TTL_SECONDS)
    s3 = get_s3_client()
    deleted = 0
    try:
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=settings.s3_bucket, Prefix=EXPORT_PREFIX):
            for obj in page.get("Contents", []) or []:
                if obj["LastModified"] >= cutoff:
                    continue
                try:
                    s3_service.delete_object(obj["Key"])
                    deleted += 1
                except Exception:
                    logger.warning("Sweep could not delete %s", obj["Key"], exc_info=True)
    except Exception:
        logger.warning("LUT export sweep failed", exc_info=True)
        return

    if deleted:
        logger.info("Swept %d stale graded export(s)", deleted)
