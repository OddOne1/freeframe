from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import Optional
import uuid
import secrets
from datetime import datetime, timedelta, timezone
from ..database import get_db
from ..config import settings
from ..schemas.auth import (
    RegisterRequest, LoginRequest, TokenResponse,
    RefreshRequest, UserResponse, InviteRequest,
    SendMagicCodeRequest, SendMagicCodeResponse,
    VerifyMagicCodeRequest, SetPasswordRequest, SetPasswordResponse,
    AcceptInviteRequest, InviteInfoResponse,
    LoginResponse, TwoFactorRequiredResponse, TwoFactorVerifyRequest,
    TwoFactorSetupRequest, TwoFactorSetupResponse,
    TwoFactorConfirmRequest, TwoFactorConfirmResponse,
    TwoFactorEmailFallbackResponse,
    TwoFactorReauthRequest, TwoFactorDisableResponse, TwoFactorBackupCodesResponse,
    TwoFactorMethod,
    BackupEmailRequest, BackupEmailResponse, BackupEmailVerifyRequest,
    PasswordPolicyResponse,
)
from ..services.auth_service import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
    create_2fa_pending_token, decode_2fa_pending_token, pending_token_via,
    VIA_PASSWORD, VIA_MAGIC_CODE,
    bump_token_version, token_version_of,
    get_user_by_email, get_user_by_id, split_full_name,
)
from ..services.redis_service import (
    generate_magic_code, store_magic_code, verify_magic_code as redis_verify_magic_code,
    MAGIC_CODE_EXPIRY_SECONDS,
    generate_2fa_email_code, store_2fa_email_code, verify_2fa_email_code,
    has_live_2fa_email_code, TWOFA_EMAIL_CODE_EXPIRY_SECONDS,
    store_2fa_setup_code, verify_2fa_setup_code, has_live_2fa_setup_code,
    clear_2fa_setup_code, TWOFA_ENROL_CODE_EXPIRY_SECONDS,
    store_pending_2fa_setup, read_pending_2fa_setup, clear_pending_2fa_setup,
    generate_password_reset_code, store_password_reset_code,
    verify_password_reset_code,
    generate_backup_email_code, store_backup_email_code,
    verify_backup_email_code, clear_backup_email_code,
    BACKUP_EMAIL_CODE_EXPIRY_SECONDS,
)
from ..services import totp_service
from ..services.password_policy import (
    PasswordPolicyError, describe_policy, validate_password,
    validate_password_for_user,
)
from ..services.site_settings_service import (
    require_2fa_enabled, instance_org_name, passwordless_window_closed,
)
from ..tasks.email_tasks import (
    send_magic_code_email, send_invite_email, send_backup_email_code_email,
    send_security_notice_email,
)
from ..tasks.celery_app import send_task_safe
from ..models.user import User, UserStatus, UserGlobalRole
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.rate_limit import rate_limit

router = APIRouter(prefix="/auth", tags=["auth"])

MAGIC_CODE_EXPIRY_MINUTES = MAGIC_CODE_EXPIRY_SECONDS // 60


def _generate_invite_token() -> str:
    """Generate a secure invite token."""
    return secrets.token_urlsafe(48)


# ── Account security helpers (§200) ─────────────────────────────────────────


def _enforce_password_policy(
    db: Session,
    password: str,
    user: Optional[User],
    *,
    email: Optional[str] = None,
    name: Optional[str] = None,
) -> None:
    """Run services/password_policy over a password, or 400 with the reason.

    ONE wrapper, called by every path that sets a password — set-password,
    accept-invite, register, and routers/setup.py's first superadmin — so the
    rules cannot be enforced in three places and a fourth. The policy module
    itself stays HTTP-free; this is the only place that turns its refusal
    into a status code.

    `user` is None for the two paths where no row exists yet, which is why
    `email`/`name` are separately passable: rule 4 (the password must not
    contain the person's own address or name) can only fire if it is told
    who is registering, and on those paths nobody can look it up.

    The instance name comes from site settings on every call rather than
    being passed in, so a self-hosted install branded "Acme" rejects
    "Acme2026!Secure" without anyone having to remember to wire it through.
    """
    org_name = instance_org_name(db)
    try:
        if user is not None:
            validate_password_for_user(password, user, org_name=org_name)
        else:
            validate_password(password, email=email, name=name, org_name=org_name)
    except PasswordPolicyError as exc:
        # 400, not 422: the body's SHAPE is fine, its content is refused.
        # The reason is shown to the person verbatim — see PasswordPolicyError
        # for why the message lives in Python rather than as a code the
        # browser translates.
        raise HTTPException(status_code=400, detail=exc.reason)


def _require_step_up(db: Session, user: User, code: Optional[str]) -> None:
    """Demand the CURRENT second factor before an account-taking change (§200).

    Applied to the changes that decide who can get into this account from
    here on: changing the password, and pointing password resets at a
    different mailbox. §192 already made the same argument for disabling 2FA
    and regenerating backup codes — a stolen session must not be able to
    strip or redirect the protection that exists because sessions get
    stolen — and these two were simply the paths it had not reached yet.

    Reuses `_second_factor_matches`, the same three-way check the login path
    uses, rather than a second implementation.

    **A user who is not enrolled is not asked.** Not a loophole, a
    consequence: `_second_factor_matches` can only ever accept an
    authenticator code, an emailed 2FA code or a backup code, and an
    unenrolled account has none of the three — so requiring one would not
    add a check, it would remove the ability to change your own password.
    The protection is real for exactly the users who have a second factor,
    which is the set this whole feature is aimed at, and an instance that
    wants it for everybody turns on `require_2fa`.
    """
    if not user.two_factor_enabled:
        return
    if not code or not _second_factor_matches(db, user, code):
        # The same undifferentiated message every other 2FA failure uses —
        # which factor was wrong is not the caller's business.
        raise HTTPException(status_code=401, detail="Invalid code")


def _notify_both_addresses(user: User, action: str, subject: str) -> None:
    """Tell the login address AND the backup address that something changed.

    Both, always, and that is the point rather than thoroughness for its own
    sake: an attacker who has taken one of the two mailboxes would otherwise
    receive the warning about their own action and the owner would never see
    it. Sending to both means taking one mailbox is no longer enough to also
    suppress the alarm.

    Best-effort, like every other mail in this router: the change has already
    been committed, and a broker that is briefly down must not turn a
    successful password change into a 500 that tells the user it failed.
    """
    recipients = [user.email]
    if user.backup_email and user.backup_email.lower() != (user.email or "").lower():
        recipients.append(user.backup_email)
    for address in recipients:
        try:
            send_task_safe(
                send_security_notice_email,
                address,
                action,
                subject,
                user.email,
                settings.frontend_url + "/settings/contact",
            )
        except Exception:
            pass


def _same_domain(a: Optional[str], b: Optional[str]) -> bool:
    """Whether two addresses live on the same mail domain.

    Used for a warning, never for a refusal — see BackupEmailResponse's
    `same_domain` for why that line is drawn there.
    """
    if not a or not b or "@" not in a or "@" not in b:
        return False
    return a.rsplit("@", 1)[-1].lower() == b.rsplit("@", 1)[-1].lower()


