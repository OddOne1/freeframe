from fastapi import APIRouter, Depends, HTTPException, status, Query
from sqlalchemy.orm import Session
from sqlalchemy import func
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, AssetStatus, FileType, ProcessingStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.share import AssetShare
from ..models.activity import Mention, Notification, NotificationType
from ..models.vote import Vote
from ..schemas.asset import AssetResponse, AssetVersionResponse, AssetUpdate, StreamUrlResponse, MediaFileResponse, VoteToggleResponse
from ..schemas.notification import AssignmentUpdate
from ..services.permissions import require_project_role, require_asset_access, can_access_asset, is_public_project, get_project_member
from ..services.s3_service import build_download_filename
from .hls_proxy import create_hls_token, proxy_url_for
from ..schemas.upload import InitiateUploadRequest, InitiateUploadResponse, ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES, mime_to_asset_type
from ..services.s3_service import create_multipart_upload
from .folders import _get_descendant_ids as _get_descendant_folder_ids

router = APIRouter(tags=["assets"])


def _build_asset_response(asset: Asset, db: Session, current_user_id: uuid.UUID | None = None) -> AssetResponse:
    """Build AssetResponse with latest version and its files."""
    latest_version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset.id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()

    version_response = None
    thumbnail_url = None
    if latest_version:
        files = db.query(MediaFile).filter(MediaFile.version_id == latest_version.id).all()
        version_response = AssetVersionResponse.model_validate(latest_version)
        version_response.files = [MediaFileResponse.model_validate(f) for f in files]
        # Get thumbnail from first file that has one.
        # Audio stores waveform JSON in s3_key_thumbnail — skip it, it's not an image.
        if asset.asset_type != AssetType.audio:
            for f in files:
                if f.s3_key_thumbnail:
                    thumbnail_url = proxy_url_for(f.s3_key_thumbnail)
                    break

    resp = AssetResponse.model_validate(asset)
    resp.latest_version = version_response
    resp.thumbnail_url = thumbnail_url
    resp.vote_count = db.query(Vote).filter(Vote.asset_id == asset.id).count()
    resp.voted_by_me = current_user_id is not None and db.query(Vote).filter(
        Vote.asset_id == asset.id, Vote.user_id == current_user_id,
    ).first() is not None
    return resp


def _build_asset_responses_bulk(assets: list[Asset], db: Session, current_user_id: uuid.UUID | None = None) -> list[AssetResponse]:
    """Build AssetResponse list with bulk-loaded versions and files (no N+1)."""
    if not assets:
        return []

    asset_ids = [a.id for a in assets]

    # Bulk load latest version per asset using a subquery
    latest_version_subq = (
        db.query(
            AssetVersion.asset_id,
            func.max(AssetVersion.version_number).label("max_version"),
        )
        .filter(AssetVersion.asset_id.in_(asset_ids), AssetVersion.deleted_at.is_(None))
        .group_by(AssetVersion.asset_id)
        .subquery()
    )
    latest_versions = (
        db.query(AssetVersion)
        .join(latest_version_subq, (AssetVersion.asset_id == latest_version_subq.c.asset_id) & (AssetVersion.version_number == latest_version_subq.c.max_version))
        .all()
    )
    version_by_asset = {v.asset_id: v for v in latest_versions}

    # Bulk load media files for all those versions
    version_ids = [v.id for v in latest_versions]
    all_files = db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all() if version_ids else []
    files_by_version: dict = {}
    for f in all_files:
        files_by_version.setdefault(f.version_id, []).append(f)

    # Bulk load vote counts + this user's votes
    vote_counts: dict = dict(
        db.query(Vote.asset_id, func.count(Vote.id))
        .filter(Vote.asset_id.in_(asset_ids))
        .group_by(Vote.asset_id)
        .all()
    )
    my_voted_ids: set = set()
    if current_user_id is not None:
        my_voted_ids = set(
            row[0] for row in db.query(Vote.asset_id).filter(
                Vote.asset_id.in_(asset_ids),
                Vote.user_id == current_user_id,
            ).all()
        )

    result = []
    for asset in assets:
        version = version_by_asset.get(asset.id)
        version_response = None
        thumbnail_url = None
        if version:
            files = files_by_version.get(version.id, [])
            version_response = AssetVersionResponse.model_validate(version)
            version_response.files = [MediaFileResponse.model_validate(f) for f in files]
            # Audio stores waveform JSON in s3_key_thumbnail — skip it, it's not an image.
            if asset.asset_type != AssetType.audio:
                for f in files:
                    if f.s3_key_thumbnail:
                        thumbnail_url = proxy_url_for(f.s3_key_thumbnail)
                        break

        asset_resp = AssetResponse.model_validate(asset)
        asset_resp.latest_version = version_response
        asset_resp.thumbnail_url = thumbnail_url
        asset_resp.vote_count = vote_counts.get(asset.id, 0)
        asset_resp.voted_by_me = asset.id in my_voted_ids
        result.append(asset_resp)
    return result


