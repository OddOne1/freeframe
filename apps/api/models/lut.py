"""Color LUTs (.cube), owned personally and shareable into projects.

Ownership is deliberately *personal-plus-shareable* rather than
project-scoped: a LUT belongs to the user who uploaded it and follows them
across every project they touch, and separately can be explicitly shared
into one project so that team can use it too. Hence two tables — a
project-scoped single table cannot express "my library, everywhere I go."
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import String, DateTime, ForeignKey, Integer, func, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class Lut(Base):
    """One uploaded .cube file in a user's personal library.

    Modeled on Collection (models/metadata.py) — the closest existing
    "small named user-owned thing" — but keyed to a user rather than a
    project.
    """
    __tablename__ = "luts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # CASCADE, not SET NULL: a personal library has no meaning without its
    # owner, and unlike an asset or a comment nobody else has built on top
    # of it. (Spec flagged this as worth confirming — see the report.)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    s3_key: Mapped[str] = mapped_column(String(1000), nullable=False)
    # Parsed out of the .cube header at upload time so the picker can warn
    # about unusually large LUTs without fetching the file itself.
    lut_size: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class ProjectLutShare(Base):
    """Makes one personal Lut visible to everyone on one project.

    Mirrors the ShareLinkItem join-table shape already in this codebase
    rather than inventing a new one. Deleting a row here unshares the LUT;
    it never touches the underlying Lut.
    """
    __tablename__ = "project_lut_shares"
    __table_args__ = (
        UniqueConstraint("project_id", "lut_id", name="uq_project_lut_shares_project_lut"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True
    )
    lut_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("luts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    shared_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
