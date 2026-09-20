from pydantic import BaseModel, EmailStr, field_validator
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
    #: §194b — proof that the caller still holds the CURRENT second factor,
    #: required only from a user who is already enrolled and is replacing
    #: what they have. Same three accepted forms as TwoFactorReauthRequest
    #: below, and for the same reason: re-enrolling fully replaces what "a
    #: valid second factor" means for the account, which is the same class
    #: of weakening action as turning it off.
    #:
    #: A field here rather than a second request model, because this is one
    #: endpoint serving one operation in two situations — first enrolment
    #: (pending token, nothing to protect yet) and re-enrolment (session,
    #: a live factor to protect). Splitting the model would fork the body
    #: by caller type for a difference the endpoint already decides from
    #: the user's own state, and would leave two places to keep `method` in
    #: step. Optional for exactly that reason: the forced-first-login path
    #: has no current factor to prove and must not be asked for one.
    reauth_code: Optional[str] = None


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
    #: §199 — a replacement pair for the session that made this call.
    #:
    #: Disabling 2FA bumps `token_version`, which ends every session this
    #: user holds — INCLUDING the one that just did it, whose token was
    #: minted under the old version. Without these, "turn my 2FA off" would
    #: silently log the user out one request later, which is worse than the
    #: behaviour this change exists to fix, not better. The caller adopts
    #: them exactly as it adopts a login's.
    tokens: Optional[TokenResponse] = None


class TwoFactorBackupCodesResponse(BaseModel):
    """A fresh set, shown once.

    Replaces the previous set entirely — regeneration is not "add more".
    The old codes stop working the moment this returns, which is the point:
    a set that might have been seen by someone else is not made safer by
    being extended.
    """

    backup_codes: list[str]
    #: §199 — see TwoFactorDisableResponse.tokens; identical reasoning.
    #: Regenerating backup codes bumps `token_version` too.
    tokens: Optional[TokenResponse] = None


class TwoFactorEmailFallbackResponse(BaseModel):
    #: Deliberately says nothing about whether the address exists or
    #: whether a code was really sent.
    message: str = "If that account needs a code, one has been sent."

# ── Account security gate (§200) ────────────────────────────────────────────

#: Where this account stands on having a usable password-reset channel.
#:
#: "missing"  — no backup address at all. The gate asks for one.
#: "pending"  — an address is stored but nobody has proved it is reachable.
#:              Still gated: a reset sent to an address that may not exist is
#:              worse than no reset path, because it looks like one.
#: "verified" — a code sent to it came back. This is the only state in which
#:              anything is ever mailed there.
BackupEmailState = Literal["missing", "pending", "verified"]


class BackupEmailRequest(BaseModel):
    """Propose a backup address (or replace the one on file)."""

    backup_email: EmailStr
    #: §200 — proof the caller still holds the current second factor, required
    #: only when this REPLACES an already-verified address. Changing where
    #: password resets are delivered is the single most valuable thing a
    #: stolen session could do to this account: point resets at a mailbox the
    #: attacker owns, then reset. Same three accepted forms as
    #: TwoFactorReauthRequest.
    #:
    #: Not required for the FIRST address, and that is not a gap. There is
    #: nothing to steal yet — the account has no reset channel to redirect —
    #: and a user who is not enrolled in 2FA could never produce a code, so
    #: requiring one would make the gate unsatisfiable for exactly the people
    #: it is trying to onboard.
    reauth_code: Optional[str] = None


class BackupEmailResponse(BaseModel):
    """What the gate screen needs after proposing or resending."""

    backup_email: str
    state: BackupEmailState
    #: True when a verification code was mailed by this call. False when one
    #: was already outstanding and re-sending would only invalidate the code
    #: the person is currently reading.
    code_sent: bool = False
    #: §200 — the address is on the SAME DOMAIN as the login address.
    #:
    #: Accepted, not refused: plenty of legitimate setups are two real
    #: mailboxes in one company, and refusing them would push people towards
    #: an address they check less often. But it is worth saying out loud,
    #: because the whole point is that the login mailbox must not be able to
    #: read the reset mail, and one admin with domain-wide access defeats
    #: that. A flag rather than a sentence, so the wording lives in the UI
    #: with the rest of the copy.
    same_domain: bool = False


class BackupEmailVerifyRequest(BaseModel):
    code: str


