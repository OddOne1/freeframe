from fastapi import APIRouter, Depends, HTTPException, status, Query, Response
from sqlalchemy.orm import Session
from sqlalchemy import func
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional
from ..database import get_db
from ..middleware.auth import get_current_user
from ..services.notification_prefs import should_create_notification, should_send_email
from ..models.user import User, UserGlobalRole
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, AssetStatus, FileType, ProcessingStatus, TranscriptionStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.share import AssetShare
from ..models.activity import Mention, Notification, NotificationType, AssetView
from ..models.vote import Vote
from ..schemas.asset import TranscriptionToggle, TranscriptionToggleResponse, AssetResponse, AssetVersionResponse, AssetUpdate, StreamUrlResponse, MediaFileResponse, VoteToggleResponse, VoteRequest, TranscriptResponse, TranscriptSegment, CheckExistingRequest, CheckExistingResponse
from ..schemas.notification import AssignmentUpdate
from ..services.permissions import require_project_role, require_asset_access, can_access_asset, is_public_project, get_project_member, can_see_rating_aggregate, can_manage_version
from ..services.s3_service import build_download_filename, get_s3_client
from ..config import settings
from .hls_proxy import create_hls_token, proxy_url_for
from ..services.owned_keys import issued_avatar_url
from ..schemas.upload import InitiateUploadRequest, InitiateUploadResponse, ALLOWED_MIME_TYPES, mime_to_asset_type
from ..services.upload_policy import plan_parts, UploadTooLarge
from ..services.s3_service import create_multipart_upload
from .folders import _get_descendant_ids as _get_descendant_folder_ids
from ..services.storage_prefix import lock_storage_prefix, prefix_for_project
from ..services.asset_versions import add_next_version, live_version, live_version_count
from ..services.asset_visibility import visible_assets
from ..services import zip_export_service as zx
from ..models.zip_export import ZipExport
from ..models.share import ALL_DOWNLOAD_VARIANTS
from ..schemas.share import ZipExportRequest, ZipExportStatusResponse, ZipExportOptionsResponse

router = APIRouter(tags=["assets"])

logger = logging.getLogger(__name__)

# A version stuck in "processing" gets a manual retry option once it's been
# running longer than this — long enough that a legitimately-running
# transcode of a large file is very unlikely to still be mid-flight, short
# enough that a genuinely stuck upload isn't stranded for hours. There's no
# per-job heartbeat yet to check against directly, so this elapsed-time
# check is a stand-in for "the Celery worker probably died mid-task".
STUCK_PROCESSING_THRESHOLD_SECONDS = 30 * 60

def _build_asset_response(asset: Asset, db: Session, current_user: User | None = None) -> AssetResponse:
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
    # §108 — unseen only ever means "there is a newer version than the one I
    # opened". A single-version asset can never be unseen, so a brand-new
    # upload does not badge itself for the person who just made it.
    if current_user is not None and latest_version is not None and latest_version.version_number > 1:
        seen = db.query(AssetView).filter(
            AssetView.user_id == current_user.id, AssetView.asset_id == asset.id,
        ).first()
        resp.has_unseen_version = (seen.last_seen_version_number if seen else 0) < latest_version.version_number
    resp.thumbnail_url = thumbnail_url
    avg_row = db.query(func.avg(Vote.stars), func.count(Vote.id)).filter(Vote.asset_id == asset.id).first()
    avg_rating = round(float(avg_row[0]), 2) if avg_row and avg_row[0] is not None else None
    rating_count = int(avg_row[1]) if avg_row else 0
    if current_user is not None:
        my_vote = db.query(Vote).filter(
            Vote.asset_id == asset.id, Vote.user_id == current_user.id,
        ).first()
        resp.my_rating = my_vote.stars if my_vote else None
        # Only owners/superadmins (or everyone, if the project opted in) see the
        # aggregate — everyone else only ever sees their own vote above.
        if can_see_rating_aggregate(db, asset.project_id, current_user):
            resp.avg_rating = avg_rating
            resp.rating_count = rating_count
        else:
            resp.avg_rating = None
            resp.rating_count = 0
    else:
        resp.my_rating = None
        resp.avg_rating = None
        resp.rating_count = 0
    return resp