def _send_backup_email_code(user: User, address: str, org_name: str) -> bool:
    """Mail a verification code to a candidate backup address.

    Always sends. Unlike `_send_2fa_email_code`'s idempotency window, there
    is no automatic caller here — every send is a deliberate user action
    (proposing an address, or pressing resend because nothing arrived), and
    the rate limit on those endpoints is what bounds the volume. Skipping a
    send the user explicitly asked for would leave them staring at an inbox.
    """
    code = generate_backup_email_code()
    store_backup_email_code(address, code)
    send_task_safe(
        send_backup_email_code_email,
        address,
        code,
        BACKUP_EMAIL_CODE_EXPIRY_SECONDS // 60,
        user.email,
        org_name,
    )
    return True


@router.post("/send-magic-code", response_model=SendMagicCodeResponse, dependencies=[Depends(rate_limit("send_magic_code", 5, 600))])
def send_magic_code(body: SendMagicCodeRequest, db: Session = Depends(get_db)):
    """
    Send magic code to email.
    - If user exists: send code for login
    - If user doesn't exist: create pending user and send code

    §195 — both of those stop once 2FA is required instance-wide. A magic
    code is a COMPLETE primary credential (§193's finding), so an instance
    that has decided every sign-in needs two factors cannot also offer a
    one-step sign-in that starts from reading an email. The self-registration
    half goes with it: this endpoint creating a `pending_verification` user
    for any address that asks is a way in that no invite and no admin
    approved, and it is reachable by anyone who can load the login page.

    `password_reset` is deliberately exempt, and that is not a loophole —
    it is the recovery path. Magic-code login has always worked without a
    password, so this instance has users whose `password_hash` is NULL;
    closing the reset purpose too would lock them out permanently with no
    way back in. A reset still lands in §193's 2FA gate on the way through,
    so it grants nothing on its own.
    """
    if body.purpose != "password_reset" and require_2fa_enabled(db):
        # Refused before the user lookup, before any write, and before
        # Redis: the security property is that nothing happens, and a check
        # placed after the lookup would invite a later edit to slip a write
        # in above it.
        #
        # An error rather than today's cheerful success message. A 200 with
        # "a code has been sent" would leave a legitimate user watching an
        # inbox that never fills, and any client that reads the status
        # rather than the message string would report success for a request
        # that did nothing.
        #
        # The same message either way, existing account or not, so it says
        # nothing about the address — only about the instance, which
        # GET /site-settings already publishes anonymously in `require_2fa`.
        # That is a policy disclosure, not the account-enumeration risk the
        # password_reset branch below is written to avoid.
        raise HTTPException(
            status_code=403,
            detail=(
                "Magic-code sign-in is disabled on this instance. "
                "Sign in with your email and password."
            ),
        )

    user = get_user_by_email(db, body.email)

    if not user:
        if body.purpose == "password_reset":
            # Don't reveal whether this email has an account, and don't
            # create a phantom pending user for a reset that can never
            # complete.
            return SendMagicCodeResponse(
                message="If that email has an account, a code has been sent",
                email=body.email,
            )
        # Check if this is the first user (becomes super admin)
        user_count = db.query(User).filter(User.deleted_at.is_(None)).count()
        is_first_user = user_count == 0

        # Create new user in pending_verification status
        user = User(
            email=body.email,
            last_name=body.email.split("@")[0],
            status=UserStatus.pending_verification,
            email_verified=False,
            role=UserGlobalRole.superadmin if is_first_user else UserGlobalRole.user,
        )
        db.add(user)
        db.commit()
        
    # §197 — a reset code goes into its own pool, never the login one. They
    # shared `magic_code:{email}` and an unconditional setex, so asking for
    # one destroyed the other; and since §195 they are not even subject to
    # the same policy, which is what made one shared slot untenable rather
    # than merely untidy.
    if body.purpose == "password_reset":
        code = generate_password_reset_code()
        store_password_reset_code(body.email, code)
    else:
        code = generate_magic_code()
        store_magic_code(body.email, code)

    # §200 — THE CHANNEL SPLIT. A reset code goes to the BACKUP address and
    # nowhere else; everything else goes to the login address.
    #
    # This one line is the whole point of §200. Until it, one mailbox was the
    # entire account: request a reset, set a new password, then read the 2FA
    # code out of that same inbox. Two factors, one channel, and the second
    # one bought nothing.
    #
    # **No fallback to `email` when there is no verified backup address.**
    # That is not an oversight and it is the rule that makes the split real —
    # a fallback would restore the exact behaviour above for every account
    # that has not finished the gate, which on day one is all of them. What
    # happens instead is that no mail is sent and the caller gets the same
    # neutral message it already gets for an address with no account, so this
    # still says nothing about who exists.
    #
    # The Redis pool stays keyed on the LOGIN address regardless of where the
    # mail went, because /auth/verify-magic-code is given the login address
    # and has no way to know the backup one. Keying it on the destination
    # would mean the verify step could not find the code it just issued.
    #
    # The cost is real and worth stating: a user who has a password, has not
    # finished the gate, and forgets that password cannot reset it themselves
    # until a superadmin helps. That is why the escape hatches in
    # routers/admin.py and scripts/clear_account_gate.py exist, and why the
    # gate is placed in front of the app rather than left as a reminder.
    destination = body.email
    if body.purpose == "password_reset":
        if not (user.backup_email and user.backup_email_verified_at):
            return SendMagicCodeResponse(
                message="If that email has an account, a code has been sent",
                email=body.email,
            )
        destination = user.backup_email

    # Queue email via Celery (async)
    try:
        contact_url = settings.frontend_url + "/settings/contact"
        send_task_safe(send_magic_code_email, destination, code, MAGIC_CODE_EXPIRY_MINUTES, body.purpose, contact_url)
    except Exception:
        pass  # Email delivery is best-effort; code is already in Redis

    return SendMagicCodeResponse(
        message="Magic code sent to your email",
        email=body.email,
    )