class PasswordPolicyResponse(BaseModel):
    """The rules, so the screen can state them before the first attempt.

    Served from services/password_policy.describe_policy() rather than
    written out again in TypeScript — a screen that promises different rules
    from the ones enforced is how a user ends up typing five passwords.
    """

    min_length: int
    min_strength_score: int
    requires_upper: bool
    requires_lower: bool
    requires_digit: bool
    requires_special: bool


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
    #: §197 — a user's own second-factor state, so the settings screen can
    #: render "on, via an authenticator app" without a second endpoint.
    #: Read-only here: enrolling and disabling go through /auth/2fa/*, which
    #: is where the proofs those actions require are enforced. A PATCH that
    #: happened to include these is not a way to turn 2FA off, because
    #: nothing writes them from this schema.
    two_factor_enabled: bool = False
    two_factor_method: Optional[TwoFactorMethod] = None
    #: §200 — the onboarding gate, computed server-side from the stored data
    #: and reported here.
    #:
    #: DERIVED on the model (User.must_set_password / User.backup_email_state)
    #: rather than stored, which is the whole reason the gate can be trusted:
    #: it disappears the moment the data is real and comes back if the data is
    #: cleared, and no "I have seen this screen" flag in a browser can turn it
    #: off. A client that wants to know whether to render the gate asks here;
    #: a client that lies about the answer still gets 403s from every
    #: protected route, because the middleware asks the same question of the
    #: same data.
    must_set_password: bool = False
    backup_email_state: BackupEmailState = "missing"
    #: The address itself, so the gate and the settings screen can show what
    #: is on file without a second endpoint. Safe to return to the account's
    #: own session — it is the user's own address — and it is NOT returned by
    #: ContactUserResponse, which is the world-readable shape.
    backup_email: Optional[str] = None

    model_config = {"from_attributes": True}

    @field_validator("two_factor_enabled", mode="before")
    @classmethod
    def _unset_means_not_enrolled(cls, v):
        """A User that has never been flushed reads None here.

        The column is NOT NULL with a server default, so a row in the
        database is never None — but /auth/register serialises the object it
        just created, before any default has been applied. "Not enrolled" is
        the honest answer for a user who was created a millisecond ago.

        Deliberately not `bool(v)`: that would quietly turn any unexpected
        object into True, which in a test suite built on MagicMock users
        means a fixture that forgot this field would claim 2FA is ON and be
        believed.
        """
        return False if v is None else v

    @field_validator("must_set_password", mode="before")
    @classmethod
    def _unknown_means_not_gated(cls, v):
        """Anything that is not a real bool reads as "no password needed".

        Same shape as the validator above and for the same reason — this
        suite is built on MagicMock users, where every unset attribute is a
        truthy object — but the safe default is the opposite one. A fixture
        that forgets this field should not conjure a gate that blocks a test
        of something unrelated; the gate's own tests set it explicitly.

        On a real User this is a property computed from `password_hash`, so
        it is always a genuine bool and this validator never fires.
        """
        return v if isinstance(v, bool) else False

    @field_validator("backup_email_state", mode="before")
    @classmethod
    def _unknown_state_is_missing(cls, v):
        """Only the three real states survive; anything else reads "missing".

        Deliberately NOT permissive in the other direction: an unrecognised
        value must not be able to read as "verified", which is the one state
        that unblocks the gate and authorises mail to be sent somewhere.
        """
        return v if v in ("missing", "pending", "verified") else "missing"

    @field_validator("backup_email", mode="before")
    @classmethod
    def _only_a_real_address(cls, v):
        return v if isinstance(v, str) else None


class SetPasswordResponse(UserResponse):
    """§199 — everything UserResponse carried, plus a replacement token pair.

    Setting or changing a password bumps `token_version`, which ends every
    session the user holds — including the one that made this call. So the
    response has to hand back a working pair or "change my password" would
    log the user out of the device they changed it on.

    It also closes a mismatch that predates this change:
    `components/auth/login-form.tsx`'s set-password step has always typed
    this response as `AuthTokens` and called `setTokens(res.access_token,
    res.refresh_token)` on it, while the endpoint returned a bare
    UserResponse — so it stored the literal string "undefined" over the
    tokens the magic-code step had just set moments earlier. The fields it
    was already reading now genuinely exist.

    A subclass rather than a wrapper object: every existing caller keeps
    reading the same user fields off the top level, and the two new ones sit
    exactly where that client already looked for them.
    """

    access_token: str
    refresh_token: str
    token_type: str = "bearer"


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
    #: §197 — which pool to check. Login codes and password-reset codes are
    #: stored separately now, so verification has to know which one it is
    #: looking at. Defaults to "login" so callers written before this field
    #: existed keep working.
    #:
    #: Trusting the client here is safe: a wrong value checks the wrong
    #: pool, which fails. No claimed purpose can make an incorrect code
    #: verify, and a correct code is still spent by exactly one pool.
    purpose: str = "login"

class SetPasswordRequest(BaseModel):
    password: str
    #: §200 — proof the caller still holds the current second factor.
    #:
    #: Required only when the account ALREADY has a password, i.e. this is a
    #: change rather than a first set. A first set has nothing to protect (the
    #: account has no password to be stolen with) and happens inside the
    #: onboarding gate, where demanding a factor the user may not have would
    #: be a dead end.
    #:
    #: For a change, an access token alone must not be enough, for the same
    #: reason §192 gave for disabling 2FA: a stolen session should not be able
    #: to take the account. Checked through the existing
    #: `_second_factor_matches`, so an authenticator code, an emailed 2FA code
    #: and a backup code all work — and so a user with no second factor
    #: enrolled is not asked for one, because there is nothing they could
    #: possibly present.
    reauth_code: Optional[str] = None

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
