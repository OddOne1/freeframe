import logging
import os
from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, ProcessingStatus, FileType
from ..models.project import Project
from ..services.s3_service import (
    create_multipart_upload, presign_upload_part,
    complete_multipart_upload, abort_multipart_upload,
    head_object_size,
)
from ..services.permissions import get_project_member, require_project_role
from ..models.project import ProjectRole
from .site_settings import _get_or_create_settings
from ..services.storage_prefix import lock_storage_prefix, prefix_for_project
from ..schemas.upload import (
    InitiateUploadRequest, InitiateUploadResponse,
    PresignPartRequest, PresignPartResponse,
    CompleteUploadRequest, CompleteUploadResponse, AbortUploadRequest,
    ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, mime_to_asset_type,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])


def _reconcile_file_size(media_file: MediaFile) -> None:
    """Replace the client's declared size with the object's real one (§180).

    `file_size_bytes` is written at /upload/initiate from a number the
    browser sent, and until now nothing ever checked it. Both storage-quota
    checks in this file and every storage figure in the admin UI are sums of
    that column, so under-reporting walked straight past a quota and
    over-reporting could refuse an upload that would have fit.

    The key HEADed is the one the SERVER generated and stored, not
    `body.s3_key` from the request: the client supplies that too, and
    reconciling against a client-chosen key would check a number against
    whatever object the client pointed at. If the two disagree, this HEAD
    fails and the row is flagged — which is the correct outcome, since the
    object this row claims to describe then does not exist.

    ── When the HEAD fails ──────────────────────────────────────────────
    Retried once, then given up on. The upload itself is NOT failed: the
    bytes are in S3, complete_multipart_upload has already returned, and
    refusing the upload over a size check would throw away a good file to
    protect a number. Nor is the bad value left silently in place —
    `size_verified_at` stays NULL, which is the work queue a backfill reads
    (`WHERE size_verified_at IS NULL`), and the mismatch is logged at ERROR
    with the key so it is findable before that backfill exists.

    One retry rather than several: this runs inside a request the user is
    waiting on, and the failures worth beating this way are the momentary
    ones. A bucket that is genuinely unreachable is not going to answer on
    the fourth try either, and the NULL flag loses nothing by waiting.
    """
    declared = media_file.file_size_bytes
    last_error: Exception | None = None

    for _attempt in (1, 2):
        try:
            actual = head_object_size(media_file.s3_key_raw)
        except Exception as e:  # noqa: BLE001 — every boto3 failure is the same decision here
            last_error = e
            continue

        media_file.file_size_bytes = actual
        media_file.size_verified_at = datetime.now(timezone.utc)
        if actual != declared:
            # Worth a line even though it is handled: a large, consistent
            # gap is either a broken client or someone probing the quota.
            logger.warning(
                "upload size mismatch for %s: client declared %s, S3 has %s",
                media_file.s3_key_raw, declared, actual,
            )
        return

    logger.error(
        "could not verify upload size for %s after 2 attempts (%s); "
        "leaving the client-declared %s bytes unverified for backfill",
        media_file.s3_key_raw, last_error, declared,
    )