@router.post("/verify-magic-code", response_model=LoginResponse, dependencies=[Depends(rate_limit("verify_magic_code", 10, 600))])
def verify_magic_code(body: VerifyMagicCodeRequest, db: Session = Depends(get_db)):
    """
    Verify magic code and return tokens.
    Returns needs_password=True if user hasn't set a password yet.
    """
    user = get_user_by_email(db, body.email)
    
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    if user.status == UserStatus.deactivated:
        raise HTTPException(status_code=401, detail="Account deactivated")
    
    # §197 — checks the pool matching the stated purpose. Trusting the
    # client's claim is safe because it can only ever LOSE: naming the wrong
    # pool means checking a code that is not there, which fails. There is no
    # purpose a caller can claim that makes a wrong code verify.
    if body.purpose == "password_reset":
        success, error = verify_password_reset_code(body.email, body.code)
    else:
        success, error = redis_verify_magic_code(body.email, body.code)
    if not success:
        raise HTTPException(status_code=401, detail=error)

    # §200 — the end of the migration window, for passwordless accounts only.
    #
    # Every account is supposed to have a password now. Accounts that never
    # had one keep signing in with a magic code for a grace period (the
    # onboarding gate then makes them set one), and after
    # `site_settings.password_required_after` that route closes for them.
    #
    # Checked AFTER the code is verified, deliberately. Before it, the
    # refusal would be a free oracle: any address could be probed for
    # "exists and has no password" without presenting anything. After it, the
    # caller has already proved they read that mailbox, so the message tells
    # them nothing they did not already have.
    #
    # Scoped to `password_hash is None` and to the login purpose only. A
    # password_reset code is how a passwordless user would be given one by an
    # admin-assisted route, and closing that here would remove the last way
    # back in rather than the shortcut it is meant to remove.
    if (
        body.purpose != "password_reset"
        and user.password_hash is None
        and passwordless_window_closed(db)
    ):
        raise HTTPException(
            status_code=403,
            detail=(
                "This account has no password, and code-only sign-in has "
                "closed on this instance. Ask an administrator to set one up "
                "for you."
            ),
        )
    
    # Mark email as verified
    user.email_verified = True
    
    # If user was pending verification, activate them
    if user.status == UserStatus.pending_verification:
        user.status = UserStatus.active
    
    db.commit()

    # §193 — a correct magic code is a COMPLETE primary credential, not a
    # second factor, so it lands in the same gate a correct password does.
    # Until this, an enrolled user was fully authenticated by anyone who
    # could read one email — which defeats 2FA against precisely the threat
    # it is usually deployed for.
    #
    # Everything above still runs regardless of what this returns: the code
    # was genuinely correct, so the email IS verified and a
    # pending_verification account IS activated. Those are facts about the
    # address, not grants of access.
    #
    # `needs_password` is deliberately no longer computed here. It rides on
    # TokenResponse, which _login_outcome only produces once the second
    # factor is settled — so a caller stopped at the 2FA gate is never told
    # to go and create a password. See test_needs_password_is_deferred.
    #
    # §199 — via=VIA_MAGIC_CODE: this login proved control of the MAILBOX,
    # not knowledge of a password, and what may serve as the second factor
    # depends on that distinction. See _login_outcome.
    return _login_outcome(db, user, via=VIA_MAGIC_CODE)