def _build_asset_responses_bulk(assets: list[Asset], db: Session, current_user: User | None = None) -> list[AssetResponse]:
    """Build AssetResponse list with bulk-loaded versions and files (no N+1)."""
    if not assets:
        return []

    current_user_id = current_user.id if current_user is not None else None
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

    # §108 — one query for the whole batch, matching the bulk-load pattern
    # the rest of this function uses. A per-asset lookup here would be the
    # N+1 this builder exists to avoid.
    seen_by_asset: dict = {}
    if current_user_id is not None:
        for row in db.query(AssetView.asset_id, AssetView.last_seen_version_number).filter(
            AssetView.user_id == current_user_id, AssetView.asset_id.in_(asset_ids),
        ).all():
            seen_by_asset[row[0]] = row[1] or 0

    # Bulk load media files for all those versions
    version_ids = [v.id for v in latest_versions]
    all_files = db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all() if version_ids else []
    files_by_version: dict = {}
    for f in all_files:
        files_by_version.setdefault(f.version_id, []).append(f)

    # Bulk load rating aggregates + this user's rating
    rating_rows = (
        db.query(Vote.asset_id, func.avg(Vote.stars), func.count(Vote.id))
        .filter(Vote.asset_id.in_(asset_ids))
        .group_by(Vote.asset_id)
        .all()
    )
    avg_ratings: dict = {row[0]: (round(float(row[1]), 2) if row[1] is not None else None) for row in rating_rows}
    rating_counts: dict = {row[0]: int(row[2]) for row in rating_rows}

    my_ratings: dict = {}
    if current_user_id is not None:
        my_votes = db.query(Vote.asset_id, Vote.stars).filter(
            Vote.asset_id.in_(asset_ids),
            Vote.user_id == current_user_id,
        ).all()
        my_ratings = {row[0]: row[1] for row in my_votes}

    # Rating-visibility gating: this batch may span multiple projects (e.g. the
    # "my assets" feed), so bulk-fetch project settings + this user's
    # memberships for every distinct project represented, rather than querying
    # per asset. Mirrors can_see_rating_aggregate(): owner always, editor only
    # once the project has opted in, reviewer/viewer/non-members never.
    project_ids = list({a.project_id for a in assets})
    ratings_visible_by_project: dict = {}
    owner_project_ids: set = set()
    editor_project_ids: set = set()
    if current_user is not None and current_user.role != UserGlobalRole.superadmin and project_ids:
        for pid, visible in db.query(Project.id, Project.ratings_visible_to_all).filter(Project.id.in_(project_ids)).all():
            ratings_visible_by_project[pid] = visible
        member_rows = db.query(ProjectMember.project_id, ProjectMember.role).filter(
            ProjectMember.project_id.in_(project_ids),
            ProjectMember.user_id == current_user.id,
            ProjectMember.deleted_at.is_(None),
        ).all()
        owner_project_ids = {pid for pid, role in member_rows if role == ProjectRole.owner}
        editor_project_ids = {pid for pid, role in member_rows if role == ProjectRole.editor}

    def _can_see_aggregate(project_id: uuid.UUID) -> bool:
        if current_user is None:
            return False
        if current_user.role == UserGlobalRole.superadmin:
            return True
        if project_id in owner_project_ids:
            return True
        if project_id in editor_project_ids:
            return ratings_visible_by_project.get(project_id, False)
        return False

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
        if version is not None and version.version_number > 1:
            asset_resp.has_unseen_version = seen_by_asset.get(asset.id, 0) < version.version_number
        asset_resp.thumbnail_url = thumbnail_url
        if _can_see_aggregate(asset.project_id):
            asset_resp.avg_rating = avg_ratings.get(asset.id)
            asset_resp.rating_count = rating_counts.get(asset.id, 0)
        else:
            asset_resp.avg_rating = None
            asset_resp.rating_count = 0
        asset_resp.my_rating = my_ratings.get(asset.id)
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

    # Exclude assets whose only version is failed or still uploading. The rule
    # itself lives in services/asset_visibility.py so the share endpoint and
    # the folder counts enforce exactly this one, rather than three drifting
    # copies of it.
    assets = visible_assets(query, include_failed=include_failed).all()

    return _build_asset_responses_bulk(assets, db, current_user)

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
    return _build_asset_response(asset, db, current_user)

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
    if "status" in body.model_fields_set and body.status == AssetStatus.archived and current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can archive assets",
        )
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(asset, field, value)
    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db, current_user)

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
            url = proxy_url_for(
                s3_key,
                # §217 — DOWNLOAD_LINK_HOURS (72), not proxy_url_for's
                # 24 h default. This is an ORIGINAL: at the owner's
                # sizes one is a multi-hour resumable transfer, and a
                # link that dies mid-download cannot be resumed at all.
                # Playback URLs below keep the 24 h default.
                expires_hours=settings.download_link_hours,
                download_filename=filename,
            )
        else:
            # Route through the media proxy so the master playlist, variant
            # playlists, and .ts segments are all served through this API
            # container — the S3/AIStor bucket never needs to be publicly
            # reachable. (#51)
            token = create_hls_token(media_file.s3_key_processed)
            url = f"/stream/hls/master.m3u8?token={token}"
    else:
        if download:
            # §141 — mirror the video branch: a download is the ORIGINAL file.
            # `s3_key_processed` is a display derivative (WebP for an image,
            # mp3 for audio), so preferring it here handed the user a
            # re-encoded file under a filename claiming to be their upload.
            s3_key = media_file.s3_key_raw or media_file.s3_key_processed
            filename = build_download_filename(asset.name, media_file.original_filename or s3_key)
            url = proxy_url_for(
                s3_key,
                # §217 — DOWNLOAD_LINK_HOURS (72), not proxy_url_for's
                # 24 h default. This is an ORIGINAL: at the owner's
                # sizes one is a multi-hour resumable transfer, and a
                # link that dies mid-download cannot be resumed at all.
                # Playback URLs below keep the 24 h default.
                expires_hours=settings.download_link_hours,
                download_filename=filename,
            )
        else:
            # Viewing still prefers the processed derivative.
            s3_key = media_file.s3_key_processed or media_file.s3_key_raw
            url = proxy_url_for(s3_key)

    return StreamUrlResponse(url=url, asset_type=asset.asset_type)

