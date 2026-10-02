import uuid
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.orm import Session
from sqlalchemy import func, update

from ..config import settings as app_settings
from ..database import get_db
from ..middleware.auth import get_current_user, get_optional_user
from ..models.user import User, UserGlobalRole, UserStatus
from ..models.site_settings import SiteSettings
from ..models.asset import Asset, AssetVersion, MediaFile
from ..schemas.site_settings import (
    RequireTwoFactorImpactResponse,
    SiteSettingsResponse,
    SiteSettingsUpdate,
)
from ..services import s3_service
from ..services.schedule_window import is_valid_timezone
from .hls_proxy import proxy_url_for

router = APIRouter(tags=["site-settings"])

# -- Helpers ---------------------------------------------------------------

#: The four columns holding a custom brand image. Once one of these has a
#: value, it is never cleared back to NULL (§178).
#:
#: NULL means "show the bundled FreeFrame default", and the requirement is
#: that an organisation which has ever set its own logo is never shown that
#: default again — not by a Remove click, not by "Reset to defaults", not by
#: a hand-rolled PATCH. Replacing one with a new upload is unaffected: the
#: column goes from one key to another, never to NULL.
#:
#: A never-configured install is untouched by this. Those columns are
#: already NULL, so the fresh-install case still shows the default exactly
#: as before — this rule only protects a value that exists.
BRAND_IMAGE_FIELDS = (
    "logo_dark_s3_key",
    "logo_light_s3_key",
    "logo_login_s3_key",
    "favicon_s3_key",
)


def _require_2fa_bump_filters():
    """Who loses their sessions when `require_2fa` goes off -> on (§207).

    ONE definition, returned as a list of filter clauses so that the
    confirmation's preview count and the UPDATE that actually bumps are
    asking the same question. Two hand-written WHERE clauses that agree on
    the day they are written is the shape this codebase keeps paying for
    (§190's four byte-formatters, §193's two login branches) — and here the
    cost of drift is specific and bad: a confirmation that says "3 users"
    followed by a write that signs out 300.

    The rule, and why each half of it:

    - `two_factor_enabled.is_(False)` — the whole point. A user who already
      has a second factor is not affected by the requirement becoming
      mandatory; nothing about what their live session is entitled to has
      changed, so ending it would be gratuitous. Only the users whose next
      login is about to be rerouted into forced enrolment are signed out,
      because theirs are the sessions holding one factor while the instance
      has started requiring two.

    - `status == active` — a deactivated account's sessions are already
      refused on every request (get_current_user re-reads `status`, see
      §199's note on the model), so bumping them would change nothing and
      would inflate the number the admin is shown. pending_invite and
      pending_verification are excluded for the same reason: there is no
      live session to end, and "N users will be signed out" has to mean it.

    - `deleted_at.is_(None)` — soft-deleted rows are not users any more.

    The acting admin is NOT exempt. If a superadmin without 2FA turns the
    requirement on, they are signed out with everybody else and walk their
    own forced enrolment — which is the correct outcome, not an oversight:
    the alternative is the one account on the instance holding a
    single-factor session under a policy that forbids it.
    """
    return [
        User.deleted_at.is_(None),
        User.status == UserStatus.active,
        User.two_factor_enabled.is_(False),
    ]


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


