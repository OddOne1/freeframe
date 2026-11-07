"""One rendered clip download (SocialSnippet, prompt #8).

A row per distinct render: the same asset version, in/out, aspect, framing
and caption settings hash to the same `cache_key`, so asking twice returns
the first export instead of encoding again.

── Survives the asset ────────────────────────────────────────────────────
An exported clip outlives its source on purpose. Every FK to the asset side
(`snippets`, `media_files`, `asset_versions`) is ON DELETE SET NULL, never
CASCADE: `purge_service.purge_asset` deletes those rows and must neither
fail on this table nor take it with it. What the download needs afterwards
is on the row itself: `s3_key` and `download_filename`. The object lives
under `snippet-exports/`, a prefix purge never lists (see EXPORT_PREFIX).

── Lifetime ──────────────────────────────────────────────────────────────
`expires_at` is set when the render finishes, from the project's
`export_retention_days`; NULL means keep forever. The beat sweep in
tasks/snippet_export_tasks.py deletes the object of an expired row and marks
it `expired` rather than deleting the row, so a client polling an old id
learns it is gone instead of getting a 404 it cannot tell from "never was".
"""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    JSON, BigInteger, Boolean, CheckConstraint, DateTime, Float, ForeignKey,
    Integer, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

try:
    from ..database import Base
except ImportError:  # pragma: no cover - alembic's import path
    from database import Base

#: Every S3 object this feature writes is under here and nowhere else:
#: `snippet-exports/{project_id}/{export_id}/clip.mp4`. Not one of the areas
#: purge_service.purge_asset clears (raw, processed, sidecars, proxies).
EXPORT_PREFIX = "snippet-exports/"

#: Row states. `expired` is set only by the retention sweep.
EXPORT_STATUSES = ("queued", "running", "done", "failed", "expired")

#: As EXPORT_ASPECT_CHECK in models/snippet.py, for `snippet_exports.status`.
EXPORT_STATUS_CHECK = "status IN ({})".format(", ".join("'%s'" % s for s in EXPORT_STATUSES))


class SnippetExport(Base):
    __tablename__ = "snippet_exports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # NULL for a transcript moment, and after the snippet is deleted.
    snippet_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("snippets.id", ondelete="SET NULL"), nullable=True, index=True
    )
    # SET NULL, not CASCADE: see the module docstring.
    media_file_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("media_files.id", ondelete="SET NULL"), nullable=True, index=True
    )
    asset_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("asset_versions.id", ondelete="SET NULL"), nullable=True
    )
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    aspect: Mapped[str] = mapped_column(String(5), nullable=False)
    #: {x, y, zoom}, or NULL for the default (centre, zoom 1).
    framing: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    caption_style: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    captions: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="false")
    #: SHA-256 hex of the render inputs; see services/snippet_export.cache_key.
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued", server_default="queued")
    #: 0..1
    progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0, server_default="0")
    s3_key: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    #: Fixed when the row is created, so the download keeps a readable name
    #: after the asset and speaker it was built from are gone.
    download_filename: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    #: Touched on every state change and progress write. A queued/running row
    #: untouched for EXPORT_STALE_AFTER is treated as lost (worker restarted)
    #: and a new POST queues it again.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    #: NULL = keep forever.
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    __table_args__ = (
        UniqueConstraint("cache_key", name="uq_snippet_exports_cache_key"),
        CheckConstraint(EXPORT_STATUS_CHECK, name="ck_snippet_exports_status"),
        CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name="ck_snippet_exports_times"),
        CheckConstraint("progress >= 0 AND progress <= 1", name="ck_snippet_exports_progress"),
    )
