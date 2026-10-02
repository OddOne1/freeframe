from typing import Optional, Dict, Any
from pydantic import BaseModel


class SiteSettingsResponse(BaseModel):
    org_name: str
    logo_dark_url: Optional[str] = None
    logo_light_url: Optional[str] = None
    logo_login_url: Optional[str] = None
    favicon_url: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None
    total_storage_limit_bytes: Optional[int] = None
    #: IANA zone name deciding when the daily maintenance jobs run (§182).
    timezone: str = "UTC"
    #: §191 — whether every user on this instance must have 2FA.
    require_2fa: bool = False
    # Live-computed, not stored -- sum of MediaFile.file_size_bytes across
    # every non-deleted asset platform-wide. Only populated for an
    # authenticated superadmin caller (GET /site-settings is otherwise
    # public/unauthenticated, backing the login page's branding) so real
    # usage figures never leak to anonymous visitors.
    total_storage_used_bytes: Optional[int] = None
    #: §207 — how many signed-in users this request just signed out by
    #: turning `require_2fa` on. Only ever populated on the PATCH that
    #: performs the off -> on flip; None on every GET and on every other
    #: write, because no other write ends a session.
    #:
    #: It is the row count of the one UPDATE that did the bumping, not a
    #: separate count taken alongside it — see
    #: routers/site_settings.py::update_site_settings for why that matters.
    two_factor_signed_out_count: Optional[int] = None

    model_config = {"from_attributes": True}


class RequireTwoFactorImpactResponse(BaseModel):
    """§207 — the dry-run count behind the confirmation dialog.

    Answers "if I turned the requirement on right now, how many people
    would that sign out?" without turning it on. Superadmin-only, like the
    PATCH it precedes.

    Deliberately a PREVIEW and labelled as one: it is read before the admin
    decides, so it cannot be the same statement that does the bumping (that
    one runs later, inside the write). What it shares with the real thing is
    the predicate — `_require_2fa_bump_filters()`, one definition used by
    both — so the two cannot disagree about WHO is affected. They can
    disagree about HOW MANY only if the user table changes in between, which
    is why the authoritative number comes back from the write itself in
    `SiteSettingsResponse.two_factor_signed_out_count`.
    """

    affected_users: int


class SiteSettingsUpdate(BaseModel):
    org_name: Optional[str] = None
    logo_dark_s3_key: Optional[str] = None
    logo_light_s3_key: Optional[str] = None
    logo_login_s3_key: Optional[str] = None
    favicon_s3_key: Optional[str] = None
    theme_colors: Optional[Dict[str, Any]] = None
    total_storage_limit_bytes: Optional[int] = None
    #: IANA zone name. Validated against the real zone database in the
    #: router — an unknown string here would make every wall-clock check
    #: fall back to UTC forever, silently (§182).
    timezone: Optional[str] = None
    #: §191 — turning this ON routes users without 2FA into forced ENROLMENT
    #: on their next correct password; it does not lock anyone out.
    require_2fa: Optional[bool] = None
