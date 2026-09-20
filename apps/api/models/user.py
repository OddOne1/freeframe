import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, JSON, BigInteger, Boolean, Integer, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class UserStatus(str, PyEnum):
    active = "active"
    deactivated = "deactivated"
    pending_invite = "pending_invite"
    pending_verification = "pending_verification"

class UserGlobalRole(str, PyEnum):
    superadmin = "superadmin"
    superuser = "superuser"
    user = "user"

#: Every new account starts with this much storage. Declared here, on the
#: model, and not only as the migration's schema-level default -- at least one
#: real row (2026-08-18) was inserted with NULL despite that default existing,
#: and nothing in code can audit why after the fact. NULL still means
#: "unlimited"; an admin can set that deliberately afterwards. This only
#: governs what a row gets when nobody says otherwise.
DEFAULT_STORAGE_LIMIT_BYTES = 200 * 1024 ** 3

class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    first_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_name: Mapped[str] = mapped_column(String(255), nullable=False)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    password_hash: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    status: Mapped[UserStatus] = mapped_column(Enum(UserStatus), default=UserStatus.active)
    role: Mapped[UserGlobalRole] = mapped_column(Enum(UserGlobalRole), default=UserGlobalRole.user, server_default='user')
    # Both defaults on purpose, matching `role` directly above: the Python one
    # fills the value in for every INSERT this app makes regardless of insert
    # path, the server_default covers anything that reaches the table without
    # going through the ORM.
    storage_limit_bytes: Mapped[Optional[int]] = mapped_column(
        BigInteger,
        nullable=True,
        default=DEFAULT_STORAGE_LIMIT_BYTES,
        server_default=str(DEFAULT_STORAGE_LIMIT_BYTES),
    )
    email_verified: Mapped[bool] = mapped_column(default=False)
    invite_token: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    invite_token_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    preferences: Mapped[dict] = mapped_column(JSON, nullable=False, server_default='{}')

    # ── Two-factor authentication (§191) ───────────────────────────────────
    #
    # The shared TOTP secret, Fernet-encrypted at rest — never plaintext in
    # the database. See services/totp_service.py for where the key comes
    # from. A value here does NOT mean 2FA is on: setup generates a secret
    # and confirmation enables it, and between those two moments the secret
    # exists while `two_factor_enabled` is still false.
    totp_secret_encrypted: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    #: True only once the user has confirmed their chosen second factor.
    #: Generating a secret must never gate login on its own — a half-finished
    #: setup would otherwise lock someone out of their own account.
    #:
    #: §194 — renamed from `totp_enabled`. Once email can be the PRIMARY
    #: second factor rather than only a fallback, a user can be enrolled
    #: with no TOTP secret at all, and a flag called `totp_enabled` reading
    #: True for someone who has no authenticator is a lie to whoever reads
    #: this next. Renaming cost a migration and ~74 call sites; leaving it
    #: would have cost the next person an hour and a wrong assumption.
    two_factor_enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: Which factor this user actually enrolled with: "totp" or "email".
    #: NULL when not enrolled.
    #:
    #: Stored rather than inferred from `totp_secret_encrypted is None`,
    #: which would work today and is exactly the kind of implementation
    #: detail that should not decide what a login screen renders. The
    #: frontend needs "open your authenticator" vs "check your email", and
    #: that is a question about the user's choice, not about which column
    #: happens to be populated.
    two_factor_method: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    #: Single-use recovery codes, bcrypt-hashed with the same helper that
    #: hashes passwords (services/auth_service.hash_password) — not a second
    #: scheme invented for this. Issued once at confirmation, shown once, and
    #: each one is removed from this list the moment it is spent. They exist
    #: for the case where BOTH the authenticator and email access are gone.
    #:
    #: JSON rather than a child table, matching `allowed_download_variants`
    #: on ShareLink: a short fixed-size list read and rewritten as a whole,
    #: never queried into.
    backup_codes_hashed: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)

    # ── Session invalidation (§199) ─────────────────────────────────────────
    #
    #: Bumped whenever something changes what an ALREADY-SIGNED-IN session is
    #: entitled to: 2FA enabled, disabled, reset by an admin, backup codes
    #: regenerated, a password set or changed. Every access and refresh token
    #: carries the value it was minted under as a `tv` claim, and both
    #: get_current_user and /auth/refresh reject a token whose `tv` no longer
    #: matches this column.
    #:
    #: Deactivation is NOT in that list and deliberately so — it was already
    #: handled, because both of those places re-read `status` on every call.
    #: What was missing is everything short of deactivation: turning 2FA off
    #: and on again, or changing a password, left every open session alive
    #: and renewing itself for the whole refresh window. A stolen laptop
    #: survived both.
    #:
    #: A token with NO `tv` claim counts as 0, which is what makes this
    #: deployable without logging anybody out: every session alive at
    #: migration time is implicitly version 0, and so is every row.
    token_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    # ── Account security gate (§200) ────────────────────────────────────────
    #
    #: A SECOND address, used for exactly one thing: password resets. Nullable
    #: because every row predates it — that is what the onboarding gate exists
    #: to fill in.
    #:
    #: The whole point is channel separation. Before this, one mailbox was the
    #: entire account: request a reset, set a new password, and then read the
    #: 2FA code out of the same inbox. Two factors, one channel. Reset codes
    #: now go ONLY here and 2FA codes go ONLY to `email`, with no fallback in
    #: either direction — a fallback would re-merge exactly what this splits.
    backup_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    #: When the address above was proved reachable, by a code sent to it.
    #: NULL while an address is stored but unconfirmed, which is the "pending"
    #: state the gate shows a code box for. An unverified address is never
    #: used for anything — a reset to an address nobody has proved is a
    #: mailbox is worse than no reset path at all.
    backup_email_verified_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: A superadmin's (or the shell script's) escape hatch from the gate.
    #:
    #: The gate is computed from stored data and never from a "seen" flag, so
    #: it cannot simply be dismissed — which is right, and is also how a user
    #: whose backup address is undeliverable would be locked out of the whole
    #: app with no way to ask for help. This column is the deliberate,
    #: server-side, audit-logged exception: set, and `gate_outstanding` reads
    #: False for this user until they complete setup for real.
    #:
    #: Consulted ONLY while something is outstanding (see gate_outstanding),
    #: so it can never mask a requirement that comes back later — it is a
    #: waiver of the block, not of the requirement.
    account_gate_waived_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    @property
    def name(self) -> str:
        """Computed full name, kept for backward compatibility with code
        that still reads .name (email templates, admin listings, JWT
        helpers). This is NOT a queryable column anymore -- anything that
        used to filter with User.name.ilike(...) must filter on
        first_name/last_name directly instead (see routers/users.py
        search_users).
        """
        if self.first_name:
            return f"{self.first_name} {self.last_name}"
        return self.last_name

    # ── The onboarding gate, derived (§200) ─────────────────────────────────
    #
    # Properties rather than columns, deliberately. Both answers are already
    # implied by the data; storing them as well would create a second truth
    # that can disagree with the first, and the disagreement would be
    # invisible — a user who HAS a password still being told to set one, or
    # worse, a gate that stays satisfied after the data behind it is gone.
    #
    # `UserResponse.model_config["from_attributes"]` picks these up exactly
    # like real columns, so /auth/me reports them with no extra plumbing.

    @property
    def must_set_password(self) -> bool:
        """This account has no password at all."""
        return self.password_hash is None

    @property
    def backup_email_state(self) -> str:
        """"missing" | "pending" | "verified" — see `backup_email`."""
        if not self.backup_email:
            return "missing"
        return "verified" if self.backup_email_verified_at else "pending"

    @property
    def account_setup_required(self) -> bool:
        """Whether either half of the gate is still outstanding.

        Deliberately ignores `account_gate_waived_at`: this is the question
        "is this account's security setup finished", which a waiver does not
        change. Whether the app should BLOCK is a different question — see
        gate_outstanding — and keeping the two apart is what stops a waiver
        from ever reading as "setup is done".
        """
        return self.must_set_password or self.backup_email_state != "verified"