# ── Batch (zip) downloads for the authenticated app (§143) ───────────────────

@router.post("/projects/{project_id}/zip/options", response_model=ZipExportOptionsResponse)
def get_project_zip_options(
    project_id: uuid.UUID,
    body: ZipExportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Which variants a bulk download may offer for this selection.

    A signed-in member is not gated by a share link's permission set, so
    every variant is permitted here and the narrowing is purely "does a
    stored object back it" — the same scope rule the share route applies.
    """
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=403, detail="Not a project member")

    pairs = []
    for item in body.items:
        asset = db.query(Asset).filter(Asset.id == item.asset_id, Asset.deleted_at.is_(None)).first()
        if not asset or asset.project_id != project_id:
            continue
        # §239 — `live_version`, so a client-supplied `version_id` naming a
        # DELETED version (a stale picker, a bookmarked selection) is
        # ignored rather than offered for download. It was an unqualified
        # lookup by id alone: not only deleted versions but versions of
        # OTHER assets resolved here, and the variant list returned was
        # then computed from that foreign file's stored derivatives. The
        # resolve path below (`_resolve_selection`) already got this right;
        # only this options route did not.
        version = (
            zx.latest_ready_version(db, asset.id)
            if not item.version_id
            else live_version(db, asset.id, item.version_id)
        )
        if not version:
            continue
        mf = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if mf:
            pairs.append((asset, mf))
    from ..schemas.share import ZipExportAssetOptions, ZipExportVersionOption

    assets_out = []
    for asset, _mf in pairs:
        # A signed-in member already sees the version switcher in the app,
        # so there is no equivalent of a link's show_versions gate here.
        versions = zx.selectable_versions(db, asset.id, allowed=True)
        assets_out.append(ZipExportAssetOptions(
            asset_id=asset.id, asset_name=asset.name,
            versions=[
                ZipExportVersionOption(
                    version_id=v.id, version_number=v.version_number,
                    created_at=v.created_at, is_latest=(i == 0),
                )
                for i, v in enumerate(versions)
            ],
        ))
    return ZipExportOptionsResponse(
        variants=zx.batch_variant_options(ALL_DOWNLOAD_VARIANTS, pairs), assets=assets_out
    )


@router.post("/projects/{project_id}/zip", response_model=ZipExportStatusResponse)
def request_project_zip(
    project_id: uuid.UUID,
    body: ZipExportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Start (or reuse) a zip of several files for a signed-in member.

    Same popup-spam fix as the share viewer: one download instead of N
    iframe-triggered ones.
    """
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=403, detail="Not a project member")
    if not body.items:
        raise HTTPException(status_code=400, detail="Nothing selected")

    from .share import _resolve_zip_selection, _start_or_reuse_zip, _zip_status_payload

    # Access was checked at the project level above; `link=None` tells the
    # shared resolver to skip the share-membership check rather than
    # inventing a second one.
    resolved, plan = _resolve_zip_selection(
        db,
        items=[i for i in body.items],
        variant=body.variant,
        link=None,
        root_folder_id=None,
        allowed_variants=ALL_DOWNLOAD_VARIANTS,
    )
    plan = [
        e for e in plan
        if db.query(Asset).filter(Asset.id == e["asset_id"]).first().project_id == project_id
    ]
    if not plan:
        raise HTTPException(status_code=400, detail="None of these files are available to download")

    export, reused = _start_or_reuse_zip(
        db,
        plan=plan,
        resolved=resolved,
        scope_kind="user",
        scope_id=current_user.id,
        project_id=project_id,
        share_link_id=None,
        created_by=current_user.id,
        scope=body.scope,
        folder_name=body.folder_name,
    )
    return _zip_status_payload(db, export, reused=reused)