@router.get("/projects/{project_id}/assets", response_model=list[AssetResponse])
def list_assets(
    project_id: uuid.UUID,
    include_failed: bool = Query(False, description="Include assets whose latest version failed processing"),
    folder_id: Optional[str] = Query(None, description="Filter by folder. 'root' for root level, UUID for specific folder."),
    recursive: bool = Query(False, description="If true, also include assets from every descendant subfolder (used by 'Flatten Folders')"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    query = db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
    )

    if folder_id == "root":
        if not recursive:
            query = query.filter(Asset.folder_id.is_(None))
        # recursive + root: no folder filter at all — every asset in the project
    elif folder_id is not None:
        target_folder_id = uuid.UUID(folder_id)
        if recursive:
            descendant_ids = _get_descendant_folder_ids(db, target_folder_id)
            query = query.filter(Asset.folder_id.in_([target_folder_id] + descendant_ids))
        else:
            query = query.filter(Asset.folder_id == target_folder_id)

    assets = query.all()

    if not include_failed:
        # Exclude assets where the only version is failed or still uploading
        asset_ids = [a.id for a in assets]
        if asset_ids:
            # Find assets that have at least one non-failed, non-uploading version
            usable = set(
                row[0] for row in db.query(AssetVersion.asset_id).filter(
                    AssetVersion.asset_id.in_(asset_ids),
                    AssetVersion.deleted_at.is_(None),
                    AssetVersion.processing_status.notin_([ProcessingStatus.failed, ProcessingStatus.uploading]),
                ).distinct().all()
            )
            # Also include assets with no versions yet (just created)
            has_any_version = set(
                row[0] for row in db.query(AssetVersion.asset_id).filter(
                    AssetVersion.asset_id.in_(asset_ids),
                    AssetVersion.deleted_at.is_(None),
                ).distinct().all()
            )
            assets = [a for a in assets if a.id in usable or a.id not in has_any_version]

    return _build_asset_responses_bulk(assets, db, current_user.id)


@router.get("/assets/{asset_id}", response_model=AssetResponse)
def get_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)
    return _build_asset_response(asset, db, current_user.id)


@router.patch("/assets/{asset_id}", response_model=AssetResponse)
def update_asset(
    asset_id: uuid.UUID,
    body: AssetUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    if "status" in body.model_fields_set and body.status == AssetStatus.archived and not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can archive assets",
        )
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(asset, field, value)
    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db, current_user.id)


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    asset.deleted_at = datetime.now(timezone.utc)
    db.commit()


@router.get("/assets/{asset_id}/versions", response_model=list[AssetVersionResponse])
def list_asset_versions(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    versions = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).all()

    result = []
    version_ids = [v.id for v in versions]
    all_files = db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all() if version_ids else []
    files_by_version: dict = {}
    for f in all_files:
        files_by_version.setdefault(f.version_id, []).append(f)

    for v in versions:
        vr = AssetVersionResponse.model_validate(v)
        vr.files = [MediaFileResponse.model_validate(f) for f in files_by_version.get(v.id, [])]
        result.append(vr)
    return result