def _to_response(
    site_settings: SiteSettings,
    include_usage: bool = False,
    db: Optional[Session] = None,
    two_factor_signed_out_count: Optional[int] = None,
) -> SiteSettingsResponse:
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
        timezone=site_settings.timezone or "UTC",
        require_2fa=bool(site_settings.require_2fa),
        total_storage_used_bytes=_platform_storage_used_bytes(db) if include_usage and db is not None else None,
        # §207 — None unless this response is the one that ended sessions.
        two_factor_signed_out_count=two_factor_signed_out_count,
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

    # §207 — read BEFORE the setattr loop below overwrites it. This is the
    # off -> on edge and nothing else: on -> on is not a change, and on ->
    # off deliberately ends no sessions (dropping the requirement does not
    # alter what anybody's live session is entitled to, and it does not
    # un-enrol the users who opted in themselves).
    #
    # `"require_2fa" in update_data` rather than a truthiness check on the
    # value, because the field is Optional and absent on every PATCH that is
    # about something else — a brand image, the timezone, the storage cap.
    # Those must not touch a single session.
    turning_2fa_requirement_on = (
        "require_2fa" in update_data
        and bool(update_data["require_2fa"])
        and not bool(site_settings.require_2fa)
    )

    # §182 — rejected rather than coerced. An unknown zone would make every
    # wall-clock check fall back to UTC silently, so the maintenance jobs
    # would keep running at the old hour with the settings page insisting
    # otherwise. Better a 400 the admin sees now.
    tz = update_data.get("timezone")
    if tz is not None and not is_valid_timezone(tz):
        raise HTTPException(status_code=400, detail=f"Unknown timezone: {tz}")

    for field, value in update_data.items():
        # §178 — a configured brand image is never cleared. Ignored rather
        # than rejected with a 400: the payload that asks for this is the
        # legacy "Reset to defaults" one, which also carries an org_name and
        # theme_colors reset that SHOULD still apply, and failing the whole
        # request would take those down with it. The response is built from
        # the row afterwards, so a caller that asked for a clear sees the
        # logo still there rather than a success that silently did nothing.
        if field in BRAND_IMAGE_FIELDS and value is None:
            if getattr(site_settings, field) is not None:
                continue
        setattr(site_settings, field, value)

    # §207 — session invalidation, in the SAME transaction as the settings
    # write above. Before this, turning the requirement on changed one
    # boolean and left every single-factor session running for the whole
    # refresh window: the policy only took effect at each user's next login,
    # so an already-open tab kept full access with one factor, and a stolen
    # laptop survived the admin's decision entirely. §199 built the
    # mechanism (`users.token_version`, checked by get_current_user and
    # /auth/refresh); this is the one place that was never wired to it.
    #
    # ONE statement does both jobs. The number reported back is this
    # UPDATE's own row count, not a SELECT count(*) taken next to it: a
    # separate count could be read a moment before a user enrolled or was
    # deactivated and would then report a figure that never matched what was
    # actually bumped. There is nothing to keep in step here because there is
    # only one statement.
    #
    # Deliberately NOT a generic "any settings change bumps" hook. This one
    # field is the only one whose value changes what a live session is
    # entitled to; a timezone or a logo does not, and a hook that could not
    # tell the difference would log the whole instance out on a brand tweak.
    signed_out_count: Optional[int] = None
    if turning_2fa_requirement_on:
        bumped = db.execute(
            update(User)
            .where(*_require_2fa_bump_filters())
            .values(token_version=User.token_version + 1)
            .returning(User.id)
            # The ORM has User objects in this session's identity map (the
            # acting admin, at least, loaded by get_current_user). Without
            # this, SQLAlchemy would try to reconcile them against a bulk
            # UPDATE it cannot evaluate in Python and raise.
            .execution_options(synchronize_session=False)
        ).fetchall()
        signed_out_count = len(bumped)

    db.commit()
    db.refresh(site_settings)
    return _to_response(
        site_settings,
        include_usage=True,
        db=db,
        two_factor_signed_out_count=signed_out_count,
    )


@router.get(
    "/site-settings/require-2fa-impact",
    response_model=RequireTwoFactorImpactResponse,
)
def require_two_factor_impact(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """§207 — how many people turning the requirement on would sign out.

    Read by the confirmation dialog so the admin sees the number before
    deciding, which is the whole reason this endpoint exists: the
    authoritative count can only come from the write itself, and by then the
    decision has been made.

    Same predicate as the write (`_require_2fa_bump_filters`), so the two
    cannot disagree about who is in scope. Returns the count even when the
    requirement is already on — the caller decides whether to ask, and a
    number for a flip that would be a no-op is less surprising than a 400.
    """
    if current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can update site settings",
        )

    affected = (
        db.query(func.count(User.id)).filter(*_require_2fa_bump_filters()).scalar()
    )
    return RequireTwoFactorImpactResponse(affected_users=int(affected or 0))


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
