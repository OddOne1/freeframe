"""The byte layout of a ZIP_STORED archive, as a pure function (§217).

Today a batch download is BUILT and then downloaded: `tasks/zip_tasks.py`
copies every selected object to the worker's temp disk, writes a
`ZIP_STORED` archive there and uploads it back to S3. At the owner's real
sizes that cannot finish — the task's own ceiling is 21 minutes and a 641
GiB selection is arithmetically impossible — and the finished archive needs
its own size in free temp disk plus a second copy in the bucket for three
days.

This module is the other half of the answer. A `ZIP_STORED` archive (no
compression, which is what the existing code already writes) has a layout
that is a PURE FUNCTION of the ordered list of entries — path, size,
CRC-32, DOS timestamp — plus the zip64 rules. Nothing about it depends on
reading a single byte of file data. So every byte of the archive is
determinable up front:

    offset 0  ┌──────────────────┐
              │ local header  #0 │  synthetic, computed here
              ├──────────────────┤
              │ file data     #0 │  a byte range of an S3 object
              ├──────────────────┤
              │ local header  #1 │
              │ ...              │
              ├──────────────────┤
              │ central dir   #0 │  synthetic
              │ central dir   #1 │
              ├──────────────────┤
              │ end records      │  synthetic (zip64 EOCD + locator + EOCD)
              └──────────────────┘  == total_size

which is what makes `Range` requests — and therefore resume — possible: a
request for bytes [a, b] is served by walking these segments, emitting
synthetic bytes where the range covers a header, and issuing an S3 `GET`
with the matching `Range` where it covers file data.

NO I/O HAPPENS HERE, deliberately. Everything in this file is a function of
its arguments, which is what lets the resume-equivalence property — the
bytes served for any sub-range equal the same slice of the whole archive —
be tested over hundreds of random ranges with no S3, no database and no
worker in the way.

── Why the CRC is not free, and why we pay for it anyway ────────────────

A stored entry's LOCAL header carries its CRC-32, and the central directory
at the END needs it for every entry. The usual way out is the data
descriptor (general-purpose bit 3): write zeros in the local header and
append the real values after the data. That does not work here, twice over.
The central directory still needs the true values, and a stream RESUMED in
the middle of a file could not produce a descriptor it never computed. So
the CRC is computed once per object, stored, and frozen into the manifest
before the archive is ever offered — see `services/checksum_service.py` and
`tasks/crc_tasks.py`.

── The zip64 rule, stated once ──────────────────────────────────────────

Zip64 is chosen for the WHOLE ARCHIVE — zip64 extra field on every local
header and every central-directory record, plus the zip64 end-of-central-
directory record and its locator — as soon as any one of these does not fit
the classic 32-bit fields:

  * any entry's size                        >= 0xFFFFFFFF
  * any entry's local-header offset         >= 0xFFFFFFFF
  * the central directory's size or offset  >= 0xFFFFFFFF
  * the entry count                         >= 0xFFFF

It is all-or-nothing on purpose. A per-entry decision is legal zip, but it
makes the layout depend on each entry's own position in a way that is far
easier to get subtly wrong, and the saving is 20 bytes per header in a
multi-gigabyte archive.

The decision is made by BUILDING the classic layout first and asking
whether it fits. That resolves the apparent circularity — the thresholds
are about offsets, and offsets depend on whether zip64 is in use — because
zip64 only ever makes offsets LARGER: if the classic layout's own offsets
all fit, the classic layout is correct and is what we serve. The two
limits are parameters rather than constants so the rule can be tested with
real byte strings instead of allocating 4 GiB.
"""
from __future__ import annotations

import hashlib
import json
import struct
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterator, Optional, Sequence

#: The classic zip fields are 32-bit; 0xFFFFFFFF is the escape value that
#: says "read this from the zip64 extra field instead".
ZIP64_SIZE_LIMIT = 0xFFFFFFFF
#: The EOCD's entry counters are 16-bit, with 0xFFFF as the same escape.
ZIP64_ENTRY_LIMIT = 0xFFFF

