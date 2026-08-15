"""Sidecar upload, filename matching, and retrieval.

Two entry points, both needed (spec, 2026-07-30):

1. Bulk: the web uploader recognizes sidecar extensions in a dropped folder
   and posts them to /projects/{id}/sidecars/match, which resolves the
   target asset by filename.
2. Explicit: /assets/{id}/sidecars attaches one directly, for a CDL that
   arrives after the footage.

No-match is a clear 404, never a silent discard or an "unassociated" holding
state — the user can re-upload once the clip exists.
"""

import logging
import os
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.project import Project, ProjectRole
from ..models.sidecar import SidecarFile, SidecarType
from ..schemas.sidecar import SidecarResponse
from ..services import s3_service
from ..services.permissions import require_project_role, require_asset_access
from ..services.storage_prefix import prefix_for_project
from ..services.sidecar_parsers import (
    BINARY_SIDECAR_TYPES,
    SIDECAR_EXTENSIONS,
    SidecarParseError,
    detect_sidecar_type,
    parse_sidecar,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["sidecars"])

# Sidecars are small text files; anything larger is a mistaken upload.
MAX_SIDECAR_BYTES = 5 * 1024 * 1024
# Except DJI telemetry, which is one SubRip block per frame — a half-hour
# flight legitimately runs past 5MB. Safe to allow, because parse_dji_srt
# downsamples to a fixed number of stored samples, so what lands in JSONB is
# bounded no matter how long the flight was.
MAX_SIDECAR_BYTES_BY_TYPE = {"dji_srt": 25 * 1024 * 1024}


def _basename_no_ext(filename: str) -> str:
    base = os.path.basename((filename or "").replace("\\", "/"))
    return os.path.splitext(base)[0]


def _to_response(row: SidecarFile) -> SidecarResponse:
    return SidecarResponse(
        id=row.id,
        asset_id=row.asset_id,
        sidecar_type=row.sidecar_type,
        original_filename=row.original_filename,
        parsed_metadata=row.parsed_metadata or {},
        created_at=row.created_at,
    )


def _find_asset_by_filename(db: Session, project_id: uuid.UUID, stem: str) -> Optional[Asset]:
    """Match a sidecar stem against assets in one project.

    Compares against the media file's original_filename (also stripped of
    extension, case-insensitive), falling back to the asset's display name —
    a clip renamed in the UI should still match its CDL.
    """
    target = stem.lower()

    rows = db.query(Asset, MediaFile).join(
        AssetVersion, AssetVersion.asset_id == Asset.id
    ).join(
        MediaFile, MediaFile.version_id == AssetVersion.id
    ).filter(
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
        AssetVersion.deleted_at.is_(None),
    ).all()

    for asset, media_file in rows:
        if _basename_no_ext(media_file.original_filename or "").lower() == target:
            return asset

    return db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
        func.lower(Asset.name) == target,
    ).first()


async def _store_sidecar(
    db: Session,
    asset: Asset,
    file: UploadFile,
    current_user: User,
) -> SidecarFile:
    body = await file.read()

    filename = file.filename or "sidecar"
    sidecar_type = detect_sidecar_type(filename)
    if not sidecar_type:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported sidecar type — expected one of {', '.join(sorted(SIDECAR_EXTENSIONS))}",
        )

    max_bytes = MAX_SIDECAR_BYTES_BY_TYPE.get(sidecar_type, MAX_SIDECAR_BYTES)
    if len(body) > max_bytes:
        raise HTTPException(
            status_code=400,
            detail=f"Sidecar file too large (max {max_bytes // (1024 * 1024)}MB)",
        )

    try:
        # Raw bytes, not decoded text: .CPI/.BIM/.CIF/.NKSC are binary, and a
        # UTF-8 decode here would reject them before their parser ever ran.
        # The text formats decode inside their own parser instead.
        parsed = parse_sidecar(sidecar_type, body, clip_name=filename)
    except SidecarParseError as exc:
        # Surfaced, not swallowed: storing an unparsed sidecar would look
        # like success and then display nothing.
        raise HTTPException(status_code=400, detail=str(exc))

    # Reads the project's frozen prefix rather than re-deriving it: by the
    # time a sidecar can be attached, the asset exists, so the project's
    # first upload has already locked this (§14).
    project = db.query(Project).filter(Project.id == asset.project_id).first()
    key = f"sidecars/{prefix_for_project(project)}/{asset.id}/{uuid.uuid4()}_{os.path.basename(filename)}"
    content_type = (
        "application/octet-stream" if sidecar_type in BINARY_SIDECAR_TYPES else "text/plain"
    )
    s3_service.put_object(key, body, content_type=content_type, cache_control="max-age=86400")

    row = SidecarFile(
        asset_id=asset.id,
        sidecar_type=SidecarType(sidecar_type),
        original_filename=filename,
        s3_key=key,
        parsed_metadata=parsed,
        uploaded_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post(
    "/assets/{asset_id}/sidecars",
    response_model=SidecarResponse,
    status_code=status.HTTP_201_CREATED,
)
async def attach_sidecar(
    asset_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Attach a sidecar directly to a known asset (the explicit fallback path)."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    return _to_response(await _store_sidecar(db, asset, file, current_user))


@router.post(
    "/projects/{project_id}/sidecars/match",
    response_model=SidecarResponse,
    status_code=status.HTTP_201_CREATED,
)
async def match_sidecar(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Resolve a sidecar to an asset by filename, then attach it.

    This is what the bulk uploader calls when a dropped folder contains both
    a clip and its CDL/ALE.
    """
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    stem = _basename_no_ext(file.filename or "")
    if not stem:
        raise HTTPException(status_code=400, detail="Sidecar filename is empty")

    asset = _find_asset_by_filename(db, project_id, stem)
    if not asset:
        raise HTTPException(
            status_code=404,
            detail=f'No clip named "{stem}" found in this project. Upload the footage first, then attach the sidecar.',
        )

    return _to_response(await _store_sidecar(db, asset, file, current_user))


@router.get("/assets/{asset_id}/sidecars", response_model=list[SidecarResponse])
def list_sidecars(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    rows = db.query(SidecarFile).filter(
        SidecarFile.asset_id == asset_id,
        SidecarFile.deleted_at.is_(None),
    ).order_by(SidecarFile.created_at.desc()).all()
    return [_to_response(r) for r in rows]


@router.delete("/sidecars/{sidecar_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sidecar(
    sidecar_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = db.query(SidecarFile).filter(
        SidecarFile.id == sidecar_id,
        SidecarFile.deleted_at.is_(None),
    ).first()
    if not row:
        raise HTTPException(status_code=404, detail="Sidecar not found")

    asset = db.query(Asset).filter(Asset.id == row.asset_id).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    from datetime import datetime, timezone
    row.deleted_at = datetime.now(timezone.utc)
    db.commit()
