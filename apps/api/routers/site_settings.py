import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.site_settings import SiteSettings
from ..schemas.site_settings import (
    SiteSettingsResponse,
    SiteSettingsUpdate,
    SiteLogoUploadResponse,
)
from ..services import s3_service
from .hls_proxy import proxy_url_for
from ..config import settings

router = APIRouter(tags=["site-settings"])

# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_or_create_settings(db: Session) -> SiteSettings:
    site_settings = db.query(SiteSettings).first()
    if not site_settings:
        site_settings = SiteSettings()
        db.add(site_settings)
        db.commit()
        db.refresh(site_settings)
    return site_settings


def _to_response(site_settings: SiteSettings) -> SiteSettingsResponse:
    logo_dark_url = None
    logo_light_url = None
    if site_settings.logo_dark_s3_key:
        try:
            logo_dark_url = proxy_url_for(site_settings.logo_dark_s3_key)
        except Exception:
            logo_dark_url = None
    if site_settings.logo_light_s3_key:
        try:
            logo_light_url = proxy_url_for(site_settings.logo_light_s3_key)
        except Exception:
            logo_light_url = None
    return SiteSettingsResponse(
        org_name=site_settings.org_name,
        logo_dark_url=logo_dark_url,
        logo_light_url=logo_light_url,
    )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/site-settings", response_model=SiteSettingsResponse)
def get_site_settings(db: Session = Depends(get_db)):
    site_settings = _get_or_create_settings(db)
    return _to_response(site_settings)


@router.patch("/site-settings", response_model=SiteSettingsResponse)
def update_site_settings(
    body: SiteSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update site settings",
        )

    site_settings = _get_or_create_settings(db)
    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(site_settings, field, value)
    db.commit()
    db.refresh(site_settings)
    return _to_response(site_settings)


@router.post(
    "/site-settings/logo-upload",
    response_model=SiteLogoUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
def get_site_logo_upload_url(
    side: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update site settings",
        )
    if side not in ("dark", "light"):
        raise HTTPException(status_code=400, detail="side must be 'dark' or 'light'")

    key = f"site-settings/logo-{side}/{uuid.uuid4()}.webp"
    upload_url = s3_service.get_s3_client().generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.s3_bucket,
            "Key": key,
            "ContentType": "image/webp",
        },
        ExpiresIn=3600,
    )
    return SiteLogoUploadResponse(upload_url=upload_url, key=key)
