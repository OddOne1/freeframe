"""CRC-32 of one stored object, computed once and never recomputed (§217).

A streamed zip cannot exist without this. A `ZIP_STORED` entry's local
header carries its CRC-32 and the central directory at the end needs it for
every entry, so a request for an arbitrary byte range has to already know
the CRC of every file in the archive — reading the data to find out is
exactly what streaming exists to avoid. See `services/zip_stream.py` for
why the data-descriptor escape hatch does not work for a resumable stream.

── Why a table rather than columns on MediaFile ─────────────────────────

`media_files.size_verified_at` (§180) is the obvious precedent, and this
file is deliberately NOT a copy of it. Two reasons, both concrete:

1. **A CRC belongs to an OBJECT, and one MediaFile row owns more than
   one.** A batch download may contain the raw upload (`s3_key_raw`, or
   `s3_key_processed` for a still whose raw key is absent) or §57's
   persisted 1080p proxy (`proxy_1080p_key`) — see
   `zip_export_service.source_key_for`. Columns on `media_files` would
   need a pair per variant, and §143's own comment says a 720p rung
   becoming a stored object later should need no code change here.

2. **The size the CRC was computed over has to be stored next to it.** A
   CRC is only meaningful for a known number of bytes: the task refuses to
   write one if the bytes it read disagree with the object's
   `ContentLength`, and the serving path refuses to splice if the object's
   size has changed since the manifest was frozen.
   `media_files.file_size_bytes` cannot serve that purpose — it is the
   quota column, it is reconciled on its own schedule, and it describes the
   raw upload only.

Keyed by `s3_key`, so the same object referenced by two exports, two
versions or two variants is read once, forever.

── A row exists once an attempt has been made ───────────────────────────

`crc32 IS NULL AND error IS NOT NULL` is a FAILED object, and that is a
state the export flow needs: a missing or unreadable file must mark its own
entry skipped without poisoning the other hundred, which is exactly what
the build path already did per member. `crc32 IS NULL AND error IS NULL`
means an attempt is in flight. No row at all means nothing has tried yet.
"""
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

# Both import styles, matching every other model here: alembic runs with
# apps/api on sys.path (so `database` is top-level) while the app runs from
# the repo root (so `..database` resolves). A single form breaks one of them.
try:
    from ..database import Base
except ImportError:  # pragma: no cover - alembic's import path
    from database import Base


class ObjectChecksum(Base):
    """One stored object's CRC-32, and the size it was computed over."""

    __tablename__ = "object_checksums"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    #: The S3 key, unique. 1024 rather than `media_files`' 1000 to match
    #: S3's own key limit; real keys here are the ASCII
    #: `raw/{YYMMDD}_{slug}_{project}/{asset}/{version}/original{ext}` shape
    #: (see services/storage_prefix.py), well inside a btree index's bound.
    s3_key: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True, index=True)

    #: Unsigned 32-bit, so BigInteger: a 4-byte signed column cannot hold
    #: 0xFFFFFFFF, and `zlib.crc32` returns the unsigned value. NULL until
    #: a read completes successfully.
    crc32: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    #: How many bytes were read to produce `crc32`. The CRC is only valid
    #: for exactly this many, which is why the two are written together or
    #: not at all.
    size_bytes: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    #: Why the last attempt failed, when it did. Set alongside a NULL
    #: `crc32` so the export flow can skip this one entry and say why,
    #: instead of waiting forever for a CRC that is never coming.
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    #: Attempts so far, so a permanently unreadable object stops being
    #: retried by the backfill rather than consuming a slot on every run.
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