@router.get("/assets/{asset_id}/stream", response_model=StreamUrlResponse)
def get_stream_url(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    download: bool = Query(default=False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    # Get the requested version or latest
    if version_id:
        version = db.query(AssetVersion).filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).first()
    else:
        version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).order_by(AssetVersion.version_number.desc()).first()

    if not version:
        raise HTTPException(status_code=404, detail="No version found")
    if version.processing_status != ProcessingStatus.ready:
        raise HTTPException(status_code=409, detail="Asset version is not ready yet")

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Media file not found")

    if asset.asset_type == AssetType.video and media_file.s3_key_processed:
        if download:
            # For video downloads, use the raw file (original upload) so user gets a single file
            s3_key = media_file.s3_key_raw or media_file.s3_key_processed
            filename = build_download_filename(asset.name, media_file.original_filename or s3_key)
            url = proxy_url_for(s3_key, download_filename=filename)
        else:
            # Route through the media proxy so the master playlist, variant
            # playlists, and .ts segments are all served through this API
            # container — the S3/AIStor bucket never needs to be publicly
            # reachable. (#51)
            token = create_hls_token(media_file.s3_key_processed)
            url = f"/stream/hls/master.m3u8?token={token}"
    else:
        s3_key = media_file.s3_key_processed or media_file.s3_key_raw
        if download:
            filename = build_download_filename(asset.name, media_file.original_filename or s3_key)
            url = proxy_url_for(s3_key, download_filename=filename)
        else:
            url = proxy_url_for(s3_key)

    return StreamUrlResponse(url=url, asset_type=asset.asset_type)


@router.post("/assets/{asset_id}/versions", response_model=InitiateUploadResponse)
def initiate_new_version(
    asset_id: uuid.UUID,
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Initiate upload of a new version for an existing asset."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail="Unsupported file type")
    if body.file_size_bytes > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 10GB limit")

    last_version = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id,
        AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()
    next_version_number = (last_version.version_number + 1) if last_version else 1

    version = AssetVersion(
        asset_id=asset_id,
        version_number=next_version_number,
        processing_status=ProcessingStatus.uploading,
        created_by=current_user.id,
    )
    db.add(version)
    db.flush()

    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{asset.project_id}/{asset_id}/{version.id}/original{ext}"
    upload_id = create_multipart_upload(s3_key, body.mime_type)

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
        asset_id=asset_id,
        version_id=version.id,
    )


@router.patch("/assets/{asset_id}/assignment", response_model=AssetResponse)
def update_assignment(
    asset_id: uuid.UUID,
    body: AssignmentUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if "assignee_id" in body.model_fields_set:
        asset.assignee_id = body.assignee_id
    if "due_date" in body.model_fields_set:
        asset.due_date = body.due_date

    if "assignee_id" in body.model_fields_set and body.assignee_id is not None:
        notification = Notification(
            user_id=body.assignee_id,
            type=NotificationType.assignment,
            asset_id=asset.id,
        )
        db.add(notification)

    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db, current_user.id)


@router.get("/assets/{asset_id}/assignment")
def get_assignment(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.viewer)
    return {
        "assignee_id": str(asset.assignee_id) if asset.assignee_id else None,
        "due_date": asset.due_date.isoformat() if asset.due_date else None,
    }


# ── Votes ──────────────────────────────────────────────────────────────────────

@router.post("/assets/{asset_id}/vote", response_model=VoteToggleResponse)
def toggle_vote(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Toggle the current user's vote on an asset. Requires reviewer role or higher."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.reviewer)

    existing = db.query(Vote).filter(
        Vote.asset_id == asset_id,
        Vote.user_id == current_user.id,
    ).first()

    if existing:
        db.delete(existing)
        voted = False
    else:
        db.add(Vote(asset_id=asset_id, user_id=current_user.id))
        voted = True

    db.commit()
    vote_count = db.query(Vote).filter(Vote.asset_id == asset_id).count()
    return VoteToggleResponse(vote_count=vote_count, voted_by_me=voted)


@router.get("/assets/{asset_id}/votes")
def list_votes(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List who voted on an asset (name + avatar), newest first."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    votes = db.query(Vote).filter(Vote.asset_id == asset_id).order_by(Vote.created_at.desc()).all()
    user_ids = [v.user_id for v in votes]
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return [
        {
            "user_id": str(v.user_id),
            "name": users[v.user_id].name if v.user_id in users else "Unknown",
            "avatar_url": users[v.user_id].avatar_url if v.user_id in users else None,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v in votes
    ]