#: Fixed-part sizes, from APPNOTE 6.3.x §4.3.7, §4.3.12, §4.3.14-16.
_LOCAL_HEADER_FIXED = 30
_CENTRAL_HEADER_FIXED = 46
_EOCD_FIXED = 22
_ZIP64_EOCD_FIXED = 56
_ZIP64_LOCATOR_FIXED = 20

#: The zip64 extra field: header id + size, then 8-byte counters. A LOCAL
#: header carries uncompressed+compressed size; a CENTRAL record carries
#: those two plus the local-header offset.
_ZIP64_LOCAL_EXTRA = 4 + 8 + 8        # 20
_ZIP64_CENTRAL_EXTRA = 4 + 8 + 8 + 8  # 28

#: General-purpose bit 11: the filename is UTF-8. Set unconditionally,
#: because `zip_entry_path` produces real user-supplied folder and asset
#: names and this app has no reason to pretend they are CP437. It must be
#: identical in the local header and the central record — Python's own
#: `zipfile.ZipFile.open` decodes the local name according to the LOCAL
#: flag and then compares it with the central one, so a mismatch is a
#: `BadZipFile` rather than a mojibake name.
_FLAG_UTF8 = 0x800

#: "Version needed to extract": 2.0 for stored entries, 4.5 once zip64 is
#: in play. The high byte of "version made by" is the host system; 3 is
#: Unix, which is what makes `_EXTERNAL_ATTRS` below meaningful.
_VERSION_CLASSIC = 20
_VERSION_ZIP64 = 45
_HOST_UNIX = 3

#: 0o100644 (regular file, rw-r--r--) in the high 16 bits, which is where a
#: Unix-host zip keeps its mode. Without it extractors on Linux and macOS
#: invent a mode, and some invent 0o000.
_EXTERNAL_ATTRS = (0o100644 << 16)

#: MS-DOS cannot represent a date before 1980 or after 2107, and an
#: out-of-range value does not fail loudly — it wraps into a different year.
#: Clamped rather than rejected: a nonsense `created_at` must not make a
#: file undownloadable.
DOS_EPOCH_YEAR = 1980
DOS_MAX_YEAR = 2107


@dataclass(frozen=True)
class Entry:
    """One file's fully-frozen place in the archive.

    Frozen is the operative word. Every field here is baked into bytes that
    a resumed request must reproduce EXACTLY — a different `dos_time` on the
    second request shifts nothing but changes two bytes inside a header, and
    a client splicing the two together gets an archive whose central
    directory disagrees with its local headers. That is why the timestamp
    comes from the asset's `created_at` and never from "now".
    """

    #: Path inside the archive, folder tree included. Produced by
    #: `zip_export_service.zip_entry_path`, which already de-duplicates and
    #: sanitises; this module does not second-guess it.
    path: str
    size: int
    #: Unsigned 32-bit CRC-32 of the object's bytes, as `zlib.crc32` returns.
    crc32: int
    #: MS-DOS packed time and date (see `dos_timestamp`).
    dos_time: int
    dos_date: int
    #: The stored object this entry's data is a byte range of.
    s3_key: str

    def name_bytes(self) -> bytes:
        return self.path.encode("utf-8")


@dataclass(frozen=True)
class Segment:
    """A contiguous run of archive bytes with a single source.

    `offset` and `length` are absolute within the archive, so a segment is
    answerable in isolation: that is the whole point, and it is what lets a
    `Range` request be served without walking the file data of everything
    before it.
    """

    #: "header" | "data" | "central" | "eocd"
    kind: str
    offset: int
    length: int
    #: Index into `Layout.entries`, for every kind except "eocd".
    index: Optional[int] = None
    #: Set for "data" only — the object to issue a ranged GET against.
    s3_key: Optional[str] = None

    @property
    def end(self) -> int:
        """Inclusive last byte. Only meaningful for a non-empty segment."""
        return self.offset + self.length - 1

    @property
    def is_data(self) -> bool:
        return self.kind == "data"


@dataclass(frozen=True)
class Layout:
    """The whole archive, described without reading any of it."""

    entries: tuple[Entry, ...]
    #: In ascending offset order, contiguous, and gapless. Zero-length
    #: segments are omitted — an empty file contributes a header and a
    #: central record but no data segment, and a zero-length segment in the
    #: walk below would be a range the iterator could neither contain nor
    #: skip cleanly.
    segments: tuple[Segment, ...]
    #: Exactly what `Content-Length` must say for a full 200 response.
    total_size: int
    zip64: bool
    central_offset: int
    central_size: int


