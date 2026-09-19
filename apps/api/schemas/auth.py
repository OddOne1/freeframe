from pydantic import BaseModel, EmailStr
import uuid
from datetime import datetime
from typing import Literal, Optional, Union
from ..models.user import UserStatus, UserGlobalRole
from ..models.project import ProjectRole

class RegisterRequest(BaseModel):
    email: EmailStr
    name: str
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    needs_password: bool = False  # True if user needs to set password
    #: §191 — ALWAYS present and always False here, so a caller has exactly
    #: one field to branch on rather than inferring from what is missing.
    #: Added to the success shape too, deliberately: a discriminator that
    #: only appears in one arm of a union is one an older or careless client
    #: reads as `undefined` and treats as falsy by accident rather than by
    #: decision.
    requires_2fa: Literal[False] = False


#: Which second factor a user enrolled with (§194).
#:
#: "totp"  — an authenticator app holds a shared secret.
#: "email" — a one-time code is mailed each time they sign in.
#:
#: Email started life in §191 as a fallback for a lost authenticator and is
#: now selectable as the primary method. The login-time verification path
#: needed no change for it: `_second_factor_matches` already tries TOTP,
#: then email, then a backup code, and `verify_totp_code` returns False for
#: a null secret rather than raising — so an email-only user falls through
#: the TOTP branch harmlessly. Verified before this was built on.
TwoFactorMethod = Literal["totp", "email"]


class TwoFactorRequiredResponse(BaseModel):
    """Password accepted, second factor outstanding (§191).

    Carries NO access_token and NO refresh_token — not nullable ones,
    absent ones. That is the point of making this a separate shape rather
    than letting TokenResponse's fields go optional: a client that forgets
    to check `requires_2fa` and reaches for `access_token` gets undefined
    and fails where the mistake is, instead of storing the string "null"
    and failing later on an unrelated request. The existing web client does
    exactly that kind of unguarded read today.
    """

    requires_2fa: Literal[True] = True
    #: True  -> the user has no 2FA yet and the instance now requires it;
    #:          the client should show enrolment (QR code), not a code box.
    #: False -> the user is enrolled; ask for a code.
    #: One flag rather than two endpoints because the backend mechanism is
    #: identical either way — only what the client draws differs.
    setup_required: bool
    #: Short-lived (10 min), `type: "2fa_pending"`. Useless anywhere in the
    #: app except the /auth/2fa/* completion endpoints: get_current_user
    #: rejects any token whose type is not exactly "access".
    pending_token: str
    #: §194 — which code to ask for, so the client can draw the right screen
    #: without a second round-trip: "open your authenticator" vs "check your
    #: email".
    #:
    #: NULL exactly when `setup_required` is True — a user being forced into
    #: enrolment has not chosen a method yet; choosing one is what the
    #: enrolment screen is for.
    method: Optional[TwoFactorMethod] = None
    #: True when a code has ALREADY been sent to this user's address as part
    #: of this response (email-primary only). Lets the client say "we've sent
    #: you a code" rather than showing a "send me one" button for something
    #: already in flight.
    email_code_sent: bool = False


#: What POST /auth/login returns. The two arms are distinguished by
#: `requires_2fa`, which is present in both.
LoginResponse = Union[TokenResponse, TwoFactorRequiredResponse]


# ── 2FA request/response bodies (§191) ──────────────────────────────────────

class TwoFactorVerifyRequest(BaseModel):
    pending_token: str
    #: A TOTP code, an emailed fallback code, or a backup code. The server
    #: tries each in turn rather than making the client say which it is —
    #: the user does not reliably know either, and a wrong guess would be a
    #: confusing failure on a correct code.
    code: str


class TwoFactorSetupRequest(BaseModel):
    """Carries the pending token when there is no session yet.

    Optional because the same endpoint serves an already-signed-in user
    turning 2FA on from settings, who has a bearer token instead.
    """

    pending_token: Optional[str] = None
    #: §194 — which second factor to enrol. Defaults to "totp", so every
    #: caller written before this field existed keeps working unchanged.
    method: TwoFactorMethod = "totp"


class TwoFactorSetupResponse(BaseModel):
    """What the client needs to draw an enrolment screen.

    §194 — the TOTP fields are now optional, because an email enrolment has
    no secret and nothing to scan. `method` says which set to expect rather
    than leaving the client to test for null and guess why.
    """

    #: Echoes back what was enrolled, so a client does not have to remember
    #: what it asked for across a round-trip.
    method: TwoFactorMethod = "totp"
    #: otpauth:// URI. Everything the authenticator needs. TOTP only.
    provisioning_uri: Optional[str] = None
    #: The same URI as a PNG data: URI, rendered server-side so no QR
    #: library is needed in the browser and the secret never travels to a
    #: third-party image service. TOTP only.
    qr_code_data_uri: Optional[str] = None
    #: For manual entry when a camera is not available. This IS the secret
    #: in plaintext — it is shown once, on a screen the user is already
    #: authenticated to, which is the same exposure the QR code has.
    #: TOTP only.
    secret: Optional[str] = None
    #: Email only: a code has been sent to the user's address and confirming
    #: it is what completes enrolment. True rather than implied by
    #: `method == "email"`, so a send that could not be attempted is
    #: distinguishable from one that was.
    email_code_sent: bool = False


