"""Personal LUT libraries, project sharing, and graded exports.

Ownership model (user decision 2026-07-30): a LUT belongs to the user who
uploaded it and follows them everywhere; separately it can be shared into a
specific project so that team can use it. Two consequences run through this
whole file:

- Listing a project's LUTs returns the union of *your* library and
  everything shared into that project — not just the shared set.
- Previewing a LUT locally never requires a share, but setting it as the
  asset's grade for the whole team does. Otherwise a teammate would see a
  reference to a personal LUT they cannot read.
"""

import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType
from ..models.lut import Lut, ProjectLutShare
from ..models.project import ProjectRole
from ..schemas.asset import StreamUrlResponse
from ..schemas.lut import LutResponse, LutExportResponse, ApplyLutRequest
from ..services import s3_service
from ..services.permissions import require_project_role, require_asset_access
from .hls_proxy import proxy_url_for

router = APIRouter(tags=["luts"])

# A .cube is plain text: `LUT_3D_SIZE N` then N^3 float triples. Size 64 is
# already ~1MB of text; anything past that is far outside normal use and is
# far more likely to be a mis-uploaded file than a real LUT.
MAX_CUBE_BYTES = 8 * 1024 * 1024
MAX_LUT_SIZE = 64


def _parse_cube_size(text: str) -> int:
    """Pull LUT_3D_SIZE out of a .cube header, validating the file is
    actually a 3D LUT while we're here.

    Deliberately strict: silently accepting a file that isn't a .cube would
    surface later as a preview that renders wrong rather than an upload that
    failed, and wrong-but-plausible color is the exact failure mode this
    feature must not have.
    """
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0].upper() == "LUT_3D_SIZE":
            try:
                size = int(parts[1])
            except (IndexError, ValueError):
                raise HTTPException(status_code=400, detail="Malformed LUT_3D_SIZE in .cube file")
            if size < 2 or size > MAX_LUT_SIZE:
                raise HTTPException(
                    status_code=400,
                    detail=f"LUT_3D_SIZE must be between 2 and {MAX_LUT_SIZE} (got {size})",
                )
            return size
        if parts[0].upper() == "LUT_1D_SIZE":
            raise HTTPException(
                status_code=400,
                detail="1D LUTs are not supported — upload a 3D .cube file",
            )
    raise HTTPException(status_code=400, detail="No LUT_3D_SIZE found — is this a .cube file?")


def _to_response(
    lut: Lut,
    current_user: User,
    owner_name: Optional[str] = None,
    shared_with_project: Optional[bool] = None,
) -> LutResponse:
    return LutResponse(
        id=lut.id,
        name=lut.name,
        lut_size=lut.lut_size,
        created_at=lut.created_at,
        is_owner=lut.owner_id == current_user.id,
        owner_name=owner_name,
        # 5 years: the browser refetches this on every picker open, but a
        # short expiry would break a long editing session mid-preview.
        file_url=proxy_url_for(lut.s3_key, expires_hours=24 * 365 * 5),
        shared_with_project=shared_with_project,
    )


