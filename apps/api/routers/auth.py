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
    VerifyMagicCodeRequest, SetPasswordRequest,
    AcceptInviteRequest, InviteInfoResponse,
    LoginResponse, TwoFactorRequiredResponse, TwoFactorVerifyRequest,
    TwoFactorSetupRequest, TwoFactorSetupResponse,
    TwoFactorConfirmRequest, TwoFactorConfirmResponse,
    TwoFactorEmailFallbackResponse,
)
from ..services.auth_service import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
    create_2fa_pending_token, decode_2fa_pending_token,
    get_user_by_email, get_user_by_id, split_full_name,
)
from ..services.redis_service import (
    generate_magic_code, store_magic_code, verify_magic_code as redis_verify_magic_code,
    MAGIC_CODE_EXPIRY_SECONDS,
    generate_2fa_email_code, store_2fa_email_code, verify_2fa_email_code,
    TWOFA_EMAIL_CODE_EXPIRY_SECONDS,
)
from ..services import totp_service
from ..services.site_settings_service import require_2fa_enabled, instance_org_name
from ..tasks.email_tasks import send_magic_code_email, send_invite_email
from ..tasks.celery_app import send_task_safe
from ..models.user import User, UserStatus, UserGlobalRole
from ..middleware.auth import get_current_user, get_optional_user
from ..middleware.rate_limit import rate_limit

router = APIRouter(prefix="/auth", tags=["auth"])

MAGIC_CODE_EXPIRY_MINUTES = MAGIC_CODE_EXPIRY_SECONDS // 60


def _generate_invite_token() -> str:
    """Generate a secure invite token."""
    return secrets.token_urlsafe(48)


@router.post("/send-magic-code", response_model=SendMagicCodeResponse, dependencies=[Depends(rate_limit("send_magic_code", 5, 600))])
def send_magic_code(body: SendMagicCodeRequest, db: Session = Depends(get_db)):
    """
    Send magic code to email.
    - If user exists: send code for login
    - If user doesn't exist: create pending user and send code
    """
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
        
    # Generate and store magic code in Redis
    code = generate_magic_code()
    store_magic_code(body.email, code)

    # Queue email via Celery (async)
    try:
        contact_url = settings.frontend_url + "/settings/contact"
        send_task_safe(send_magic_code_email, body.email, code, MAGIC_CODE_EXPIRY_MINUTES, body.purpose, contact_url)
    except Exception:
        pass  # Email delivery is best-effort; code is already in Redis

    return SendMagicCodeResponse(
        message="Magic code sent to your email",
        email=body.email,
    )
@router.post("/verify-magic-code", response_model=TokenResponse, dependencies=[Depends(rate_limit("verify_magic_code", 10, 600))])
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
    
    # Verify magic code from Redis
    success, error = redis_verify_magic_code(body.email, body.code)
    if not success:
        raise HTTPException(status_code=401, detail=error)
    
    # Mark email as verified
    user.email_verified = True
    
    # If user was pending verification, activate them
    if user.status == UserStatus.pending_verification:
        user.status = UserStatus.active
    
    db.commit()
    
    # Check if user needs to set password
    needs_password = user.password_hash is None
    
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        needs_password=needs_password,
    )