# ── timestamps ──────────────────────────────────────────────────────────────

def dos_timestamp(value: Optional[datetime]) -> tuple[int, int]:
    """An asset's `created_at` as MS-DOS packed (time, date).

    DERIVED FROM THE ASSET, never from the clock. The bytes of a given
    export have to be identical on every request and every resume, and
    "now" is the one input guaranteed to differ between them.

    A naive datetime is read as UTC, matching how every other timestamp in
    this codebase is stored. `None` and anything outside MS-DOS's
    1980-2107 window clamp to the epoch rather than raising: a file with a
    strange `created_at` must still be downloadable, and two seconds of
    resolution is all the format has anyway.
    """
    if value is None:
        return 0, (1 << 5) | 1  # 1980-01-01 00:00:00

    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    value = value.astimezone(timezone.utc)

    year = value.year
    if year < DOS_EPOCH_YEAR or year > DOS_MAX_YEAR:
        return 0, (1 << 5) | 1

    dos_time = (value.hour << 11) | (value.minute << 5) | (value.second // 2)
    dos_date = ((year - DOS_EPOCH_YEAR) << 9) | (value.month << 5) | value.day
    return dos_time, dos_date


# ── the layout itself ───────────────────────────────────────────────────────

def layout(
    entries: Sequence[Entry],
    *,
    size_limit: int = ZIP64_SIZE_LIMIT,
    entry_limit: int = ZIP64_ENTRY_LIMIT,
) -> Layout:
    """Describe the archive for `entries`, choosing zip64 if it is needed.

    `size_limit` and `entry_limit` exist so the zip64 branch can be tested
    with a handful of short byte strings. Lowering them makes zip64 kick in
    early; nothing else about the layout changes, which is exactly the
    property a test wants to pin.
    """
    classic = _build(entries, zip64=False)
    reason = zip64_required(
        entry_sizes=[e.size for e in classic.entries],
        header_offsets=[s.offset for s in classic.segments if s.kind == "header"],
        central_offset=classic.central_offset,
        central_size=classic.central_size,
        entry_count=len(classic.entries),
        size_limit=size_limit,
        entry_limit=entry_limit,
    )
    if reason is None:
        return classic
    # Zip64 only ever makes offsets larger, so there is no third attempt to
    # make: if the classic layout does not fit, zip64 is the answer.
    return _build(entries, zip64=True)


def zip64_required(
    *,
    entry_sizes: Sequence[int],
    header_offsets: Sequence[int],
    central_offset: int,
    central_size: int,
    entry_count: int,
    size_limit: int = ZIP64_SIZE_LIMIT,
    entry_limit: int = ZIP64_ENTRY_LIMIT,
) -> Optional[str]:
    """Which field does not fit a classic record, or None if they all do.

    Takes raw numbers rather than a `Layout` so every boundary can be
    tested on its own. That is not a convenience: for any archive this
    module lays out, the central-directory checks SUBSUME the per-entry
    ones — `central_offset` is the sum of every header and every entry's
    data, so it exceeds any single entry's size or header offset. The
    per-entry clauses are therefore unreachable from `layout()` alone, and
    a test that could only go through `layout()` could not tell `>=` from
    `>` on them. They are kept because they are what the FORMAT requires
    (APPNOTE §4.4.8, §4.4.16), not what this particular layout happens to
    make redundant, and because they are the clauses that would start
    mattering the moment anything about the layout changed.

    `>=`, never `>`, in all five. 0xFFFFFFFF and 0xFFFF are not merely the
    largest representable values — they are the ESCAPE values that mean
    "the real number is in the zip64 extra field". A field holding one
    literally cannot say so.
    """
    if entry_count >= entry_limit:
        return "entry count"
    if central_offset >= size_limit:
        return "central directory offset"
    if central_size >= size_limit:
        return "central directory size"
    for size in entry_sizes:
        if size >= size_limit:
            return "entry size"
    for offset in header_offsets:
        if offset >= size_limit:
            return "local header offset"
    return None


def _build(entries: Sequence[Entry], *, zip64: bool) -> Layout:
    entries = tuple(entries)
    segments: list[Segment] = []
    local_offsets: list[int] = []
    offset = 0

    local_extra = _ZIP64_LOCAL_EXTRA if zip64 else 0
    for i, entry in enumerate(entries):
        header_len = _LOCAL_HEADER_FIXED + len(entry.name_bytes()) + local_extra
        local_offsets.append(offset)
        segments.append(Segment("header", offset, header_len, i))
        offset += header_len
        if entry.size:
            segments.append(Segment("data", offset, entry.size, i, entry.s3_key))
            offset += entry.size

    central_offset = offset
    central_extra = _ZIP64_CENTRAL_EXTRA if zip64 else 0
    for i, entry in enumerate(entries):
        record_len = _CENTRAL_HEADER_FIXED + len(entry.name_bytes()) + central_extra
        segments.append(Segment("central", offset, record_len, i))
        offset += record_len
    central_size = offset - central_offset

    end_len = _EOCD_FIXED
    if zip64:
        end_len += _ZIP64_EOCD_FIXED + _ZIP64_LOCATOR_FIXED
    segments.append(Segment("eocd", offset, end_len))
    offset += end_len

    return Layout(
        entries=entries,
        segments=tuple(segments),
        total_size=offset,
        zip64=zip64,
        central_offset=central_offset,
        central_size=central_size,
    )


# ── rendering the synthetic segments ────────────────────────────────────────

def render(l: Layout, segment: Segment) -> bytes:
    """The bytes of one non-data segment.

    Always the whole segment, never a slice: the caller slices, so that the
    "assemble the archive" and "serve a range of it" paths render byte-for-
    byte identical headers. A renderer that took a sub-range would be a
    second place for an off-by-one to live.
    """
    if segment.kind == "header":
        out = _local_header(l, segment.index)
    elif segment.kind == "central":
        out = _central_record(l, segment.index)
    elif segment.kind == "eocd":
        out = _end_records(l)
    else:
        raise ValueError(f"{segment.kind} segments carry object data, not bytes")

    # The length in the layout is what Content-Length was computed from, so
    # a renderer that disagreed with it would hand a client a response
    # whose body does not match its own header. Cheap, and it turns an
    # arithmetic slip into an assertion instead of a corrupt archive.
    assert len(out) == segment.length, (
        f"{segment.kind} segment {segment.index}: laid out {segment.length} "
        f"bytes, rendered {len(out)}"
    )
    return out


def _local_header(l: Layout, index: int) -> bytes:
    entry = l.entries[index]
    name = entry.name_bytes()
    if l.zip64:
        sizes = (ZIP64_SIZE_LIMIT, ZIP64_SIZE_LIMIT)
        extra = struct.pack("<HHQQ", 0x0001, 16, entry.size, entry.size)
        version = _VERSION_ZIP64
    else:
        sizes = (entry.size, entry.size)
        extra = b""
        version = _VERSION_CLASSIC

    return (
        b"PK\x03\x04"
        + struct.pack(
            "<5H3I2H",
            version,
            _FLAG_UTF8,
            0,                      # method: stored
            entry.dos_time,
            entry.dos_date,
            entry.crc32,
            sizes[0],               # compressed size
            sizes[1],               # uncompressed size
            len(name),
            len(extra),
        )
        + name
        + extra
    )


def _central_record(l: Layout, index: int) -> bytes:
    entry = l.entries[index]
    name = entry.name_bytes()
    header_offset = next(
        s.offset for s in l.segments if s.kind == "header" and s.index == index
    )
    if l.zip64:
        sizes = (ZIP64_SIZE_LIMIT, ZIP64_SIZE_LIMIT)
        offset_field = ZIP64_SIZE_LIMIT
        # All three counters, always, with all three 32-bit fields escaped.
        # The spec lets a record carry only the ones it needs, but then the
        # record's LENGTH depends on which fields happen to overflow — and
        # the length is what the layout above promised. One shape for every
        # entry is what keeps that promise arithmetic rather than
        # conditional.
        extra = struct.pack("<HHQQQ", 0x0001, 24, entry.size, entry.size, header_offset)
        version = _VERSION_ZIP64
    else:
        sizes = (entry.size, entry.size)
        offset_field = header_offset
        extra = b""
        version = _VERSION_CLASSIC

    return (
        b"PK\x01\x02"
        + struct.pack(
            "<6H3I5H2I",
            (_HOST_UNIX << 8) | version,   # version made by
            version,                       # version needed to extract
            _FLAG_UTF8,
            0,                             # method: stored
            entry.dos_time,
            entry.dos_date,
            entry.crc32,
            sizes[0],
            sizes[1],
            len(name),
            len(extra),
            0,                             # file comment length
            0,                             # disk number start
            0,                             # internal attributes
            _EXTERNAL_ATTRS,
            offset_field,
        )
        + name
        + extra
    )


def _end_records(l: Layout) -> bytes:
    count = len(l.entries)
    out = b""
    if l.zip64:
        out += b"PK\x06\x06" + struct.pack(
            "<QHHIIQQQQ",
            _ZIP64_EOCD_FIXED - 12,        # size of this record, less its own
                                           # signature and size field
            (_HOST_UNIX << 8) | _VERSION_ZIP64,
            _VERSION_ZIP64,
            0,                             # this disk
            0,                             # disk with the central directory
            count,                         # entries on this disk
            count,                         # entries in total
            l.central_size,
            l.central_offset,
        )
        out += b"PK\x06\x07" + struct.pack(
            "<IQI",
            0,                             # disk with the zip64 EOCD
            l.central_offset + l.central_size,   # where that record starts
            1,                             # total number of disks
        )
        counts = (ZIP64_ENTRY_LIMIT, ZIP64_ENTRY_LIMIT)
        cd = (ZIP64_SIZE_LIMIT, ZIP64_SIZE_LIMIT)
    else:
        counts = (count, count)
        cd = (l.central_size, l.central_offset)

    out += b"PK\x05\x06" + struct.pack(
        "<4H2IH",
        0,                                 # this disk
        0,                                 # disk with the central directory
        counts[0],                         # entries on this disk
        counts[1],                         # entries in total
        cd[0],
        cd[1],
        0,                                 # comment length
    )
    return out


# ── the range walk ──────────────────────────────────────────────────────────

def byte_range(l: Layout, start: int, end: int) -> Iterator[tuple[Segment, int, int]]:
    """Which part of which segment answers each byte of `[start, end]`.

    Both bounds are INCLUSIVE, matching an HTTP `Range` header and
    `hls_proxy._parse_range_header`'s return, so there is no off-by-one
    conversion anywhere between the header and the S3 `Range` this
    eventually produces. `inner_start`/`inner_end` are likewise inclusive
    and relative to the segment, which is what an S3 `Range` wants for a
    data segment and what a slice of `render()`'s output wants for the rest.

    Yields nothing for an empty range (`end < start`) rather than raising:
    the caller has already resolved the range against `total_size`, and a
    zero-byte 206 is a legal, if pointless, thing to ask for.
    """
    if end < start:
        return
    for seg in l.segments:
        if seg.offset > end:
            break
        if seg.end < start:
            continue
        inner_start = max(start, seg.offset) - seg.offset
        inner_end = min(end, seg.end) - seg.offset
        yield seg, inner_start, inner_end


# ── identity ────────────────────────────────────────────────────────────────

def archive_etag(entries: Sequence[Entry]) -> str:
    """A strong ETag for the frozen archive: `If-Range`'s whole job.

    Hashed over the ORDERED entries including every field that moves a byte
    — path, size, CRC and timestamp — because the thing a client is asking
    with `If-Range` is "is the archive I started downloading still the
    archive you would send me now?". Order is part of it: the same files in
    a different order is a different archive at the byte level.

    The s3_key deliberately IS included even though it never appears in the
    output bytes. Two manifests identical in every visible field but
    pointing at different objects would serve different data, and an ETag
    that could not tell them apart would let a resume splice one into the
    other.
    """
    payload = [
        [e.path, e.size, e.crc32, e.dos_time, e.dos_date, e.s3_key]
        for e in entries
    ]
    blob = json.dumps(payload, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:32]
