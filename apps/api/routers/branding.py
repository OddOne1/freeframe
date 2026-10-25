import logging
import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset
from ..models.project import ProjectRole
from ..models.branding import ProjectBranding, WatermarkSettings
from ..schemas.branding import (
    BrandingUpdate,
    BrandingResponse,
    BrandingLogoUploadResponse,
    WatermarkUpdate,
    WatermarkResponse,
    WatermarkImageUploadResponse,
)
from ..services.permissions import require_project_role, require_asset_access
from ..services import s3_service
from ..services.owned_keys import (
    is_owned_project_logo_key,
    new_project_logo_key,
    new_watermark_image_key,
)
from .hls_proxy import proxy_url_for
from ..config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["branding"])

#: What a caller is told when it sends a logo key this project does not own.
#: Deliberately generic and identical for every rejected shape — an absolute
#: URL, another project's key, a traversal, an encoded traversal. The server
#: knows which rule was broken; a caller probing for readable object paths
#: learns nothing from the difference.
INVALID_LOGO_KEY = "Invalid logo key"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_or_create_branding(db: Session, project_id: uuid.UUID) -> ProjectBranding:
    branding = db.query(ProjectBranding).filter(
        ProjectBranding.project_id == project_id
    ).first()
    if not branding:
        branding = ProjectBranding(project_id=project_id)
        db.add(branding)
        db.commit()
        db.refresh(branding)
    return branding


def _get_or_create_watermark(db: Session, project_id: uuid.UUID) -> WatermarkSettings:
    wm = db.query(WatermarkSettings).filter(
        WatermarkSettings.project_id == project_id,
        WatermarkSettings.share_link_id.is_(None),
    ).first()
    if not wm:
        wm = WatermarkSettings(project_id=project_id)
        db.add(wm)
        db.commit()
        db.refresh(wm)
    return wm


def _branding_to_response(branding: ProjectBranding) -> BrandingResponse:
    """§235 — a key is signed only if THIS project owns it.

    Defence in depth behind `upsert_branding`'s check, for the rows that
    predate it (the migration nulls them, but a response must not depend on
    the migration having run) and for any future writer that forgets. It
    matters because `proxy_url_for` does not sign one object: it signs a
    token scoped to the key's whole S3 prefix, so signing an unowned key
    hands the caller read access to everything under it for 24 hours.

    A refusal is LOGGED, not swallowed. The old `except Exception: None`
    around the signing call could only ever report a signing failure as "no
    logo", which is exactly how a bad row stays invisible. The log names the
    project, not the key: the response is what a client reads, and nothing
    about the refused value belongs in it.
    """
    resp = BrandingResponse.model_validate(branding)
    if branding.logo_s3_key:
        if not is_owned_project_logo_key(branding.project_id, branding.logo_s3_key):
            logger.warning(
                "Refusing to sign a logo key project %s does not own", branding.project_id
            )
            return resp
        try:
            resp.logo_url = proxy_url_for(branding.logo_s3_key)
        except Exception:
            logger.warning("Failed to sign the logo key of project %s", branding.project_id)
            resp.logo_url = None
    return resp


# ── Project Branding ──────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/branding", response_model=BrandingResponse)
def get_branding(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    branding = _get_or_create_branding(db, project_id)
    return _branding_to_response(branding)


@router.put("/projects/{project_id}/branding", response_model=BrandingResponse)
def upsert_branding(
    project_id: uuid.UUID,
    body: BrandingUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    branding = _get_or_create_branding(db, project_id)
    update_data = body.model_dump(exclude_none=True)

    # §235 — `logo_s3_key` is handled on its own, before the generic loop, and
    # never by it. Any other string the column could hold becomes a 24-hour
    # read token for a whole S3 prefix the moment a response signs it (see
    # `_branding_to_response`), so the only values accepted here are the one
    # format POST .../branding/logo-upload issues FOR THIS PROJECT — and the
    # empty one, which clears.
    #
    # Read from an `exclude_unset` dump rather than the `exclude_none` one
    # above: `exclude_none` cannot tell "no logo field in this PATCH" from
    # "logo: null", and a client that asks to remove its logo has to be able
    # to say so.
    update_data.pop("logo_s3_key", None)
    provided = body.model_dump(exclude_unset=True)
    if "logo_s3_key" in provided:
        requested = provided["logo_s3_key"]
        if requested is None or not str(requested).strip():
            branding.logo_s3_key = None
        elif is_owned_project_logo_key(project_id, requested):
            branding.logo_s3_key = requested
        else:
            logger.warning(
                "Rejected a logo key project %s does not own (user %s)",
                project_id,
                current_user.id,
            )
            raise HTTPException(status_code=400, detail=INVALID_LOGO_KEY)

    for field, value in update_data.items():
        setattr(branding, field, value)
    db.commit()
    db.refresh(branding)
    return _branding_to_response(branding)


@router.post(
    "/projects/{project_id}/branding/logo-upload",
    response_model=BrandingLogoUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_logo_upload_url(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    # §235 — built by the same module that validates it, so the issued format
    # and the accepted format cannot drift apart.
    key = new_project_logo_key(project_id)
    upload_url = s3_service.get_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": "image/webp",
        },
        ExpiresIn=3600,
    )
    return BrandingLogoUploadResponse(upload_url=upload_url, key=key)


# ── Watermark Settings ────────────────────────────────────────────────────────

@router.get("/projects/{project_id}/watermark", response_model=WatermarkResponse)
def get_watermark(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.viewer)
    wm = _get_or_create_watermark(db, project_id)
    return WatermarkResponse.model_validate(wm)


@router.put("/projects/{project_id}/watermark", response_model=WatermarkResponse)
def upsert_watermark(
    project_id: uuid.UUID,
    body: WatermarkUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    wm = _get_or_create_watermark(db, project_id)
    update_data = body.model_dump(exclude_none=True)
    for field, value in update_data.items():
        setattr(wm, field, value)
    db.commit()
    db.refresh(wm)
    return WatermarkResponse.model_validate(wm)


@router.post(
    "/projects/{project_id}/watermark/image-upload",
    response_model=WatermarkImageUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_watermark_image_upload_url(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)
    key = new_watermark_image_key(project_id)
    upload_url = s3_service.get_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": "image/png",
        },
        ExpiresIn=3600,
    )
    return WatermarkImageUploadResponse(upload_url=upload_url, key=key)


# ── Apply Watermark ───────────────────────────────────────────────────────────

@router.post("/assets/{asset_id}/apply-watermark", status_code=status.HTTP_202_ACCEPTED)
def apply_watermark_to_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    wm = db.query(WatermarkSettings).filter(
        WatermarkSettings.project_id == asset.project_id,
        WatermarkSettings.share_link_id.is_(None),
    ).first()
    if not wm or not wm.enabled:
        raise HTTPException(status_code=400, detail="Watermark not enabled")

    # Resolve watermark text based on content type
    if wm.content == "email":
        watermark_text = current_user.email
    elif wm.content == "name":
        watermark_text = current_user.name or current_user.email
    else:  # custom_text
        watermark_text = wm.custom_text or ""

    from ..tasks.watermark_tasks import apply_watermark
    from ..tasks.celery_app import send_task_safe
    send_task_safe(
        apply_watermark,
        str(asset_id),
        watermark_text,
        wm.position,
        wm.opacity,
        None,  # image_key not stored in model
    )
    return {"status": "watermark_queued"}