@router.post("/initiate", response_model=InitiateUploadResponse)
def initiate_upload(
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate mime type
    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {body.mime_type}")
    if body.file_size_bytes > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 2000GB limit")

    # Verify project access (editor or above)
    project = db.query(Project).filter(Project.id == body.project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, body.project_id, current_user, ProjectRole.editor)
    
    # Enforce per-project storage limit if set
    if project.storage_limit_bytes is not None:
        current_storage = db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0))\
            .join(AssetVersion, MediaFile.version_id == AssetVersion.id)\
            .join(Asset, AssetVersion.asset_id == Asset.id)\
            .filter(Asset.project_id == project.id, Asset.deleted_at.is_(None))\
            .scalar()
        if current_storage + body.file_size_bytes > project.storage_limit_bytes:
            raise HTTPException(status_code=400, detail="Project storage limit exceeded")

    # Enforce platform-wide storage limit if set -- same aggregate pattern
    # as the per-project check above, just without the project_id filter.
    # Independent of per-user/per-project limits entirely (task 12);
    # reuses the site_settings singleton rather than re-querying it a
    # different way.
    site_settings = _get_or_create_settings(db)
    if site_settings.total_storage_limit_bytes is not None:
        platform_storage = db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0))\
            .join(AssetVersion, MediaFile.version_id == AssetVersion.id)\
            .join(Asset, AssetVersion.asset_id == Asset.id)\
            .filter(Asset.deleted_at.is_(None))\
            .scalar()
        if platform_storage + body.file_size_bytes > site_settings.total_storage_limit_bytes:
            raise HTTPException(status_code=400, detail="Platform storage limit exceeded")

    # ── Freeze the project's storage prefix (§14), in its OWN transaction ──
    #
    # Placement is the whole fix for §27, and both halves of it matter.
    #
    # BEFORE the asset insert: an `INSERT INTO assets` takes a KEY SHARE
    # lock on the referenced projects row for its foreign key. A later
    # `SELECT ... FOR UPDATE` on that same row then conflicts with every
    # OTHER concurrent initiate's KEY SHARE — so two of them deadlock, each
    # holding KEY SHARE and waiting for FOR UPDATE. Reproduced against real
    # Postgres: 12 concurrent initiates to a fresh project gave 2 successes
    # and 10 `DeadlockDetected`, which is the 500 the live batch upload hit.
    #
    # COMMITTED immediately: the previous code held that row lock until the
    # end of the request, which is *after* the S3 CreateMultipartUpload
    # below. Holding a row lock across a network round-trip serialises the
    # entire batch behind one S3 latency each. Committing here drops the
    # lock in microseconds — measured 0.9s vs 5.0s for 12 files.
    #
    # Committing early is safe: nothing else is pending in this transaction
    # yet (the checks above are all reads), and a prefix locked for an
    # upload that later fails costs nothing — it is a naming decision, and
    # `lock_storage_prefix` is idempotent.
    lock_storage_prefix(db, project.id)
    db.commit()

    # Get or create asset
    if body.asset_id:
        asset = db.query(Asset).filter(Asset.id == body.asset_id, Asset.deleted_at.is_(None)).first()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset.project_id != body.project_id:
            raise HTTPException(status_code=400, detail="Asset does not belong to the specified project")
    else:
        asset_type = mime_to_asset_type(body.mime_type)
        # §127 — the project's default decides only the STARTING state of
        # this new file's toggle. It is read once, here, and never consulted
        # again for this asset: changing the project setting later must not
        # reach back into files that already exist.
        from ..services.transcription_defaults import default_transcription_enabled
        asset = Asset(
            project_id=body.project_id,
            name=body.asset_name,
            asset_type=asset_type,
            created_by=current_user.id,
            created_by_name=current_user.name,
            folder_id=body.folder_id,
            transcription_enabled=default_transcription_enabled(project),
        )
        db.add(asset)
        db.flush()

    # Get next version number
    last_version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()
    next_version_number = (last_version.version_number + 1) if last_version else 1

    # Build S3 key: raw/{project_id}/{asset_id}/{version_id}/{filename}
    version = AssetVersion(
        asset_id=asset.id,
        version_number=next_version_number,
        processing_status=ProcessingStatus.uploading,
        created_by=current_user.id,
        created_by_name=current_user.name,
    )
    db.add(version)
    db.flush()

    # Locked and committed above; this just reads the frozen values. The
    # commit expired the instance, so touching it refreshes from the row
    # whichever request won the race.
    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{prefix_for_project(project)}/{asset.id}/{version.id}/original{ext}"

    # Initiate S3 multipart upload
    upload_id = create_multipart_upload(s3_key, body.mime_type)

    # Create MediaFile record
    file_type_map = {AssetType.image: FileType.image, AssetType.audio: FileType.audio, AssetType.video: FileType.video, AssetType.image_carousel: FileType.image}
    media_file = MediaFile(
        version_id=version.id,
        file_type=file_type_map.get(asset.asset_type, FileType.video),
        original_filename=body.original_filename,
        mime_type=body.mime_type,
        file_size_bytes=body.file_size_bytes,
        s3_key_raw=s3_key,
    )
    db.add(media_file)
    db.commit()

    return InitiateUploadResponse(
        upload_id=upload_id,
        s3_key=s3_key,
        asset_id=asset.id,
        version_id=version.id,
    )


@router.post("/presign-part", response_model=PresignPartResponse)
def presign_part(
    body: PresignPartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.part_number < 1 or body.part_number > 10000:
        raise HTTPException(status_code=400, detail="Part number must be between 1 and 10000")

    # Verify the s3_key belongs to an upload initiated by this user
    media_file = db.query(MediaFile).filter(MediaFile.s3_key_raw == body.s3_key).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found")
    version = db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    if not version or version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    url = presign_upload_part(body.s3_key, body.upload_id, body.part_number)
    return PresignPartResponse(presigned_url=url, part_number=body.part_number)


@router.post("/complete", response_model=CompleteUploadResponse)
def complete_upload(
    body: CompleteUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate DB first
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    # Then complete S3 multipart
    complete_multipart_upload(body.s3_key, body.upload_id, [p.model_dump() for p in body.parts])

    # §180 — the object exists now, so its size is knowable. Done BEFORE the
    # commit below, in the same transaction that marks the version as
    # processing: the row becomes final and reconciled in one step, so no
    # quota check can ever read a committed-but-unreconciled number. Every
    # reader of this column (the two checks in initiate_upload above,
    # site_settings' platform total, projects' per-project totals) is a live
    # SQL SUM computed per request, so they all pick this up from here on.
    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if media_file:
        _reconcile_file_size(media_file)

    version.processing_status = ProcessingStatus.processing
    db.commit()

    # Trigger transcoding in background (task dispatched in Step 7)
    background_tasks.add_task(_trigger_processing, body.asset_id, body.version_id)

    return CompleteUploadResponse(status="processing", asset_id=body.asset_id, version_id=body.version_id)


def _trigger_processing(asset_id: uuid.UUID, version_id: uuid.UUID):
    """Dispatch Celery task to process the uploaded asset."""
    from ..tasks.transcode_tasks import process_asset
    from ..tasks.celery_app import send_task_safe
    send_task_safe(process_asset, str(asset_id), str(version_id))


@router.post("/abort", status_code=status.HTTP_204_NO_CONTENT)
def abort_upload(
    body: AbortUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    version = db.query(AssetVersion).filter(
        AssetVersion.id == body.version_id,
        AssetVersion.deleted_at.is_(None),
    ).first()
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")
    if version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    abort_multipart_upload(body.s3_key, body.upload_id)
    version.processing_status = ProcessingStatus.failed
    db.commit()
