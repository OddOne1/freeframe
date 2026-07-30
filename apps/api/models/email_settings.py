"""Admin-editable mail configuration.

**Deliberately a separate table and router from SiteSettings.** `GET
/site-settings` is unauthenticated — it backs the login page's branding —
so putting an SMTP password anywhere near that model would put a live
credential one serialization mistake away from an anonymous request. This
model has no public read path at all; see routers/email_settings.py.

Every field is nullable, and null means "not overridden, use the env var."
That keeps existing .env.prod installs working untouched the moment this
ships, and lets an admin override just the password while leaving host and
port on the environment.
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import String, Integer, Boolean, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class EmailSettings(Base):
    """Singleton row, same pattern as SiteSettings."""
    __tablename__ = "email_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Mirrors config.py's mail fields exactly.
    mail_provider: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)  # "ses" | "smtp"
    mail_from_address: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    mail_from_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)

    # AWS SES
    aws_mail_access_key_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # Fernet ciphertext, never plaintext. Longer column than the plaintext
    # needs: Fernet output is base64 and meaningfully larger than its input.
    aws_mail_secret_access_key_encrypted: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    aws_mail_region: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # SMTP
    smtp_host: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    smtp_port: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    smtp_user: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    smtp_password_encrypted: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    smtp_use_tls: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