class TwoFactorConfirmRequest(BaseModel):
    code: str
    #: Present when confirming during a forced first login; omitted when an
    #: already-signed-in user turns 2FA on from settings.
    pending_token: Optional[str] = None


class TwoFactorConfirmResponse(BaseModel):
    """Enrolment finished.

    Carries the backup codes ONCE, in plaintext. They are bcrypt-hashed
    server-side and this is the only moment they exist in readable form —
    there is no endpoint that returns them again.
    """

    backup_codes: list[str]
    #: §194 — what the user ended up enrolled with.
    method: TwoFactorMethod = "totp"
    #: Present only when this completed a forced first login, in which case
    #: the user is now fully authenticated and these are their real tokens.
    #: Absent when an already-signed-in user enabled 2FA from settings —
    #: they already hold valid tokens and re-issuing would be pointless
    #: churn.
    tokens: Optional[TokenResponse] = None


class TwoFactorReauthRequest(BaseModel):
    """Proof that the caller still holds a second factor (§192).

    Used by the two self-service operations that WEAKEN an account —
    disabling 2FA and replacing the backup codes. An access token alone is
    not enough for either: a stolen session should not be able to strip the
    protection that exists because sessions get stolen.

    Accepts any of the three forms the login path accepts (authenticator,
    emailed fallback, backup code), for the same reason it does there — the
    user does not reliably know which kind they are holding.
    """

    code: str


class TwoFactorDisableResponse(BaseModel):
    #: Always False after this call. Returned rather than implied so a
    #: client can update its own state from the response instead of
    #: assuming the write landed.
    two_factor_enabled: bool = False


class TwoFactorBackupCodesResponse(BaseModel):
    """A fresh set, shown once.

    Replaces the previous set entirely — regeneration is not "add more".
    The old codes stop working the moment this returns, which is the point:
    a set that might have been seen by someone else is not made safer by
    being extended.
    """

    backup_codes: list[str]


class TwoFactorEmailFallbackResponse(BaseModel):
    #: Deliberately says nothing about whether the address exists or
    #: whether a code was really sent.
    message: str = "If that account needs a code, one has been sent."

class RefreshRequest(BaseModel):
    refresh_token: str

class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    first_name: str | None
    last_name: str
    avatar_url: str | None
    status: UserStatus
    email_verified: bool = False
    role: UserGlobalRole = UserGlobalRole.user
    invite_token: str | None = None
    preferences: dict = {}
    created_at: datetime
    storage_limit_bytes: int | None = None

    model_config = {"from_attributes": True}


class ContactUserResponse(BaseModel):
    """Deliberately minimal -- backs GET /users/admins, which any
    authenticated user can call. UserResponse carries invite_token,
    storage_limit_bytes, preferences and status; none of that belongs in a
    world-readable "who do I contact for help" list, so this is a separate
    schema rather than a reuse.
    """
    id: uuid.UUID
    email: str
    name: str
    avatar_url: str | None

    model_config = {"from_attributes": True}


class AdminUserProjectSummary(BaseModel):
    project_id: uuid.UUID
    project_name: str
    role: ProjectRole

    model_config = {"from_attributes": True}

class AdminUserResponse(UserResponse):
    """UserResponse plus a per-project role summary, used only by the
    superadmin user-management dashboard so it can group users and show
    per-project roles without a separate round-trip per user."""
    projects: list[AdminUserProjectSummary] = []

class InviteRequest(BaseModel):
    email: EmailStr
    name: str

# Magic code flow
class SendMagicCodeRequest(BaseModel):
    email: EmailStr
    purpose: str = "login"

class SendMagicCodeResponse(BaseModel):
    message: str
    email: str

class VerifyMagicCodeRequest(BaseModel):
    email: EmailStr
    code: str

class SetPasswordRequest(BaseModel):
    password: str

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: str

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class UpdateProfileRequest(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class UpdateUserStorageLimitRequest(BaseModel):
    """A superadmin setting one user's personal storage budget.

    `None` means UNLIMITED, not "reset to the 200GB default". That is the
    reading the rest of the codebase already commits to: routers/projects.py's
    _check_owner_storage_allocation returns early on a NULL personal limit,
    and the web UI renders NULL as "Unlimited". The 200GB in
    add_user_global_role.py is a column server_default, which only applies
    when a row is INSERTed -- it is not a fallback for NULL. So sending null
    here grants unlimited storage; to put someone back on the default, send
    the 200GB value explicitly.
    """
    storage_limit_bytes: int | None

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID

# Permanent user deletion (superadmin-only, task 1 2026-07-23)
class PurgeUserOwnerCandidate(BaseModel):
    id: uuid.UUID
    name: str
    email: str

class PurgeUserOwnedProject(BaseModel):
    project_id: uuid.UUID
    project_name: str
    candidates: list[PurgeUserOwnerCandidate] = []

class PurgeUserPreviewResponse(BaseModel):
    owned_projects: list[PurgeUserOwnedProject] = []

class PurgeUserRequest(BaseModel):
    # project_id -> chosen new-owner user_id. Only needed for projects
    # where purge-preview listed at least one Manager candidate -- when a
    # project has none, the caller becomes owner automatically and no
    # entry is required here for that project.
    owner_assignments: dict[uuid.UUID, uuid.UUID] = {}
