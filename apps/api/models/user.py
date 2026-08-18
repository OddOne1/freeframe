import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, JSON, BigInteger, func
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

class GuestUser(Base):
    __tablename__ = "guest_users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