@router.get("/projects/{project_id}/zip/{export_id}", response_model=ZipExportStatusResponse)
def get_project_zip_status(
    project_id: uuid.UUID,
    export_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=403, detail="Not a project member")

    from .share import _advance_preparation, _resolve_if_stale, _zip_status_payload

    export = db.query(ZipExport).filter(ZipExport.id == export_id).first()
    # Scoped to the requester, not just the project: another member's
    # archive may contain a selection this user never made.
    if not export or export.project_id != project_id or export.created_by != current_user.id:
        raise HTTPException(status_code=404, detail="Export not found")
    _resolve_if_stale(db, export)
    # §217 — same as the share poll: this is where the freeze advances.
    _advance_preparation(db, export)
    return _zip_status_payload(db, export)


@router.get("/assets/{asset_id}/transcript", response_model=TranscriptResponse)
def get_asset_transcript(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Transcript + captions URL for one asset version.

    Deliberately does NOT 409 on a not-yet-ready version the way
    get_stream_url does: transcription is a separate stage that outlives
    readiness in both directions, and the panel needs to render its
    "Transcribing…" / "not available" states from a successful response
    rather than from an error.

    transcript.json is read server-side and returned parsed, so the client
    needs one request instead of a second token-authenticated fetch of a
    file it would only have to parse itself anyway.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

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

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Media file not found")

    response = TranscriptResponse(
        transcription_status=media_file.transcription_status,
        transcription_progress=media_file.transcription_progress,
        transcription_enabled=asset.transcription_enabled,
        language=media_file.transcript_language,
    )
    if media_file.transcription_status != TranscriptionStatus.ready:
        return response

    if media_file.s3_key_captions:
        response.captions_url = proxy_url_for(media_file.s3_key_captions)

    if media_file.s3_key_transcript:
        try:
            s3 = get_s3_client()
            obj = s3.get_object(Bucket=settings.s3_bucket, Key=media_file.s3_key_transcript)
            data = json.loads(obj["Body"].read().decode("utf-8"))
            response.text = data.get("text") or ""
            response.segments = [
                TranscriptSegment(
                    id=int(seg.get("id", i)),
                    start=float(seg.get("start", 0.0)),
                    end=float(seg.get("end", 0.0)),
                    text=(seg.get("text") or "").strip(),
                )
                for i, seg in enumerate(data.get("segments") or [])
            ]
        except Exception:
            # The row says ready but the object is unreadable/missing. Return
            # the status and captions URL rather than 500ing the whole panel.
            logger.warning(
                "Could not read transcript %s for asset %s",
                media_file.s3_key_transcript, asset_id, exc_info=True,
            )

    return response


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

    # §213 — ONE part-size policy, shared with POST /upload/initiate rather
    # than copied. This endpoint's own check used to refuse above 2000 GB
    # while its message said "10GB limit" — two different wrong numbers in
    # five lines, which is what a second copy of a policy buys.
    #
    # Before any row is written below — the prefix lock, the version
    # insert — so a refusal leaves no version row.
    try:
        plan = plan_parts(body.file_size_bytes)
    except UploadTooLarge as e:
        raise HTTPException(status_code=413, detail=e.detail)

    # ── Freeze the project's storage prefix (§14), in its OWN transaction ──
    #
    # Same lock-at-initiation as the new-asset path in upload.py — a
    # project whose first upload predates §14 locks here instead, which is
    # exactly how one project ends up holding both key formats — but §236b
    # moved it AHEAD of the version insert and gave it its own commit, to
    # match `initiate_upload`.
    #
    # Two reasons, and only the second one is new here:
    #
    #  * §27's KEY SHARE deadlock does NOT apply to this endpoint. That
    #    deadlock needs an INSERT carrying a foreign key to `projects`
    #    (which takes KEY SHARE on the project row) racing a `FOR UPDATE`
    #    on the same row. This endpoint inserts an `asset_versions` row
    #    (FK -> assets) and a `media_files` row (FK -> asset_versions);
    #    neither references `projects`, so there is no KEY SHARE to
    #    deadlock against. That half of §27 is why the old order survived.
    #
    #  * The LATENCY half of §27 does apply, and that is the reason for the
    #    move. Held to the end of the request, this `FOR UPDATE` on the
    #    project row spans the S3 CreateMultipartUpload below — so new
    #    versions of DIFFERENT files in one project serialised behind one
    #    S3 round trip each, as did any `/upload/initiate` in that project
    #    (its own prefix lock conflicts, and so does the KEY SHARE its
    #    asset insert takes). Measured with a 0.2s stubbed S3: four
    #    concurrent new-version uploads took 0.87s before this and 0.2s
    #    after. See tests/test_asset_version_numbers.py.
    #
    # Committing here is safe for the same reason it is in upload.py:
    # everything above is a read, so nothing else is pending, and a prefix
    # locked for an upload that later fails costs nothing — it is a naming
    # decision, and `lock_storage_prefix` is idempotent.
    #
    # It also has to come first for a second reason: the retry inside
    # `add_next_version` rolls the transaction back, which would discard a
    # prefix lock left pending here.
    project = lock_storage_prefix(db, asset.project_id)
    db.commit()

    # §236b — the asset row, LOCKED, re-read after that commit (a commit
    # releases the lock, so it cannot be taken before it) and BEFORE the
    # version number is computed.
    #
    # The number is `max(version_number) + 1` over all of this asset's
    # rows, and `AssetVersion` has a unique constraint on
    # (asset_id, version_number) spanning every row including soft-deleted
    # ones. Two requests that read it at the same time pick the same number
    # and one of them dies on the insert with an IntegrityError — a 500
    # after the user has already picked a file. `POST /upload/initiate`
    # takes this same lock on this same row (§236), which is what makes the
    # two endpoints serialise against each other rather than only against
    # themselves.
    #
    # Holding it across the `create_multipart_upload` round trip below is
    # deliberate and is NOT what §27 warns about: that was the PROJECT row,
    # shared by every upload in a batch. This is ONE asset, and the only
    # requests that contend for it are two new versions of the same file at
    # the same moment — precisely the pair that must be serialised.
    #
    # Re-read rather than reused: the 404 above ran before the commit, so
    # the asset could have been deleted in the gap. Same 404 as above for
    # that, which is also what `initiate_upload` answers.
    asset = (
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.deleted_at.is_(None))
        .with_for_update()
        .first()
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    # §236b — SHARED with `/upload/initiate`, not copied. See
    # services/asset_versions.py: `max()` over all rows so a deleted
    # version's number is retired rather than reused, under this lock, with
    # one retry that turns a collision into a 409 instead of a 500.
    version = add_next_version(db, asset, current_user, locked=True)

    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{prefix_for_project(project)}/{asset_id}/{version.id}/original{ext}"
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
        part_size=plan.part_size,
        total_parts=plan.total_parts,
    )

