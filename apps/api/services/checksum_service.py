"""Reading, writing and waiting for one stored object's CRC-32 (§217).

Everything about the CRC that is not the Celery task itself lives here: the
store access, the "is this manifest ready to serve" question, and the two
rules that keep a wrong CRC from ever being written.

── The two rules ────────────────────────────────────────────────────────

**A CRC is only valid for a known number of bytes.** `record_checksum`
refuses to write one unless the bytes actually read match BOTH the live S3
`ContentLength` and the size the caller was told to expect. A truncated
read produces a perfectly well-formed CRC of the wrong data, and a zip
whose header claims that CRC extracts to a file every extractor rejects —
after the user has downloaded all of it.

**A verified CRC is never recomputed.** That is the whole point: a 105 GB
original takes minutes to read, and nothing about an immutable object's
bytes changes. `needs_checksum` is therefore the work queue, and
`mark_attempt_failed` is what stops a missing object from being read for
the rest of time.
"""
import logging
import zlib
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from ..config import settings
from ..models.object_checksum import ObjectChecksum

logger = logging.getLogger(__name__)


class ChecksumSizeMismatch(Exception):
    """The bytes read do not describe the object the caller named.

    Raised rather than returned so no caller can accidentally treat it as a
    successful read: the only safe response is to write nothing.
    """


# ── reading the store ───────────────────────────────────────────────────────

def get_checksum(db: Session, s3_key: str) -> Optional[ObjectChecksum]:
    return db.query(ObjectChecksum).filter(ObjectChecksum.s3_key == s3_key).first()


def get_checksums(db: Session, s3_keys: Iterable[str]) -> dict:
    """{s3_key -> ObjectChecksum} for the keys that have a row.

    One query for a whole manifest rather than one per entry: this runs on
    every status poll of every `preparing` export, and a 100-file selection
    polled every two seconds is 100 queries a poll otherwise.
    """
    keys = [k for k in dict.fromkeys(s3_keys) if k]
    if not keys:
        return {}
    rows = db.query(ObjectChecksum).filter(ObjectChecksum.s3_key.in_(keys)).all()
    return {r.s3_key: r for r in rows}


def is_verified(row: Optional[ObjectChecksum]) -> bool:
    return bool(row and row.crc32 is not None and row.size_bytes is not None)


def has_given_up(row: Optional[ObjectChecksum]) -> bool:
    """True when this object will never get a CRC without intervention.

    An export containing such a file must not sit at `preparing` forever
    waiting for it — it skips that one entry and says why, which is exactly
    what the build path already did for a member it could not read.
    """
    if row is None or is_verified(row):
        return False
    return bool(row.error) and (row.attempts or 0) >= settings.crc_max_attempts


# ── writing the store ──────────────────────────────────────────────────────

def begin_attempt(db: Session, s3_key: str) -> ObjectChecksum:
    """Claim an attempt, creating the row if this is the first.

    `attempts` is bumped BEFORE the read, not after. A task killed mid-read
    — which every deploy does — would otherwise leave the counter untouched
    and be retried forever at full cost; counting the attempt up front
    means a genuinely unreadable 105 GB object stops being read after
    `crc_max_attempts` rather than on every pass.
    """
    row = get_checksum(db, s3_key)
    if row is None:
        row = ObjectChecksum(s3_key=s3_key, attempts=0)
        db.add(row)
    row.attempts = (row.attempts or 0) + 1
    row.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return row


def record_checksum(
    db: Session,
    s3_key: str,
    *,
    crc32: int,
    bytes_read: int,
    content_length: Optional[int],
    expected_size: Optional[int] = None,
) -> ObjectChecksum:
    """Store a CRC, or refuse to.

    `content_length` is what S3 said the object is NOW, read from the same
    response the bytes came from. `expected_size` is what the caller already
    believed (the `media_files` row, or a previous verification) and may be
    None when nothing believed anything yet.

    Both are checked. The ContentLength comparison catches a truncated read
    — a connection that ended early, a `read()` that returned short — and
    the `expected_size` comparison catches an object that was REPLACED
    between the caller deciding to read it and the read happening. Either
    one means the CRC on hand does not describe the object the caller
    named, and the only safe thing to write is nothing.
    """
    if content_length is not None and bytes_read != content_length:
        raise ChecksumSizeMismatch(
            f"{s3_key}: read {bytes_read} bytes, the store reports {content_length}"
        )
    if expected_size is not None and bytes_read != expected_size:
        raise ChecksumSizeMismatch(
            f"{s3_key}: read {bytes_read} bytes, expected {expected_size}"
        )

    row = get_checksum(db, s3_key)
    if row is None:
        row = ObjectChecksum(s3_key=s3_key, attempts=1)
        db.add(row)
    row.crc32 = int(crc32) & 0xFFFFFFFF
    row.size_bytes = bytes_read
    row.verified_at = datetime.now(timezone.utc)
    # Cleared on success: a row that failed twice and then worked is
    # verified, and leaving the old message behind would make
    # `has_given_up` and every log line read as though it had not.
    row.error = None
    row.updated_at = row.verified_at
    db.commit()
    db.refresh(row)
    return row


def mark_attempt_failed(db: Session, s3_key: str, reason: str) -> None:
    """Record why an object could not be read.

    Never clears an existing CRC. An object verified a month ago and
    unreachable for the last five minutes is still an object whose CRC we
    know, and dropping it would make a working export go back to
    `preparing` over a network blip.
    """
    row = get_checksum(db, s3_key)
    if row is None:
        row = ObjectChecksum(s3_key=s3_key, attempts=1)
        db.add(row)
    row.error = (reason or "")[:500]
    row.updated_at = datetime.now(timezone.utc)
    try:
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("could not record a CRC failure for %s", s3_key)


# ── the work queue ─────────────────────────────────────────────────────────

def downloadable_keys_for_media_file(media_file) -> list[str]:
    """Every stored object a BATCH download may contain for this row.

    Mirrors `zip_export_service.source_key_for`, which is the single place
    that decides which object backs which variant — `raw` (falling back to
    the processed derivative for a still with no raw key, exactly as that
    function does) and §57's persisted 1080p proxy. Anything else needs
    ffmpeg and is not offered in a batch, so it has no CRC to compute.

    Derived here rather than imported from that module to avoid a cycle
    (zip_export_service already imports from s3_service, and this is called
    from a task that imports both); the shapes are asserted to agree in
    tests/test_object_crc.py.
    """
    keys = []
    raw = getattr(media_file, "s3_key_raw", None) or getattr(
        media_file, "s3_key_processed", None
    )
    if raw:
        keys.append(raw)
    proxy = getattr(media_file, "proxy_1080p_key", None)
    if proxy:
        keys.append(proxy)
    return list(dict.fromkeys(keys))


def needs_checksum(db: Session, s3_keys: Iterable[str]) -> list[str]:
    """Which of these keys still have to be read, in the given order.

    Skips anything already verified — never re-reads one — and anything
    that has exhausted `crc_max_attempts`, so a deleted object cannot
    occupy the backfill forever.
    """
    rows = get_checksums(db, s3_keys)
    out = []
    for key in dict.fromkeys(k for k in s3_keys if k):
        row = rows.get(key)
        if is_verified(row) or has_given_up(row):
            continue
        out.append(key)
    return out