@router.post("/set-password", response_model=UserResponse)
def set_password(
    body: SetPasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Set password for authenticated user (after magic code verification)."""
    current_user.password_hash = hash_password(body.password)
    db.commit()
    db.refresh(current_user)
    return current_user


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
    
    # Set password and activate user
    user.password_hash = hash_password(body.password)
    user.email_verified = True  # Invited users are pre-verified
    user.status = UserStatus.active
    user.invite_token = None
    user.invite_token_expires_at = None
    db.commit()
    
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        needs_password=False,
    )


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, db: Session = Depends(get_db)):
    """Register with email + password (legacy, prefer magic code flow)."""
    if get_user_by_email(db, body.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    first_name, last_name = split_full_name(body.name)
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

    if user.totp_enabled:
        return TwoFactorRequiredResponse(
            setup_required=False,
            pending_token=create_2fa_pending_token(str(user.id)),
        )

    if require_2fa_enabled(db):
        # Enrolment is forced, not refused: locking out everyone the moment
        # an admin flips the switch would make the switch unusable.
        return TwoFactorRequiredResponse(
            setup_required=True,
            pending_token=create_2fa_pending_token(str(user.id)),
        )

    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        needs_password=False,
    )


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
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        needs_password=user.password_hash is None,
    )


def _second_factor_matches(db: Session, user: User, code: str) -> bool:
    """Whether `code` satisfies the second factor, by ANY of its three forms.

    Tried in order — authenticator, emailed fallback, backup code — because
    the user does not reliably know which kind they are holding, and making
    the client declare it would fail correct codes over a wrong guess.

    A spent backup code is persisted here rather than by the caller: it is
    single-use, and a path that verified without consuming would turn a
    recovery code into a permanent password.
    """
    secret = totp_service.decrypt_secret(user.totp_secret_encrypted)
    if totp_service.verify_totp_code(secret, code):
        return True

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

    if not user.totp_enabled:
        # A pending token issued for FORCED SETUP cannot be redeemed here —
        # that path has to go through confirm-setup, which is what actually
        # enrols them. Otherwise "enforcement on" would be satisfiable by
        # anyone who never enrolled.
        raise HTTPException(status_code=401, detail="Invalid code")

    if not _second_factor_matches(db, user, body.code):
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

    The generated secret is stored encrypted immediately but
    `totp_enabled` stays false until a real code confirms it. Storing it
    now is what lets confirm-setup verify against the same secret the QR
    code showed; leaving `totp_enabled` false is what stops an abandoned
    setup from locking the user out of their own account.
    """
    user = current_user
    if user is None:
        if not body or not body.pending_token:
            raise HTTPException(status_code=401, detail="Not authenticated")
        user = _user_from_pending(db, body.pending_token)

    secret = totp_service.generate_totp_secret()
    user.totp_secret_encrypted = totp_service.encrypt_secret(secret)
    db.commit()

    uri = totp_service.totp_provisioning_uri(
        secret, user.email, issuer=instance_org_name(db)
    )
    return TwoFactorSetupResponse(
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
    """Finish enrolment: prove the authenticator works, then switch it on.

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

    secret = totp_service.decrypt_secret(user.totp_secret_encrypted)
    if not secret:
        raise HTTPException(status_code=400, detail="Start setup again")

    # Only the authenticator counts here. An emailed fallback or a backup
    # code proves nothing about whether the app the user just configured
    # actually works, which is the single thing this step exists to check.
    if not totp_service.verify_totp_code(secret, body.code):
        raise HTTPException(status_code=401, detail="Invalid code")

    codes = totp_service.generate_backup_codes()
    user.backup_codes_hashed = totp_service.hash_backup_codes(codes)
    user.totp_enabled = True
    db.commit()

    return TwoFactorConfirmResponse(
        backup_codes=codes,
        # Only when this completed a forced login. An already-signed-in user
        # holds working tokens already; re-issuing would be churn.
        tokens=_issue_tokens(user) if forced_first_login else None,
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
    body: TwoFactorSetupRequest, db: Session = Depends(get_db)
):
    """Email a one-time code to someone who has lost their authenticator."""
    user = _user_from_pending(db, body.pending_token)

    if user.totp_enabled:
        code = generate_2fa_email_code()
        store_2fa_email_code(user.email, code)
        send_task_safe(
            send_magic_code_email,
            user.email,
            code,
            TWOFA_EMAIL_CODE_EXPIRY_SECONDS // 60,
            "two_factor",
        )
    # Falls through with the same response either way: whether this account
    # is enrolled is not something an unauthenticated caller learns here.
    return TwoFactorEmailFallbackResponse()


@router.post("/refresh", response_model=TokenResponse)
def refresh_token(body: RefreshRequest, db: Session = Depends(get_db)):
    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")
    user = get_user_by_id(db, uuid.UUID(payload["sub"]))
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=401, detail="User not found")
    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
        needs_password=user.password_hash is None,
    )


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
