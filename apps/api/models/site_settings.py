import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, BigInteger, Boolean, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class SiteSettings(Base):
    """Singleton table holding site-wide branding settings."""

    __tablename__ = "site_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_name: Mapped[str] = mapped_column(String, nullable=False, server_default="FreeFrame")
    logo_dark_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    logo_light_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    logo_login_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    favicon_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    theme_colors: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Platform-wide total storage cap, separate from per-user/per-project
    # limits (task 12) -- nullable = no cap, same convention as every other
    # storage limit in this codebase.
    total_storage_limit_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    #: IANA zone name (e.g. "Europe/Vienna") deciding what "03:00" means for
    #: the daily maintenance jobs (§182). "UTC" is the default because
    #: FreeFrame is self-hostable and this deployment's own timezone is not a
    #: sensible default for anyone else's.
    #:
    #: Celery's OWN `timezone` setting stays "UTC" permanently and is NOT
    #: derived from this. A running beat scheduler does not reliably pick up
    #: a timezone change, and making it do so is fragile in a way nothing
    #: here can verify. Instead the wall-clock-sensitive jobs tick every 15
    #: minutes and decide for themselves whether it is their hour — see
    #: services/schedule_window.py. A change therefore takes effect on the
    #: next tick, with no restart.
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, server_default="UTC")
    #: Whether every user on this instance must have 2FA (§191).
    #:
    #: False by default, and that default is load-bearing: a self-hosted
    #: install that upgrades into this feature must keep logging in exactly
    #: as it did until an admin decides otherwise. Turning it on does not
    #: lock anyone out either — a user without 2FA is routed into forced
    #: SETUP on their next correct password, not refused.
    #:
    #: Read fresh per request like `timezone` above, never cached: an admin
    #: enabling this expects it to bind on the next login, not after a
    #: restart.
    require_2fa: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
