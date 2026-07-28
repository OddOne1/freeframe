import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..config import settings as app_settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..models.user import User, UserGlobalRole
from ..models.site_settings import SiteSettings
from ..models.asset import Asset, AssetVersion, MediaFile
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


def _platform_storage_used_bytes(db: Session) -> int:
    """Sum of MediaFile.file_size_bytes across every non-deleted asset
    platform-wide -- same aggregate the upload.py enforcement check uses,
    just without a project filter."""
    return db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0)).join(
        AssetVersion, MediaFile.version_id == AssetVersion.id
    ).join(
        Asset, AssetVersion.asset_id == Asset.id
    ).filter(Asset.deleted_at.is_(None)).scalar() or 0


def _sniff_image_content_type(data: bytes, fallback: str) -> str:
    """Detect an image's real format from its magic bytes.

    upload_site_logo stores *every* logo under a `.webp` key with an
    `image/webp` content type regardless of what was actually uploaded, so
    neither the key's extension nor the object's stored ContentType is
    trustworthy. Browsers sniff and cope; email clients (notably Outlook on
    Windows) do not render WebP at all and will show nothing for a PNG
    mislabelled as one -- hence sniffing here rather than trusting either.
    """
    for magic, content_type in (
        (b"\x89PNG\r\n\x1a\n", "image/png"),
        (b"\xff\xd8\xff", "image/jpeg"),
        (b"GIF8", "image/gif"),
    ):
        if data.startswith(magic):
            return content_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data.lstrip()[:5] == b"<?xml" or data.lstrip()[:4] == b"<svg":
        return "image/svg+xml"
    return fallback


def _to_response(site_settings: SiteSettings, include_usage: bool = False, db: Optional[Session] = None) -> SiteSettingsResponse:
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
        total_storage_limit_bytes=site_settings.total_storage_limit_bytes,
        total_storage_used_bytes=_platform_storage_used_bytes(db) if include_usage and db is not None else None,
    )
# -- Endpoints ---------------------------------------------------------------

@router.get("/site-settings", response_model=SiteSettingsResponse)
def get_site_settings(db: Session = Depends(get_db), current_user: Optional[User] = Depends(get_optional_user)):
    """Public/unauthenticated (backs the login page's branding), so
    total_storage_used_bytes -- a real platform-wide usage figure -- is
    only computed and included for an authenticated superadmin caller.
    Everyone else gets the configured limit but not the live usage."""
    site_settings = _get_or_create_settings(db)
    include_usage = current_user is not None and current_user.role == UserGlobalRole.superadmin
    return _to_response(site_settings, include_usage=include_usage, db=db)


@router.get("/site-settings/logo-image")
def get_site_logo_image(db: Session = Depends(get_db)):
    """Serve the site logo's raw bytes, unauthenticated and non-expiring.

    Exists specifically for email templates, which cannot use the
    `proxy_url_for` URLs `_to_response` hands the frontend: those are
    *relative* (an email client has no current page to resolve them
    against) and carry a token that expires after 24h (so the image would
    break in every email older than a day). This endpoint is deliberately
    plain: no token, no expiry, cacheable.

    Light logo only -- email bodies are read on a white background. 404s
    when no logo is configured; callers are expected to omit the <img>
    entirely in that case rather than render a broken-image icon.
    """
    site_settings = _get_or_create_settings(db)
    s3_key = site_settings.logo_light_s3_key
    if not s3_key:
        raise HTTPException(status_code=404, detail="No logo configured")

    s3 = s3_service.get_s3_client()
    try:
        obj = s3.get_object(Bucket=app_settings.s3_bucket, Key=s3_key)
        body = obj["Body"].read()
    except Exception:
        raise HTTPException(status_code=404, detail="Logo image not found")

    fallback, cache_control = s3_service.get_content_type(s3_key)
    return Response(
        content=body,
        media_type=_sniff_image_content_type(body, fallback),
        headers={"Cache-Control": cache_control},
    )


@router.patch("/site-settings", response_model=SiteSettingsResponse)
def update_site_settings(
    body: SiteSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if current_user.role != UserGlobalRole.superadmin:
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
    return _to_response(site_settings, include_usage=True, db=db)


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
    if current_user.role != UserGlobalRole.superadmin:
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
    if current_user.role != UserGlobalRole.superadmin:
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