@router.patch("/assets/{asset_id}/transcription", response_model=TranscriptionToggleResponse)
def set_asset_transcription(
    asset_id: uuid.UUID,
    body: TranscriptionToggle,
    version_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Turn transcription on or off for one file (§127).

    The toggle is INTENT -- "should this file end up transcribed" -- not a
    trigger. Turning it on for something already transcribed does nothing;
    turning it on for something with no transcript starts one; turning it off
    stops a run in flight and declines future ones.

    Cancellation is done here rather than left to the task, and that is the
    load-bearing decision. `revoke(terminate=True)` may kill the worker child
    mid-call, so the task's own except/finally is not guaranteed to run --
    exactly the shape that leaves a row stuck at `processing` forever, which
    this codebase has been bitten by twice. So the caller writes the terminal
    state itself, BEFORE the signal, and the task is written to be safe to
    lose at any point.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if asset.asset_type not in (AssetType.video, AssetType.audio):
        raise HTTPException(status_code=400, detail="Only video and audio can be transcribed")

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

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Media file not found")

    asset.transcription_enabled = body.enabled
    cancelled = False
    started = False

    if not body.enabled:
        task_id = media_file.transcription_task_id
        if media_file.transcription_status == TranscriptionStatus.processing or task_id:
            # Terminal state FIRST. If the revoke kills the worker child
            # before its handler runs -- which is the point of terminate --
            # nothing else will ever write this row.
            media_file.transcription_status = TranscriptionStatus.not_started
            media_file.transcription_progress = None
            media_file.transcription_task_id = None
            cancelled = True
        db.commit()

        if task_id:
            try:
                from ..tasks.celery_app import celery_app
                # terminate=True for a run already in flight; the revoked set
                # covers one still queued. Both matter: concurrency is 1 on
                # this worker, so a queued task can sit for a long time.
                celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")
            except Exception:
                # The state is already correct. A broker that will not carry
                # the revoke leaves a task that finds the toggle off when it
                # starts and stops by itself.
                logger.warning("Could not revoke transcription task %s", task_id, exc_info=True)
    else:
        db.commit()
        # Only start something if there is nothing to show and nothing running.
        if media_file.transcription_status in (
            TranscriptionStatus.not_started,
            TranscriptionStatus.failed,
        ):
            from ..tasks.transcribe_tasks import transcribe_asset
            result = transcribe_asset.delay(str(asset_id), str(version.id))
            media_file.transcription_task_id = result.id
            media_file.transcription_status = TranscriptionStatus.processing
            media_file.transcription_progress = 0
            db.commit()
            started = True

    db.refresh(media_file)
    return TranscriptionToggleResponse(
        enabled=asset.transcription_enabled,
        transcription_status=media_file.transcription_status,
        cancelled=cancelled,
        started=started,
    )


@router.post("/assets/{asset_id}/versions/{version_id}/retry-processing", response_model=AssetVersionResponse)
def retry_version_processing(
    asset_id: uuid.UUID,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Manually re-dispatch transcoding for a version that ended in 'failed',
    or one stuck in 'processing' because the Celery worker died mid-task
    (there's no automatic detection or requeue for that today).

    Restricted to the person who uploaded this version, the project owner,
    or a superadmin — not editors/reviewers in general, since this dispatches
    a real transcode job.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    version = live_version(db, asset_id, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    # §239 — the rule itself moved to services/permissions.py unchanged,
    # so this route and `delete_asset_version` below cannot drift apart
    # about who "the uploader, the project owner, or an admin" is. The
    # message stays this route's own.
    if not can_manage_version(db, asset, version, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the uploader, the project owner, or an admin can restart processing",
        )

    if version.processing_status == ProcessingStatus.processing:
        # Guard against dispatching a second, concurrent transcode job for a
        # version that's still legitimately running — both jobs would write
        # to the same deterministic S3 output prefix. See
        # STUCK_PROCESSING_THRESHOLD_SECONDS above.
        elapsed = datetime.now(timezone.utc) - version.created_at
        if elapsed.total_seconds() < STUCK_PROCESSING_THRESHOLD_SECONDS:
            raise HTTPException(
                status_code=409,
                detail="Still within the normal processing window — wait a bit longer before retrying.",
            )
    elif version.processing_status != ProcessingStatus.failed:
        raise HTTPException(status_code=409, detail="Only failed or stuck-processing versions can be retried")

    version.processing_status = ProcessingStatus.processing
    # §219 — cleared, for the same reason the upload path clears it: this is
    # a re-DISPATCH. Leaving the previous attempt's start time in place would
    # hand the sweeper a row that claims to have started hours ago and has
    # been silent ever since, and it would be failed almost immediately --
    # while its replacement task sat perfectly healthily in the queue.
    version.processing_started_at = None
    db.commit()
    db.refresh(version)

    from ..tasks.transcode_tasks import process_asset
    from ..tasks.celery_app import send_task_safe
    send_task_safe(process_asset, str(asset_id), str(version_id))

    files = db.query(MediaFile).filter(MediaFile.version_id == version.id).all()
    vr = AssetVersionResponse.model_validate(version)
    vr.files = [MediaFileResponse.model_validate(f) for f in files]
    return vr


@router.delete("/assets/{asset_id}/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_asset_version(
    asset_id: uuid.UUID,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove ONE version of an asset, keeping the asset and the rest of
    its review history (§239).

    SOFT delete only: `deleted_at` is stamped and not one byte is touched
    in the bucket. Everything hanging off this version — its comments,
    their annotations and attachments, its approvals, its media rows —
    stays in the database untouched and becomes unreachable with the
    version, because every read of those goes through a live version. The
    version's bytes stop counting toward every storage figure immediately
    (services/storage_usage.py); reclaiming them in the bucket is a
    separate, later step, and nothing purges them today — see
    scripts/report_trash_backlog.py.

    `version_number` is NOT recycled. §236b retired it on purpose: the
    unique constraint spans soft-deleted rows, and "v3" in a comment has
    to keep meaning the same upload after v2 is deleted.

    ── Order of the checks, which is the whole security of this route ──
    404s first, permission second, state third. Mirrors
    `retry-processing` above: an editor with no right to this version gets
    the same "Version not found" for a version of a foreign asset as for
    one that does not exist, and only someone who may act on it learns
    which. The state 409s come last because they describe a version the
    caller has already been shown to be allowed to see.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    version = live_version(db, asset_id, version_id)
    if not version:
        # Same answer for unknown, foreign, and already-deleted. Deleting
        # twice is therefore a 404, not a 204: this route is NOT
        # idempotent, and deliberately so — a second 204 would be an
        # oracle telling a caller that an id it may not see exists.
        raise HTTPException(status_code=404, detail="Version not found")

    # §239 — the SAME rule `retry-processing` uses, from
    # services/permissions.py rather than written a second time here.
    if not can_manage_version(db, asset, version, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the uploader, the project owner, or an admin can delete a version",
        )

    # ── The asset row, LOCKED — the same lock the two new-version
    # endpoints take (§236/§236b, services/asset_versions.py) ──
    #
    # It is what makes this delete serialise against a new version of the
    # same file and against another delete. Two things below need it:
    #
    #  * the "is this the last live version" count. Unlocked, two
    #    concurrent deletes of the last two versions both read 2, both
    #    pass, and the asset is left with no version at all — live in
    #    every listing, unplayable, and `usable_asset_filter`'s
    #    "no versions yet" branch would even keep showing it.
    #  * the version's own state. Re-read under the lock so two concurrent
    #    deletes of the SAME version give one 204 and one 404 rather than
    #    two 204s and two audit trails of one deletion.
    #
    # Same row, same order as the version-creation path, so there is no
    # lock-ordering cycle to deadlock on.
    locked = (
        db.query(Asset)
        .filter(Asset.id == asset_id, Asset.deleted_at.is_(None))
        .with_for_update()
        .first()
    )
    if not locked:
        # The asset was deleted out from under us while we waited.
        raise HTTPException(status_code=404, detail="Asset not found")

    version = live_version(db, asset_id, version_id)
    if not version:
        raise HTTPException(status_code=404, detail="Version not found")

    if version.processing_status in (ProcessingStatus.uploading, ProcessingStatus.processing):
        # An in-flight version has a writer that does not know about this
        # row: the browser is still PUTting parts at S3, or a transcode
        # task is still writing derivatives and will commit a status onto
        # this row when it finishes. Deleting underneath either leaves a
        # half-written object nothing points at, or a task that resurrects
        # a status on a deleted row.
        #
        # So the user aborts or restarts first, and this answers with a
        # code the web branches on rather than prose it would have to
        # match on.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "version_in_flight",
                "message": (
                    "This version is still uploading or processing. "
                    "Cancel or restart it first, then delete it."
                ),
            },
        )

    live_count = live_version_count(db, asset_id)
    if live_count <= 1:
        # The last live version. An asset with none would still be listed
        # (see usable_asset_filter) with nothing to play, so this is the
        # one case where the answer is "delete the asset instead" — which
        # is what the client says when it sees this code.
        raise HTTPException(
            status_code=409,
            detail={
                "code": "last_version",
                "message": (
                    "This is the only version of this file. Delete the asset "
                    "instead if you want to remove it."
                ),
            },
        )

    version.deleted_at = datetime.now(timezone.utc)
    db.commit()

    # No ActivityLog row, matching `delete_asset` above, which writes none
    # either — and `ActivityAction` has no member for a deletion, so an
    # audit row here would mean inventing a log type for one route. A log
    # line instead, which is what the sweeper and the purge do for the
    # same kind of event.
    # `live_count - 1` rather than a second count query: one read of that
    # number per request, taken under the lock, is also what lets a test
    # pin two concurrent deletes to the same instant by intercepting it.
    logger.warning(
        "Version %s (v%s) of asset %s soft-deleted by user %s; %d live version(s) remain",
        version.id, version.version_number, asset_id, current_user.id,
        live_count - 1,
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
        # §108 — "Assigned to You". No email exists on this path today
        # (send_assignment_email is defined but has never had a caller), so
        # only the in-app row is gated here.
        assignee = db.query(User).filter(User.id == body.assignee_id).first()
        if should_create_notification(assignee, "assigned_to_you"):
            db.add(Notification(
                user_id=body.assignee_id,
                type=NotificationType.assignment,
                asset_id=asset.id,
            ))

    db.commit()
    db.refresh(asset)
    return _build_asset_response(asset, db, current_user)

@router.post("/assets/{asset_id}/seen", status_code=204)
def mark_asset_seen(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Record that this user has opened this asset's latest version (§108).

    Called when the review view opens, not on hover or thumbnail load — the
    badge claims "you have not looked at this", and a grid scroll is not
    looking at it.

    Idempotent, and deliberately upsert-by-hand rather than ON CONFLICT: the
    unique constraint is what guarantees one row per pair, and re-opening the
    same version must not accumulate rows or move the version number
    backwards if an older version is opened directly.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    latest = db.query(AssetVersion).filter(
        AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None),
    ).order_by(AssetVersion.version_number.desc()).first()
    if not latest:
        return Response(status_code=204)

    view = db.query(AssetView).filter(
        AssetView.user_id == current_user.id, AssetView.asset_id == asset_id,
    ).first()
    if view is None:
        db.add(AssetView(
            user_id=current_user.id,
            asset_id=asset_id,
            last_seen_version_id=latest.id,
            last_seen_version_number=latest.version_number,
        ))
    elif (view.last_seen_version_number or 0) < latest.version_number:
        # Only ever forwards. Opening an older version from the switcher is
        # not "unseeing" the newest one.
        view.last_seen_version_id = latest.id
        view.last_seen_version_number = latest.version_number
        view.last_seen_at = func.now()
    db.commit()
    return Response(status_code=204)


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

@router.post("/assets/check-existing", response_model=CheckExistingResponse)
def check_existing_assets(
    body: CheckExistingRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Which of these asset ids still exist and are visible to the caller.

    §97A — the desktop app asks this once when resuming an upload job that
    died mid-flight, with every asset id its journal recorded as uploaded.
    Anything it does not get back gets re-uploaded.

    Deliberately answers with the SURVIVORS rather than the missing, so the
    caller's default on any surprise is to do the work again: an unknown
    id, a deleted one, and one belonging to someone else are all simply
    absent, and none of them can be mistaken for permission to skip a file.

    Access is filtered per asset rather than assumed from the ids, or this
    would answer "does this uuid exist" for the whole install.
    """
    if not body.asset_ids:
        return CheckExistingResponse(existing_ids=[])

    # Deduplicated before the query: a journal with repeated ids should not
    # turn into a longer IN list.
    wanted = list({aid for aid in body.asset_ids})

    rows = db.query(Asset).filter(
        Asset.id.in_(wanted),
        Asset.deleted_at.is_(None),
    ).all()

    return CheckExistingResponse(
        existing_ids=[a.id for a in rows if can_access_asset(db, a, current_user)],
    )


@router.post("/assets/{asset_id}/vote", response_model=VoteToggleResponse)
def rate_asset(
    asset_id: uuid.UUID,
    body: VoteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set (or clear, if resubmitting the same value) the current user's star rating on an asset."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.reviewer)

    existing = db.query(Vote).filter(
        Vote.asset_id == asset_id,
        Vote.user_id == current_user.id,
    ).first()

    my_rating: int | None
    if existing and existing.stars == body.stars:
        db.delete(existing)
        my_rating = None
    elif existing:
        existing.stars = body.stars
        my_rating = body.stars
    else:
        db.add(Vote(asset_id=asset_id, user_id=current_user.id, stars=body.stars))
        my_rating = body.stars

    db.commit()
    avg_row = db.query(func.avg(Vote.stars), func.count(Vote.id)).filter(Vote.asset_id == asset_id).first()
    avg_rating = round(float(avg_row[0]), 2) if avg_row and avg_row[0] is not None else None
    rating_count = int(avg_row[1]) if avg_row else 0
    if not can_see_rating_aggregate(db, asset.project_id, current_user):
        avg_rating = None
        rating_count = 0
    return VoteToggleResponse(avg_rating=avg_rating, rating_count=rating_count, my_rating=my_rating)

@router.get("/assets/{asset_id}/votes")
def list_votes(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List who voted on an asset (name + avatar + stars), newest first.

    Only owners/superadmins (or editors, if the project opted in) get the
    full breakdown — reviewers, viewers, and non-opted-in editors get an
    empty list, matching the nulled-out avg_rating/rating_count they see on
    the asset itself.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    if not can_see_rating_aggregate(db, asset.project_id, current_user):
        return []

    votes = db.query(Vote).filter(Vote.asset_id == asset_id).order_by(Vote.created_at.desc()).all()
    user_ids = [v.user_id for v in votes]
    users = {u.id: u for u in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}
    return [
        {
            "user_id": str(v.user_id),
            "name": users[v.user_id].name if v.user_id in users else "Unknown",
            # §235 — this list is a hand-built dict, not a schema, so it
            # does not inherit UserResponse's validator. Same rule applied
            # by hand: only an avatar URL this server minted is shown.
            "avatar_url": issued_avatar_url(users[v.user_id].avatar_url) if v.user_id in users else None,
            "stars": v.stars,
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v in votes
    ]
