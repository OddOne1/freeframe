"""Separately-uploaded sidecar files (ASC CDL, ALE, camera XML).

Kept in its own table with its own `parsed_metadata` rather than merged into
`MediaFile.technical_metadata` on purpose: this data is user-supplied and
optional, not derived from the media file itself. That provenance is worth
keeping visible in the UI — "From uploaded sidecar" vs. "From file" — so a
colorist can tell an on-set CDL from something the encoder happened to
report.

Attached at the asset level, not per-version: a CDL or ALE row describes the
shot, not one particular re-upload of it.
"""

import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional

from sqlalchemy import String, Enum, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:
    from database import Base


class SidecarType(str, PyEnum):
    cdl = "cdl"
    ale = "ale"
    camera_xml = "camera_xml"


class SidecarFile(Base):
    __tablename__ = "sidecar_files"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("assets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sidecar_type: Mapped[SidecarType] = mapped_column(Enum(SidecarType), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    # Raw file kept as-is under its own prefix, distinct from processed/.
    s3_key: Mapped[str] = mapped_column(String(1000), nullable=False)
    # Whatever the format actually offered — shape varies by type and by
    # production, so JSONB rather than fixed columns.
    parsed_metadata: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    uploaded_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