def _get_own_lut(db: Session, lut_id: uuid.UUID, current_user: User) -> Lut:
    lut = db.query(Lut).filter(
        Lut.id == lut_id,
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")
    return lut


# ─── Personal library ────────────────────────────────────────────────────────

@router.post("/me/luts", response_model=LutResponse, status_code=status.HTTP_201_CREATED)
async def upload_lut(
    file: UploadFile = File(...),
    name: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a .cube into the caller's personal library.

    Proxied through this container rather than a presigned browser->S3 PUT,
    for the same mixed-content reason as avatar/logo upload (see
    users.py::upload_avatar).
    """
    body = await file.read()
    if len(body) > MAX_CUBE_BYTES:
        raise HTTPException(status_code=400, detail="LUT file too large (max 8MB)")
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="LUT file must be UTF-8 text")

    lut_size = _parse_cube_size(text)

    display_name = (name or file.filename or "Untitled LUT").strip()
    if display_name.lower().endswith(".cube"):
        display_name = display_name[: -len(".cube")]
    display_name = display_name[:255] or "Untitled LUT"

    key = f"luts/{current_user.id}/{uuid.uuid4()}.cube"
    s3_service.put_object(key, body, content_type="text/plain", cache_control="max-age=86400")

    lut = Lut(owner_id=current_user.id, name=display_name, s3_key=key, lut_size=lut_size)
    db.add(lut)
    db.commit()
    db.refresh(lut)
    return _to_response(lut, current_user)


@router.get("/me/luts", response_model=list[LutResponse])
def list_own_luts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    luts = db.query(Lut).filter(
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).order_by(Lut.created_at.desc()).all()
    return [_to_response(lut, current_user) for lut in luts]


@router.delete("/me/luts/{lut_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lut(
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete, owner only.

    The ProjectLutShare rows are hard-deleted alongside: leaving them would
    keep a deleted LUT listed in every project it was shared into. Assets
    referencing it fall back to no grade via the FK's ON DELETE SET NULL —
    except that a soft delete doesn't trigger that, so applied_lut_id is
    cleared explicitly here.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    lut.deleted_at = datetime.now(timezone.utc)
    db.query(ProjectLutShare).filter(ProjectLutShare.lut_id == lut.id).delete(synchronize_session=False)
    db.query(Asset).filter(Asset.applied_lut_id == lut.id).update(
        {"applied_lut_id": None}, synchronize_session=False
    )
    db.commit()


# ─── Project sharing ─────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/luts/{lut_id}/share", response_model=LutResponse)
def share_lut_to_project(
    project_id: uuid.UUID,
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Share one of your own LUTs into a project.

    Restricted to the LUT's owner (not any project admin): it's the owner's
    personal content being published, not the project's. The caller must
    also actually be on the project — viewer is enough, since sharing a LUT
    grants nothing beyond making a color transform readable.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    existing = db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == project_id,
        ProjectLutShare.lut_id == lut_id,
    ).first()
    if not existing:
        db.add(ProjectLutShare(project_id=project_id, lut_id=lut_id, shared_by=current_user.id))
        db.commit()

    return _to_response(lut, current_user, shared_with_project=True)


@router.delete("/projects/{project_id}/luts/{lut_id}/share", status_code=status.HTTP_204_NO_CONTENT)
def unshare_lut_from_project(
    project_id: uuid.UUID,
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove the share row only — never touches the underlying Lut.

    Any asset currently graded with this LUT has its applied_lut_id cleared,
    since the invariant "applied LUTs are project-visible" would otherwise
    break for everyone but the owner.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == project_id,
        ProjectLutShare.lut_id == lut_id,
    ).delete(synchronize_session=False)
    db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.applied_lut_id == lut.id,
    ).update({"applied_lut_id": None}, synchronize_session=False)
    db.commit()


@router.get("/projects/{project_id}/luts", response_model=list[LutResponse])
def list_project_luts(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What the in-player picker calls: the caller's own library plus every
    LUT shared into this project, de-duplicated."""
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    shared_rows = db.query(ProjectLutShare, Lut, User).join(
        Lut, ProjectLutShare.lut_id == Lut.id
    ).outerjoin(
        User, Lut.owner_id == User.id
    ).filter(
        ProjectLutShare.project_id == project_id,
        Lut.deleted_at.is_(None),
    ).all()

    own = db.query(Lut).filter(
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).all()

    shared_ids = {lut.id for _, lut, _ in shared_rows}
    out: list[LutResponse] = []
    for _, lut, owner in shared_rows:
        out.append(_to_response(
            lut, current_user,
            owner_name=owner.name if owner else None,
            shared_with_project=True,
        ))
    for lut in own:
        if lut.id in shared_ids:
            continue  # already listed above
        out.append(_to_response(
            lut, current_user,
            owner_name=current_user.name,
            shared_with_project=False,
        ))
    out.sort(key=lambda r: r.name.lower())
    return out


# ─── Applying a LUT to an asset ──────────────────────────────────────────────

@router.put("/assets/{asset_id}/lut", response_model=Optional[LutResponse])
def apply_lut_to_asset(
    asset_id: uuid.UUID,
    body: ApplyLutRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set (or clear, with lut_id=null) the grade the whole team sees.

    Requires the LUT to be shared into this asset's project — a personal,
    unshared LUT can be previewed locally all day, but writing it here would
    hand every teammate a reference they can't read.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.lut_id is None:
        asset.applied_lut_id = None
        db.commit()
        return None

    lut = db.query(Lut).filter(Lut.id == body.lut_id, Lut.deleted_at.is_(None)).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")

    is_shared = db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == asset.project_id,
        ProjectLutShare.lut_id == lut.id,
    ).first() is not None
    if not is_shared:
        raise HTTPException(
            status_code=400,
            detail="Share this LUT into the project before applying it, so the rest of the team can see it too",
        )

    asset.applied_lut_id = lut.id
    db.commit()
    return _to_response(lut, current_user, shared_with_project=True)


# ─── Graded export ───────────────────────────────────────────────────────────

@router.post("/assets/{asset_id}/lut-export", response_model=LutExportResponse)
def request_lut_export(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    lut_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Kick off a one-off graded render.

    The result is deliberately temporary: it lands under `lut-exports/` and
    a delayed cleanup task deletes it an hour later. Only the original
    un-graded file is ever kept.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    if asset.asset_type != AssetType.video:
        raise HTTPException(status_code=400, detail="Graded export is only available for video assets")

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

    target_lut_id = lut_id or asset.applied_lut_id
    if not target_lut_id:
        raise HTTPException(status_code=400, detail="No LUT applied to this asset")

    lut = db.query(Lut).filter(Lut.id == target_lut_id, Lut.deleted_at.is_(None)).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")

    # Same visibility rule as applying: you may export with a LUT you own,
    # or one shared into this project.
    if lut.owner_id != current_user.id:
        is_shared = db.query(ProjectLutShare).filter(
            ProjectLutShare.project_id == asset.project_id,
            ProjectLutShare.lut_id == lut.id,
        ).first() is not None
        if not is_shared:
            raise HTTPException(status_code=403, detail="No access to this LUT")

    export_id = uuid.uuid4()

    from ..tasks.celery_app import send_task_safe
    from ..tasks.lut_tasks import burn_lut_export
    send_task_safe(
        burn_lut_export,
        str(asset.id), str(version.id), str(lut.id), str(export_id),
    )

    return LutExportResponse(
        export_id=export_id,
        asset_id=asset.id,
        version_id=version.id,
        lut_id=lut.id,
    )


@router.get("/assets/{asset_id}/lut-export/{export_id}", response_model=StreamUrlResponse)
def get_lut_export_url(
    asset_id: uuid.UUID,
    export_id: uuid.UUID,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download URL for a finished graded export.

    Short token expiry (1h) matched to the export's own lifetime — there is
    no point handing out a URL that outlives the object it points at.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    export_key = f"lut-exports/{asset.project_id}/{asset_id}/{version_id}/{export_id}.mp4"
    filename = s3_service.build_download_filename(asset.name, export_key)
    return StreamUrlResponse(
        url=proxy_url_for(export_key, expires_hours=1, download_filename=filename),
        asset_type=asset.asset_type,
        expires_in=3600,
    )