@router.post("/set-password", response_model=SetPasswordResponse)
def set_password(
    body: SetPasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set password for authenticated user (after magic code verification).

    §199 — a password change ends every other session this user holds. That
    is the single most expected thing about changing a password and it did
    not happen before: a stolen laptop with a live session survived it, and
    kept renewing itself for the whole refresh window.

    The caller's OWN session is the one exception, and it is handled by
    returning a fresh pair rather than by carving out an exception in the
    bump — the device you are typing on should not be signed out by the act
    of securing the account. See SetPasswordResponse for why the fields go
    here rather than into a wrapper.
    """
    # §200 — a CHANGE needs the second factor; a first set does not.
    #
    # `password_hash is None` is the whole distinction and it is the honest
    # one: an account with no password has nothing a stolen session could
    # take by changing it, and this is the path the onboarding gate itself
    # runs on — demanding a factor there would make the gate unsatisfiable
    # for everyone it exists to onboard.
    #
    # Read BEFORE the write, obviously, but worth saying: after the
    # assignment below every call would look like a first set.
    is_change = current_user.password_hash is not None
    if is_change:
        _require_step_up(db, current_user, body.reauth_code)

    _enforce_password_policy(db, body.password, current_user)

    current_user.password_hash = hash_password(body.password)
    bump_token_version(current_user)
    db.commit()
    db.refresh(current_user)
    # §200 — told to BOTH addresses, after the commit. A password change the
    # owner did not make is the thing they most need to hear about, and
    # sending it only to the login address would mean an attacker who already
    # controls that mailbox gets to read the warning instead of the owner.
    if is_change:
        _notify_both_addresses(
            current_user,
            "password_changed",
            "Your FreeFrame password was changed",
        )
    # Minted AFTER the commit and refresh, so they carry the version that is
    # actually on the row — not the one this request read on the way in.
    tokens = _issue_tokens(current_user)
    return SetPasswordResponse(
        **UserResponse.model_validate(current_user).model_dump(),
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
    )


@router.get("/invite/{token}", response_model=InviteInfoResponse)
def get_invite_info(token: str, db: Session = Depends(get_db)):
    """Get info about an invite token (for the set-password screen)."""
    user = db.query(User).filter(
        User.invite_token == token,
        User.deleted_at.is_(None),
    ).first()
    
    if not user:
        raise HTTPException(status_code=404, detail="Invalid invite link")
    
    if user.invite_token_expires_at and user.invite_token_expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invite link expired")
    
    return InviteInfoResponse(
        email=user.email,
        name=user.name,
        # §199 — the response model has always carried this field and the
        # endpoint never filled it, so `components/auth/invite-accept.tsx`
        # rendered an empty line where the instance name belongs: "You've
        # been invited to" followed by nothing.
        #
        # The same source /auth/2fa/setup already uses for the authenticator
        # issuer, so a self-hosted install branded as something else says the
        # same thing in both places rather than "FreeFrame" in one of them.
        org_name=instance_org_name(db),
    )


@router.post("/accept-invite", response_model=TokenResponse)
def accept_invite(body: AcceptInviteRequest, db: Session = Depends(get_db)):
    """Accept invite and set password. Email is already verified via invite."""
    user = db.query(User).filter(
        User.invite_token == body.token,
        User.deleted_at.is_(None),
    ).first()
    
    if not user:
        raise HTTPException(status_code=404, detail="Invalid invite link")
    
    if user.invite_token_expires_at and user.invite_token_expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invite link expired")
    
    # §200 — the same policy every other password path enforces. An invite
    # was the easiest way in with a two-character password before this: the
    # browser's `length < 8` check was the only rule, and nothing stopped a
    # caller from skipping the browser.
    _enforce_password_policy(db, body.password, user)

    # Set password and activate user
    user.password_hash = hash_password(body.password)
    user.email_verified = True  # Invited users are pre-verified
    user.status = UserStatus.active
    user.invite_token = None
    user.invite_token_expires_at = None
    # §199 — this sets a password for the first time, and "a password was set
    # or changed" is the simpler rule to state and to verify than one with a
    # carve-out. There is no prior session to invalidate here (the account
    # was pending_invite until this line), so in practice this is
    # consistency rather than necessity.
    bump_token_version(user)
    db.commit()

    return _issue_tokens(user)


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    """Register with email + password (legacy, prefer magic code flow)."""
    if get_user_by_email(db, body.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    first_name, last_name = split_full_name(body.name)
    # §200 — validated against the address and name being registered, since
    # there is no row yet to read them off.
    _enforce_password_policy(
        db, body.password, None, email=body.email, name=body.name
    )
    user = User(
        email=body.email,
        first_name=first_name,
        last_name=last_name,
        password_hash=hash_password(body.password),
        status=UserStatus.active,
        email_verified=False,  # Not verified until magic code
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=LoginResponse)
def login(body: LoginRequest, db: Session = Depends(get_db)):
    """Login with email + password.

    §191 — the password check below is UNCHANGED. What changed is what
    happens after it succeeds, and there are three outcomes:

      no enforcement, user not enrolled  -> full tokens, exactly as before
      user enrolled (whatever the site says) -> pending token, ask for a code
      enforcement on, user not enrolled  -> pending token, force enrolment

    The first case is the one that matters most on an existing install:
    until an admin turns `require_2fa` on, and for every user who has not
    opted in, this endpoint behaves identically to how it did before this
    feature existed. That is regression-tested, not assumed.

    A user who HAS enrolled is asked for a code even when the site-wide
    setting is off — turning the instance-wide requirement off must not
    silently downgrade someone who chose 2FA for themselves.
    """
    user = get_user_by_email(db, body.email)
    if (
        not user
        or not user.password_hash
        or not verify_password(body.password, user.password_hash)
        or user.status == UserStatus.deactivated
    ):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    # §193 — shared with /auth/verify-magic-code, which is the same login
    # screen's other half. See _login_outcome.
    return _login_outcome(db, user)


# ── Two-factor authentication (§191) ────────────────────────────────────────


def _user_from_pending(db: Session, pending_token: str) -> User:
    """The user behind a pending token, or 401.

    Rejects an access or refresh token passed here — without that check a
    real access token would satisfy the second factor for a login it was
    never part of.
    """
    user_id = decode_2fa_pending_token(pending_token)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    try:
        user = get_user_by_id(db, uuid.UUID(user_id))
    except (ValueError, TypeError):
        user = None
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return user


def _issue_tokens(user: User) -> TokenResponse:
    """A fresh pair stamped with this user's CURRENT token_version (§199).

    Read at mint time rather than passed in, so a caller that has just
    bumped the version cannot forget to hand over the new one — which would
    issue a pair that is already stale.
    """
    version = user.token_version or 0
    return TokenResponse(
        access_token=create_access_token(str(user.id), version),
        refresh_token=create_refresh_token(str(user.id), version),
        needs_password=user.password_hash is None,
    )


def _login_outcome(db: Session, user: User, *, via: str = VIA_PASSWORD) -> LoginResponse:
    """What a successful primary-credential check leads to (§193).

    ONE implementation, called by BOTH login paths. The password check in
    /auth/login and the magic-code check in /auth/verify-magic-code are two
    complete ways into the same account — the same login screen offers them
    as "email + code" and "sign in with password instead" — so whatever one
    concludes about a second factor, the other has to conclude identically.

    Shared rather than copied on purpose. Two copies that agree today are
    the shape this codebase keeps getting bitten by; §190 found the same
    byte-formatting rule written four separate times, each wrong the same
    way, before it was fixed once. A second copy here would be worse than
    wrong output: it would be a login path that silently stops asking for a
    second factor.

    The three outcomes:
      user enrolled                     -> pending token, ask for a code
      enforcement on, user not enrolled -> pending token, force enrolment
      neither                           -> real tokens, exactly as before

    An enrolled user is asked even when the instance-wide setting is off:
    turning the requirement off must not silently downgrade someone who
    chose 2FA for themselves.

    §199 — `via` says WHICH primary credential got here, and it is not
    decoration: it rides into the pending token so every later step of this
    login can tell a password from a magic code. See VIA_PASSWORD in
    services/auth_service.py for why that difference matters.
    """
    if user.two_factor_enabled:
        method: TwoFactorMethod = user.two_factor_method or "totp"
        # §194 — for an email-primary user the code is sent HERE, without
        # waiting for them to ask.
        #
        # The asymmetry with the fallback flow is deliberate. A TOTP user
        # clicking "email me a code instead" is making a claim — "I have
        # lost my authenticator" — which is unusual enough to be worth a
        # deliberate action. An email-primary user has nothing to claim:
        # email IS their factor, so requiring a click before sending the
        # thing they are waiting for would be a pointless step on every
        # single login.
        #
        # Idempotent per TTL window (see _send_2fa_email_code), so repeated
        # hits on the gate neither spam the inbox nor invalidate a code the
        # person is already reading.
        #
        # §199 — NOT sent when the primary credential was itself a magic
        # code: that code came out of the same inbox, so mailing a second
        # one there proves nothing new and turns two factors into one
        # channel. Such a user completes with their authenticator or a
        # backup code — which is exactly what backup codes are for — or
        # signs in with their password instead.
        email_factor_allowed = via != VIA_MAGIC_CODE
        sent = (
            _send_2fa_email_code(user)
            if method == "email" and email_factor_allowed
            else False
        )
        return TwoFactorRequiredResponse(
            setup_required=False,
            pending_token=create_2fa_pending_token(str(user.id), via=via),
            method=method,
            email_code_sent=sent,
        )

    if require_2fa_enabled(db):
        # Enrolment is forced, not refused: locking out everyone the moment
        # an admin flips the switch would make the switch unusable.
        # No `method`: the user has not chosen one, and choosing is what the
        # enrolment screen exists for.
        return TwoFactorRequiredResponse(
            setup_required=True,
            pending_token=create_2fa_pending_token(str(user.id), via=via),
        )

    return _issue_tokens(user)


def _send_2fa_email_code(
    user: User, *, purpose: str = "two_factor_challenge", force: bool = False
) -> bool:
    """Mail this user a one-time code. Returns whether one was sent (§194).

    §203 — `purpose` names the SITUATION, not the mechanism. This one function
    serves three of them, and they need different words:

      _login_outcome            an email-primary user is finishing a sign-in
      send_two_factor_email_fallback  they have lost their authenticator
      setup_two_factor          they are switching two-factor ON, from
                                Settings, already signed in

    The first two are the same message to the reader ("finish signing in"), so
    they share `two_factor_challenge`. The third is its opposite: nobody is
    signing in, and the mail that told them to was not merely clumsy — its
    warning ("if you did not try to sign in, someone has your password") is
    false for enrolment, where the real danger is that somebody is ALREADY
    signed in as them.

    Same Redis pool, same TTL, same rate-limit buckets, same idempotency and
    `force` semantics. Only the wording changes; see MAIL_CODE_COPY in
    tasks/email_tasks.py.

    Extracted from the HTTP endpoint so login can call it directly — the
    endpoint carries a rate-limit dependency and a request object that a
    server-side call has neither of, and reaching into it would mean
    fabricating both.

    `force=False` skips the send when an unexpired code is already
    outstanding. That is the default because this is called automatically
    for an email-primary user at every login: without it, two page loads
    would mail two codes and the second would silently invalidate the first
    one already sitting in the person's inbox. The explicit "send me a code"
    endpoint passes force=True, because there the user is telling us the
    code did not arrive.
    """
    # §204 — the enrolment code lives in its OWN pool, and this is the only
    # place that decides which. One branch rather than two functions: the
    # idempotency rule, the `force` rule and the send are identical, and a
    # second copy of them is how one would quietly stop honouring `force`.
    #
    # The separation is what makes §203's sentence — "this code cannot be
    # used to sign in" — actually true. `_second_factor_matches` reads the
    # challenge pool and only that pool, so it can no longer see a setup
    # code at all. It is deliberately NOT changed; see its docstring.
    #
    # Per-pool windows also fix the two symptoms that made this visible: a
    # live challenge code no longer suppresses an enrolment send, and an
    # enrolment code no longer suppresses a challenge.
    is_setup = purpose == "two_factor_setup"
    has_live = has_live_2fa_setup_code if is_setup else has_live_2fa_email_code
    store = store_2fa_setup_code if is_setup else store_2fa_email_code
    expiry_seconds = (
        TWOFA_ENROL_CODE_EXPIRY_SECONDS if is_setup else TWOFA_EMAIL_CODE_EXPIRY_SECONDS
    )

    if not force and has_live(user.email):
        return False

    code = generate_2fa_email_code()
    store(user.email, code)
    send_task_safe(
        send_magic_code_email,
        user.email,
        code,
        expiry_seconds // 60,
        purpose,
    )
    return True


def _second_factor_matches(
    db: Session, user: User, code: str, *, allow_email_factor: bool = True
) -> bool:
    """Whether `code` satisfies the second factor, by ANY of its three forms.

    Tried in order — authenticator, emailed fallback, backup code — because
    the user does not reliably know which kind they are holding, and making
    the client declare it would fail correct codes over a wrong guess.

    A spent backup code is persisted here rather than by the caller: it is
    single-use, and a path that verified without consuming would turn a
    recovery code into a permanent password.

    §199 — `allow_email_factor=False` drops the emailed form for a login
    whose PRIMARY credential was itself a magic code. Refusing to send a
    code on that path is most of the fix, but not all of it: an emailed 2FA
    code from a recent password login stays live for its whole TTL window,
    and without this an attacker holding only the mailbox could sign in with
    a magic code and redeem that still-valid code as the second factor.
    Default True, so the authenticated re-auth callers (§192's disable and
    regenerate, §194b's replacement gate) are untouched — they have a
    session, not a pending token, and no primary credential in question.
    """
    secret = totp_service.decrypt_secret(user.totp_secret_encrypted)
    if totp_service.verify_totp_code(secret, code):
        return True

    if allow_email_factor:
        ok, _ = verify_2fa_email_code(user.email, code.strip())
        if ok:
            return True

    matched, remaining = totp_service.consume_backup_code(user.backup_codes_hashed, code)
    if matched:
        user.backup_codes_hashed = remaining
        db.commit()
        return True

    return False


@router.post(
    "/2fa/verify-login",
    response_model=TokenResponse,
    dependencies=[Depends(rate_limit("verify_2fa", 10, 600))],
)
def verify_two_factor_login(body: TwoFactorVerifyRequest, db: Session = Depends(get_db)):
    """Complete a login that stopped at the second factor."""
    user = _user_from_pending(db, body.pending_token)

    if not user.two_factor_enabled:
        # A pending token issued for FORCED SETUP cannot be redeemed here —
        # that path has to go through confirm-setup, which is what actually
        # enrols them. Otherwise "enforcement on" would be satisfiable by
        # anyone who never enrolled.
        raise HTTPException(status_code=401, detail="Invalid code")

    # §199 — an emailed code cannot complete a login that started with a
    # magic code; see _second_factor_matches. TOTP and backup codes are
    # unaffected on that path, and a password login is unaffected entirely.
    email_factor_allowed = pending_token_via(body.pending_token) != VIA_MAGIC_CODE

    if not _second_factor_matches(
        db, user, body.code, allow_email_factor=email_factor_allowed
    ):
        # One message for every failure: which factor was wrong is not the
        # caller's business, and saying so would confirm whether a fallback
        # code had been requested.
        raise HTTPException(status_code=401, detail="Invalid code")

    return _issue_tokens(user)


@router.post("/2fa/setup", response_model=TwoFactorSetupResponse)
def setup_two_factor(
    body: Optional[TwoFactorSetupRequest] = None,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Begin enrolment. Does NOT enable 2FA.

    Reachable two ways, because enrolment happens in two situations: during
    a forced first login (pending token, no session yet) and from settings
    by someone already signed in (session, no pending token). Both land
    here rather than in two near-identical endpoints.

    The generated secret is staged encrypted, under a short TTL, and
    `two_factor_enabled` is not touched here at all. Staging it is what lets
    confirm-setup verify against the same secret the QR code showed;
    promoting nothing until confirm succeeds is what stops an abandoned
    setup from locking the user out of their own account.

    Both paths stage — the first enrolment as well as a replacement —
    although only the replacement has live state to protect. One path is
    the point: if confirm had to decide whether to read the candidate from
    Redis or from the row, that decision would be the whole bug again,
    just moved. Writing directly to an unenrolled row is not unsafe, it is
    merely the last place still doing the thing this change exists to stop.
    The cost is that a Redis loss between setup and confirm makes the user
    start setup again — a clean 400 within a ten-minute window, in a flow
    that already depends on Redis for the emailed code and the rate limits.

    §194 — `method` picks which factor is being enrolled. confirm-setup has
    to know which kind of code it is checking, and the alternative — the
    client naming the method again at confirm — would let the two halves of
    one enrolment disagree about what was enrolled. So the choice travels
    with the staged setup (§194b) rather than being re-declared later.

    §194b — this endpoint no longer writes to the user row at all. It used
    to store the new secret and method immediately, which meant a single
    call from an ALREADY-ENROLLED user destroyed the factor they were
    actually using, before anything had proved the replacement worked:
    `two_factor_enabled` stayed True throughout, so the account remained
    gated on a factor nobody had ever confirmed. Now the candidate is
    staged in Redis and promoted only by a successful confirm.
    """
    user = current_user
    if user is None:
        if not body or not body.pending_token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        user = _user_from_pending(db, body.pending_token)

    method: TwoFactorMethod = body.method if body else "totp"

    # §199 — the same rule as /2fa/send-email-fallback, applied one step
    # earlier. A user being forced into enrolment mid-login who got here WITH
    # A MAGIC CODE must not enrol email as their second factor: they would
    # finish the very next step by reading a confirmation code out of the
    # mailbox that was already their first factor, and the account would be
    # protected by one channel from then on. `current_user is None` is what
    # identifies the mid-login case — a signed-in user choosing email in
    # settings is a different situation and is left alone.
    if (
        method == "email"
        and current_user is None
        and pending_token_via(body.pending_token) == VIA_MAGIC_CODE
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "You signed in with an emailed code, so email cannot also be "
                "your second factor. Set up an authenticator app, or sign in "
                "with your password to choose email."
            ),
        )

    if user.two_factor_enabled:
        # §194b — replacing a live second factor is the same class of action
        # as removing one: it decides what "a valid second factor" means for
        # this account from here on. §192 already refuses removal on a bearer
        # token alone, for the reason written into TwoFactorReauthRequest —
        # a stolen session must not be able to strip the protection that
        # exists because sessions get stolen. Starting a replacement was the
        # one path still doing it for free, and it is the more dangerous of
        # the two: it locks the owner out rather than merely letting them in.
        #
        # Gated on the user's STATE, not on how they reached this endpoint.
        # An enrolled user holding a mid-login pending token is asked for the
        # same proof a signed-in one is, so the pending token is not a way
        # around the gate — and they can always produce it, being mid-login
        # on that very factor.
        #
        # The same undifferentiated message every other 2FA failure uses.
        if (
            not body
            or not body.reauth_code
            or not _second_factor_matches(db, user, body.reauth_code)
        ):
            raise HTTPException(status_code=401, detail="Invalid code")

    if method == "email":
        # No secret is generated: an email enrolment has nothing to scan and
        # nothing to keep. Any secret already on the row is left untouched —
        # it may still be this user's LIVE second factor, and this setup can
        # still be abandoned. Confirm clears it, at the one moment the new
        # enrolment actually takes effect.
        store_pending_2fa_setup(str(user.id), "email", None)
        # Not forced: this endpoint has no rate-limit bucket of its own, and
        # the idempotency window is what bounds how much mail repeated calls
        # can send. A code already in the inbox still works, so re-sending
        # would only invalidate the one the user is reading.
        return TwoFactorSetupResponse(
            method="email",
            # §203 — the ENROLMENT wording. This is the call site Mathias hit:
            # signed in, in Settings, turning the feature on, and told by the
            # mail to sign in with the code.
            email_code_sent=_send_2fa_email_code(user, purpose="two_factor_setup"),
        )

    secret = totp_service.generate_totp_secret()
    # Staged encrypted, in the same form the column holds, so promotion at
    # confirm is a copy rather than a re-encryption.
    store_pending_2fa_setup(str(user.id), "totp", totp_service.encrypt_secret(secret))

    uri = totp_service.totp_provisioning_uri(
        secret, user.email, issuer=instance_org_name(db)
    )
    return TwoFactorSetupResponse(
        method="totp",
        provisioning_uri=uri,
        qr_code_data_uri=totp_service.qr_code_data_uri(uri),
        secret=secret,
    )


@router.post("/2fa/confirm-setup", response_model=TwoFactorConfirmResponse)
def confirm_two_factor_setup(
    body: TwoFactorConfirmRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Finish enrolment: prove the chosen factor works, then switch it on.

    §194 — "the chosen factor" rather than "the authenticator": for an email
    enrolment the proof is the code that was just mailed, which is the same
    kind of evidence a TOTP code is — that the thing the user will be asked
    for at every future login actually reaches them.

    Returns the backup codes once, in plaintext. They are bcrypt-hashed
    server-side and nothing can read them back — losing this response means
    regenerating them (a §192 concern), not recovering them.
    """
    user = current_user
    forced_first_login = False
    if user is None:
        if not body.pending_token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        user = _user_from_pending(db, body.pending_token)
        forced_first_login = True

    # §194b — the candidate this confirms is the one setup staged, never the
    # live row: the live row still holds whatever factor is currently in
    # use, and reading the method or the secret from it is what made a
    # re-enrolment destructive before it was confirmed.
    #
    # Nothing staged means setup was never started, or the window expired.
    # Both are the same instruction to the caller, and the same 400 this
    # endpoint has always answered when there was nothing to confirm.
    staged = read_pending_2fa_setup(str(user.id))
    if not staged:
        raise HTTPException(status_code=400, detail="Start setup again")

    method: TwoFactorMethod = staged["method"]

    if method == "email":
        # Only the code just mailed counts. A backup code would prove
        # nothing about whether mail actually reaches this address, which is
        # the single thing this step exists to check — the same rule the
        # TOTP branch applies to its own factor.
        #
        # §204 — the ENROLMENT pool, and only that one. The mirror of the
        # rule §204 exists for: a setup code cannot complete a login, and a
        # login-challenge code cannot complete an enrolment. Reading both
        # here would leave half the separation in place, which is the same
        # as none.
        ok, _ = verify_2fa_setup_code(user.email, body.code.strip())
        if not ok:
            raise HTTPException(status_code=401, detail="Invalid code")
        # An authenticator paired during some earlier, abandoned setup must
        # not stay a way in for a user whose second factor is now email:
        # `_second_factor_matches` tries TOTP first and would keep accepting
        # a secret nobody remembers agreeing to.
        user.totp_secret_encrypted = None
    else:
        secret = totp_service.decrypt_secret(staged.get("secret"))
        if not secret:
            raise HTTPException(status_code=400, detail="Start setup again")

        # Only the authenticator counts here. An emailed fallback or a backup
        # code proves nothing about whether the app the user just configured
        # actually works, which is the single thing this step exists to check.
        if not totp_service.verify_totp_code(secret, body.code):
            raise HTTPException(status_code=401, detail="Invalid code")

        # Promoted only now — the first moment this authenticator is known
        # to work. Until this line the user's previous secret, if any, is
        # still the one the account answers to.
        user.totp_secret_encrypted = staged["secret"]

    codes = totp_service.generate_backup_codes()
    user.backup_codes_hashed = totp_service.hash_backup_codes(codes)
    user.two_factor_enabled = True
    user.two_factor_method = method
    # §199 — one bump covers both things this function does: a first
    # enrolment and a method change through re-enrolment. Either one changes
    # what a second factor means for this account from here on, so sessions
    # opened under the old arrangement should not survive it.
    bump_token_version(user)
    db.commit()
    # After the commit, not before: a staged setup dropped ahead of a write
    # that then failed would leave the user with nothing to confirm and no
    # way to finish. A stale one costs nothing — it expires on its own, and
    # a later setup replaces it.
    clear_pending_2fa_setup(str(user.id))
    # §204 — and any outstanding ENROLMENT code, for either method. The
    # email branch consumed its own on the way in; a TOTP confirm can land
    # while a code from an earlier, abandoned email attempt is still live,
    # and a code whose enrolment is already finished should not sit in the
    # pool waiting for a screen that has moved on.
    #
    # The CHALLENGE pool is deliberately untouched here: a code the user is
    # mid-login with is not this endpoint's to spend.
    clear_2fa_setup_code(user.email)

    return TwoFactorConfirmResponse(
        backup_codes=codes,
        method=method,
        # §199 — now populated for BOTH branches, not only the forced login.
        # The old comment ("an already-signed-in user holds working tokens
        # already") stopped being true the moment the bump above landed:
        # that user's tokens were minted under the previous version and are
        # stale as of this commit. They get a matching pair here for the same
        # reason the forced-login branch always did.
        tokens=_issue_tokens(user),
    )


@router.post(
    "/2fa/send-email-fallback",
    response_model=TwoFactorEmailFallbackResponse,
    # Its OWN bucket, not send_magic_code's. A 2FA-locked-out user hammering
    # this is a different risk from someone requesting passwordless login,
    # and a shared bucket would let either drain the other's allowance.
    dependencies=[Depends(rate_limit("send_2fa_email_fallback", 3, 600))],
)
def send_two_factor_email_fallback(
    body: TwoFactorSetupRequest,
    db: Session = Depends(get_db),
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Email a one-time code to someone who has lost their authenticator.

    §192 — reachable two ways, like /auth/2fa/setup: mid-login with a
    pending token, and from a SESSION with none.

    The authenticated case is not hypothetical. §192's self-service disable
    and regenerate both accept an emailed fallback as their re-auth proof,
    and an authenticated user has no pending token — so without this branch
    that proof would be listed as acceptable and be impossible to obtain.
    The verification half already worked unchanged, because
    `verify_2fa_email_code` is keyed by EMAIL rather than by token; it was
    only the sending half that was gated behind a token the caller does not
    have. Traced rather than assumed, and the asymmetry is what made it
    worth tracing.

    One rate-limit bucket for both, deliberately: it is the same operation
    with the same abuse profile, and splitting it would give an attacker two
    allowances for one thing.
    """
    user = current_user
    if user is None:
        user = _user_from_pending(db, body.pending_token)

        # §199 — the mid-login case is the one that can collapse two factors
        # into one. A caller who reached the gate WITH A MAGIC CODE has
        # already proved control of this mailbox; mailing them the second
        # factor there proves nothing further, and whoever can read the inbox
        # then holds both halves of the login.
        #
        # Refused explicitly rather than silently dropped, unlike the
        # not-enrolled case below: the caller holds a valid pending token for
        # this very account, so there is nothing left to enumerate, and a
        # cheerful 200 would leave a legitimate user watching an inbox that
        # will never fill. They complete with their authenticator or a backup
        # code, or sign in with their password instead — both are named in
        # the message, because a dead end the user cannot get out of is worse
        # than the risk it avoids.
        if pending_token_via(body.pending_token) == VIA_MAGIC_CODE:
            raise HTTPException(
                status_code=403,
                detail=(
                    "You signed in with an emailed code, so a second emailed "
                    "code would not be a second factor. Use your authenticator "
                    "app or a backup code, or sign in with your password."
                ),
            )

    if user.two_factor_enabled:
        # force=True: reaching this endpoint IS the user saying the code they
        # have did not arrive or no longer works, so the outstanding one is
        # replaced rather than reused. Login's automatic send is the opposite
        # case and is deliberately idempotent (see _send_2fa_email_code).
        _send_2fa_email_code(user, force=True)
    # Falls through with the same response either way: whether this account
    # is enrolled is not something an unauthenticated caller learns here.
    return TwoFactorEmailFallbackResponse()


@router.post("/2fa/disable", response_model=TwoFactorDisableResponse)
def disable_two_factor(
    body: TwoFactorReauthRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Turn your own 2FA off, having proved you still hold a second factor.

    The re-auth is the whole point. Disabling 2FA is the one action that
    removes the protection which exists precisely because sessions get
    stolen, so a valid access token alone must not be enough to do it —
    otherwise the feature protects everything except its own off switch.

    Reuses `_second_factor_matches`, the same three-way check
    /auth/2fa/verify-login uses, rather than a second implementation: two
    copies of "what counts as a second factor" is how one of them quietly
    stops accepting backup codes.
    """
    if not current_user.two_factor_enabled:
        # Idempotent rather than an error: the end state the caller asked
        # for is already true, and a 400 here would make a double-click
        # look like a failure.
        return TwoFactorDisableResponse(two_factor_enabled=False)

    if not _second_factor_matches(db, current_user, body.code):
        raise HTTPException(status_code=401, detail="Invalid code")

    # All three, not just the flag. A secret left behind would be re-enabled
    # by a later `two_factor_enabled = True` with the OLD authenticator still
    # paired — and stale backup codes would outlive the enrolment they were
    # issued for.
    current_user.two_factor_enabled = False
    current_user.totp_secret_encrypted = None
    current_user.backup_codes_hashed = None
    # §194 — the chosen method goes with it. A stale "email" left on a
    # disabled account would make a later re-enrolment look like it had
    # already picked one.
    current_user.two_factor_method = None
    # §199 — removing the protection is exactly the moment other sessions
    # should stop being trusted, not a moment to leave them running.
    bump_token_version(current_user)
    db.commit()
    # §200 — both addresses. Turning 2FA off is the change an attacker who
    # has taken the login mailbox most wants to make quietly, and a notice
    # sent only there is one they would read instead of the owner.
    _notify_both_addresses(
        current_user,
        "two_factor_disabled",
        "Two-factor authentication was turned off on your FreeFrame account",
    )
    return TwoFactorDisableResponse(
        two_factor_enabled=False, tokens=_issue_tokens(current_user)
    )


@router.post("/2fa/regenerate-backup-codes", response_model=TwoFactorBackupCodesResponse)
def regenerate_backup_codes(
    body: TwoFactorReauthRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Replace the backup codes with a fresh set, shown once.

    Same re-auth gate as disable, for the same reason: a stolen session that
    could mint itself ten permanent recovery codes would have turned a
    session into an account.
    """
    if not current_user.two_factor_enabled:
        raise HTTPException(status_code=400, detail="Two-factor authentication is not enabled")

    if not _second_factor_matches(db, current_user, body.code):
        # Nothing is regenerated on a failed attempt — the existing set must
        # survive a wrong guess, or a bad code would be a denial of service
        # against the codes the user still has written down.
        raise HTTPException(status_code=401, detail="Invalid code")

    codes = totp_service.generate_backup_codes()
    # Overwritten, never appended: the previous set stops working here.
    current_user.backup_codes_hashed = totp_service.hash_backup_codes(codes)
    # §199 — the reason to regenerate is that the old set may have been seen
    # by someone else, which is equally a reason not to trust whatever
    # sessions exist under it.
    bump_token_version(current_user)
    db.commit()
    # §200 — both addresses; see disable_two_factor just above. A fresh set
    # of recovery codes issued to somebody else is silent otherwise.
    _notify_both_addresses(
        current_user,
        "backup_codes_regenerated",
        "New FreeFrame backup codes were generated for your account",
    )
    return TwoFactorBackupCodesResponse(
        backup_codes=codes, tokens=_issue_tokens(current_user)
    )


# ── Backup address, and the onboarding gate's own endpoints (§200) ──────────
#
# All of these live under /auth/ deliberately: middleware/account_gate.py lets
# that prefix through unconditionally, and an endpoint whose whole job is to
# SATISFY the gate cannot itself be behind it.


@router.get("/password-policy", response_model=PasswordPolicyResponse)
def get_password_policy():
    """The rules, so a screen can state them before the first attempt.

    Unauthenticated: it is reachable from the invite and set-password screens,
    where there is no session yet, and it discloses nothing an attacker could
    not learn by submitting one bad password. Serving it from
    `describe_policy()` rather than repeating the numbers in TypeScript is
    what stops the screen promising rules the server does not enforce.
    """
    return PasswordPolicyResponse(**describe_policy())


@router.post(
    "/backup-email",
    response_model=BackupEmailResponse,
    # Its own bucket. Proposing an address sends mail to an address the
    # sender chose, which is the one endpoint here that could be used to
    # push mail at a third party, so it gets a tighter allowance than the
    # login-code endpoints and does not share theirs.
    dependencies=[Depends(rate_limit("set_backup_email", 5, 900))],
)
def set_backup_email(
    body: BackupEmailRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Propose a backup address and mail a verification code to it.

    Nothing about the account changes until that code comes back: the
    address is stored with `backup_email_verified_at = NULL`, which reads as
    "pending" everywhere and is used for nothing. In particular a reset is
    never sent to a pending address — an unproved address is not a recovery
    channel, it is a guess.

    Replacing an ALREADY-VERIFIED address needs the current second factor
    (see `_require_step_up`). Pointing password resets at a mailbox of your
    choosing is the most valuable single thing a stolen session could do
    here, so it is gated exactly like disabling 2FA is.
    """
    candidate = body.backup_email.strip()

    # Case-insensitively different from the login address — the whole point
    # is that the login mailbox cannot read the reset mail, and
    # `Mathias@yon.studio` is the same mailbox as `mathias@yon.studio`. This
    # mirrors get_user_by_email's own normalisation rule, which exists
    # because this codebase has already been bitten once by treating two
    # capitalisations as two addresses (§13a).
    if candidate.lower() == (current_user.email or "").strip().lower():
        raise HTTPException(
            status_code=400,
            detail=(
                "Your backup address must be a different mailbox from the one "
                "you sign in with. If the same inbox can receive both your "
                "sign-in codes and your password resets, it is one factor, "
                "not two."
            ),
        )

    if current_user.backup_email_verified_at:
        _require_step_up(db, current_user, body.reauth_code)

    # A pending address being replaced leaves a live code behind for an
    # address the row no longer names. The verify endpoint checks the code
    # against whatever address is CURRENTLY stored, so an orphaned code can
    # never be redeemed — but leaving it alive means an email already in
    # flight looks valid to the person reading it. Dropped explicitly.
    previous = current_user.backup_email
    if previous and not current_user.backup_email_verified_at and previous.lower() != candidate.lower():
        clear_backup_email_code(previous)

    current_user.backup_email = candidate
    # Any previous verification is void: this is a different mailbox until it
    # proves otherwise. Writing the address without clearing this would hand
    # a verified state to an address nobody has checked — the single worst
    # bug this endpoint could have.
    current_user.backup_email_verified_at = None
    db.commit()
    db.refresh(current_user)

    org_name = instance_org_name(db)
    sent = _send_backup_email_code(current_user, candidate, org_name)

    return BackupEmailResponse(
        backup_email=candidate,
        state=current_user.backup_email_state,
        code_sent=sent,
        same_domain=_same_domain(candidate, current_user.email),
    )


@router.post(
    "/backup-email/resend",
    response_model=BackupEmailResponse,
    # Tighter than proposing one: a resend targets an address already on the
    # row, so the abuse it could enable is repetition rather than reach.
    dependencies=[Depends(rate_limit("resend_backup_email_code", 3, 600))],
)
def resend_backup_email_code(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Send the verification code again, to the address already on file."""
    if not current_user.backup_email:
        raise HTTPException(status_code=400, detail="No backup address to confirm")
    if current_user.backup_email_verified_at:
        # Idempotent-ish rather than an error on a double click: the end
        # state the caller wants is already true, and re-sending would mail
        # a code that confirms something already confirmed.
        return BackupEmailResponse(
            backup_email=current_user.backup_email,
            state="verified",
            code_sent=False,
            same_domain=_same_domain(current_user.backup_email, current_user.email),
        )

    sent = _send_backup_email_code(
        current_user, current_user.backup_email, instance_org_name(db)
    )
    return BackupEmailResponse(
        backup_email=current_user.backup_email,
        state=current_user.backup_email_state,
        code_sent=sent,
        same_domain=_same_domain(current_user.backup_email, current_user.email),
    )


@router.post(
    "/backup-email/verify",
    response_model=UserResponse,
    dependencies=[Depends(rate_limit("verify_backup_email", 10, 600))],
)
def verify_backup_email(
    body: BackupEmailVerifyRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Confirm the backup address with the code that was mailed to it.

    Returns the whole user, not a bare acknowledgement, so the client updates
    its gate state from the SERVER's answer rather than assuming the write
    landed — the same discipline §191 wrote into TwoFactorDisableResponse.
    That matters more here than usual: the gate is computed from this data,
    and a client that assumed success would unblock itself while every
    protected route kept returning 403.
    """
    if not current_user.backup_email:
        raise HTTPException(status_code=400, detail="No backup address to confirm")

    # Checked against the address on the ROW, never one supplied by the
    # caller. A code is minted for a specific mailbox; letting the request
    # name which mailbox it is confirming would let a code mailed to an
    # address the user has since abandoned confirm the current one.
    ok, error = verify_backup_email_code(current_user.backup_email, body.code.strip())
    if not ok:
        raise HTTPException(status_code=401, detail=error)

    current_user.backup_email_verified_at = datetime.now(timezone.utc)
    # An admin waiver was a way past a gate that is now genuinely satisfied.
    # Cleared so it cannot silently exempt this user from a requirement that
    # comes back later — the waiver is meant to unblock one person once, not
    # to be a permanent property of the account.
    current_user.account_gate_waived_at = None
    db.commit()
    db.refresh(current_user)

    _notify_both_addresses(
        current_user,
        "backup_email_verified",
        "Your FreeFrame password-reset address was confirmed",
    )
    return current_user


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(body: RefreshRequest, db: Session = Depends(get_db)):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    user = get_user_by_id(db, uuid.UUID(payload["sub"]))
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=401, detail="User not found")
    # §199 — a flat rejection, and deliberately NOTHING else. The temptation
    # here is to re-run _login_outcome so the caller gets whatever gate is
    # current; that would be a second copy of the 2FA branch living inside
    # refresh, which is precisely the duplication §193 was written to remove
    # and §196/§198 then had to remove again on the client. The bump is what
    # ends the session; re-establishing one is /auth/login's job, and it
    # stays the only place that decides what a login requires.
    if token_version_of(payload) != (user.token_version or 0):
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    return _issue_tokens(user)


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me/preferences", response_model=UserResponse)
def update_preferences(
    body: dict,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update user preferences (theme, etc). Merges with existing preferences."""
    current_prefs = current_user.preferences or {}
    current_prefs.update(body)
    current_user.preferences = current_prefs
    # Force SQLAlchemy to detect the JSON change
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(current_user, "preferences")
    db.commit()
    db.refresh(current_user)
    return current_user
