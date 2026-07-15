import uuid

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.site_settings import SiteSettings
from ..schemas.site_settings import (
    SiteSettingsResponse,
    SiteSettingsUpdate,
)
from ..services import s3_service
from .hls_proxy import proxy_url_for

router = APIRouter(tags=["site-settings"])

# -- Helpers ---------------------------------------------------------------

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
    logo_login_url = None
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
    if site_settings.logo_login_s3_key:
        try:
            logo_login_url = proxy_url_for(site_settings.logo_login_s3_key)
        except Exception:
            logo_login_url = None
    favicon_url = None
    if site_settings.favicon_s3_key:
        try:
            favicon_url = proxy_url_for(site_settings.favicon_s3_key)
        except Exception:
            favicon_url = None
    return SiteSettingsResponse(
        org_name=site_settings.org_name,
        logo_dark_url=logo_dark_url,
        logo_light_url=logo_light_url,
        logo_login_url=logo_login_url,
        favicon_url=favicon_url,
        theme_colors=site_settings.theme_colors,
    )
# -- Endpoints ---------------------------------------------------------------

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
    response_model=SiteSettingsResponse,
    status_code=status.HTTP_200_OK,
)
async def upload_site_logo(
    side: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload one of the site-wide logos (dark/light/login) and persist it
    in the same request.

    Uploaded straight through this API container rather than a presigned
    browser->S3 PUT -- see users.py::upload_avatar for the full reasoning:
    AIStor is only reachable over plain HTTP on the LAN, so a direct
    presigned URL handed to an https:// page gets blocked as mixed content
    in browsers without an override already set for this origin.
    """
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update site settings",
        )
    if side not in ("dark", "light", "login"):
        raise HTTPException(status_code=400, detail="side must be 'dark', 'light', or 'login'")

    body = await file.read()
    key = f"site-settings/logo-{side}/{uuid.uuid4()}.webp"
    s3_service.put_object(key, body, content_type="image/webp", cache_control="max-age=86400")

    site_settings = _get_or_create_settings(db)
    setattr(site_settings, f"logo_{side}_s3_key", key)
    db.commit()
    db.refresh(site_settings)
    return _to_response(site_settings)


@router.post(
    "/site-settings/favicon-upload",
    response_model=SiteSettingsResponse,
    status_code=status.HTTP_200_OK,
)
async def upload_site_favicon(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload the site-wide favicon and persist it in the same request.
    See upload_site_logo above for why this proxies through the API
    instead of a presigned browser->S3 PUT.
    """
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update site settings",
        )

    body = await file.read()
    key = f"site-settings/favicon-{uuid.uuid4()}.png"
    s3_service.put_object(key, body, content_type="image/png", cache_control="max-age=86400")

    site_settings = _get_or_create_settings(db)
    site_settings.favicon_s3_key = key
    db.commit()
    db.refresh(site_settings)
    return _to_response(site_settings)
