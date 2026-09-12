"""Server-built zip downloads for multi-file requests (CLAUDE.md §143).

Replaces the browser firing one download per file. That loop had no abort
and tripped Chrome's multi-download permission prompt once per remaining
file, so dismissing it did not stop it — the fix is one file, not a
politer loop.

A row here is a BUILD, not a request: several viewers asking for the same
selection share one row and one object in storage, which is what `cache_key`
is for. See `ZipExport.cache_key` for exactly what "the same selection"
means, because that definition is the whole of the invalidation logic.
"""
import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

# Both import styles, matching every other model here: alembic runs with
# apps/api on sys.path (so `database` is top-level) while the app runs from
# the repo root (so `..database` resolves). A single form breaks one of them.
try:
    from ..database import Base
except ImportError:  # pragma: no cover - alembic's import path
    from database import Base


class ZipExportStatus(str, PyEnum):
    pending = "pending"
    building = "building"
    ready = "ready"
    failed = "failed"


class ZipExport(Base):
    """One built (or building) zip.

    Deliberately NOT keyed by the requesting viewer. A share link is
    anonymous and several people may hold it; keying by viewer would build
    the same archive once per person and keep N copies for three days.
    """

    __tablename__ = "zip_exports"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    #: sha256 of the canonical description of this selection. Two requests
    #: sharing a key are guaranteed to produce byte-identical archives, so
    #: one may reuse the other's object.
    #:
    #: The hashed material is, exactly: the scope id (share link, or
    #: project+user for the in-app flow) plus a SORTED list of one tuple per
    #: file — (path inside the zip, asset id, version id, resolved variant,
    #: applied LUT id when the variant burns one).
    #:
    #: The path is in there on purpose, and it is the non-obvious half:
    #: renaming an asset or moving it between folders changes the archive's
    #: contents while every id stays the same, so a key built from ids alone
    #: would serve a stale tree. Likewise the LUT id — re-grading an asset
    #: changes the bytes of a `*_lut` variant without changing its version.
    #: Anything that can change a byte of output is in the key; nothing else
    #: is, so an unrelated edit does not force a rebuild.
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    #: Null for the authenticated in-app flow. Set for a share link, which
    #: is what lets deactivation find and purge its archives.
    share_link_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("share_links.id", ondelete="CASCADE"), nullable=True, index=True
    )
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Who asked for the in-app build. Null for anonymous share viewers.
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    s3_key: Mapped[str] = mapped_column(String(1024), nullable=False)
    status: Mapped[ZipExportStatus] = mapped_column(
        Enum(ZipExportStatus), nullable=False, default=ZipExportStatus.pending
    )

    file_count: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    files_done: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    #: BigInteger, NOT Integer (§147). A 4-byte column tops out at 2.1GB, so
    #: assigning the size of any archive past that raised
    #: `NumericValueOutOfRange` on commit — at the very last step, after the
    #: whole build had succeeded. Counts above stay Integer: a selection of
    #: two billion files is not a thing.
    total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    #: Bytes of the finished archive already uploaded to storage (§147).
    #: Gather progress is `files_done`; this is the second half, which was
    #: previously invisible — the UI showed a full bar while the longest part
    #: of a large build had not started.
    bytes_done: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    #: One entry per file: its path in the zip, the version and variant
    #: actually used, and — when the requested variant could not be produced
    #: for that asset — why it was substituted. The UI shows that note per
    #: file rather than silently handing back something else (§143).
    manifest: Mapped[list] = mapped_column(JSONB, nullable=False, server_default="[]")

    #: Bumped every time `files_done` advances (§146). Staleness detection
    #: needs "has this build made progress recently", not merely "how old is
    #: it" — a genuinely slow but advancing build must not be killed, and a
    #: wedged one must not poll forever.
    progress_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    #: "all" or "selection" (§175) — whether this archive is everything
    #: downloadable in its scope or a subset the user picked. Persisted so the
    #: status payload can name the download without re-deriving it, and
    #: recorded as a property of the REQUEST rather than of the contents:
    #: item-count vs total-count cannot tell the two apart for a scope holding
    #: one asset.
    #:
    #: Deliberately NOT part of `cache_key`. Two requests differing only in
    #: scope produce byte-identical archives and should share one object; the
    #: name is applied when the download is served, not baked into the file.
    #: That is also why the link's TITLE is not stored here — reading it live
    #: means re-titling a link renames its download with no rebuild, matching
    #: what `cache_key` already documents about a re-title reusing the build.
    scope: Mapped[str] = mapped_column(String(16), nullable=False, server_default="selection")

    #: Which half of the build is running: "gathering" (fetching members and
    #: writing the archive) or "uploading" (sending the finished archive to
    #: storage). Explicit rather than derived from `files_done == file_count`
    #: (§147): the two are equal for a moment before the upload begins, and a
    #: derived value cannot tell that apart from an upload in flight — which
    #: is exactly the distinction the logs and the UI needed and lacked.
    phase: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    #: Three days, or until the link is deactivated — whichever comes first.
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