def gate_outstanding(user: User) -> bool:
    """Whether this user should be blocked out of the app (§200).

    The one place that combines the requirement with its waiver, so no
    caller has to remember both halves. A function rather than a third
    property, because the middleware, /auth/me and the tests all ask this
    same question and a property would invite one of them to ask only
    `account_setup_required` instead and quietly ignore the escape hatch.
    """
    if not user.account_setup_required:
        return False
    return user.account_gate_waived_at is None

class GuestUser(Base):
    __tablename__ = "guest_users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # ── Account security gate (§200) ────────────────────────────────────────
    #
    #: A SECOND address, used for exactly one thing: password resets. Nullable
    #: because every row predates it — that is what the onboarding gate exists
    #: to fill in.
    #:
    #: The whole point is channel separation. Before this, one mailbox was the
    #: entire account: request a reset, set a new password, and then read the
    #: 2FA code out of the same inbox. Two factors, one channel. Reset codes
    #: now go ONLY here and 2FA codes go ONLY to `email`, with no fallback in
    #: either direction — a fallback would re-merge exactly what this splits.
    backup_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    #: When the address above was proved reachable, by a code sent to it.
    #: NULL while an address is stored but unconfirmed, which is the "pending"
    #: state the gate shows a code box for. An unverified address is never
    #: used for anything — a reset to an address nobody has proved is a
    #: mailbox is worse than no reset path at all.
    backup_email_verified_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: A superadmin's (or the shell script's) escape hatch from the gate.
    #:
    #: The gate is computed from stored data and never from a "seen" flag, so
    #: it cannot simply be dismissed — which is right, and is also how a user
    #: whose backup address is undeliverable would be locked out of the whole
    #: app with no way to ask for help. This column is the deliberate,
    #: server-side, audit-logged exception: set, and `gate_outstanding` reads
    #: False for this user until they complete setup for real.
    #:
    #: Consulted ONLY while something is outstanding (see gate_outstanding),
    #: so it can never mask a requirement that comes back later — it is a
    #: waiver of the block, not of the requirement.
    account_gate_waived_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
