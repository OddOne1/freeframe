import uuid
from datetime import datetime

from sqlalchemy import String, DateTime, func
from sqlalchemy.dialects.postgresql import UUID
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
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now())
