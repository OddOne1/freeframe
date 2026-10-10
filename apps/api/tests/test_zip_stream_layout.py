"""The streamed archive's layout, checked by extracting it (§217).

Nothing here asserts on source text or on a byte count someone typed out.
Every test builds a REAL archive from `services/zip_stream.layout`, hands it
to Python's own `zipfile` — and, where the binaries exist, to `unzip -t` and
`7z t` — and asks whether the contents come back byte-identical with valid
CRCs. A layout that is wrong by one byte fails that, and a layout that is
merely described wrongly does not.

The second half is the property that makes resume possible at all:

    for ANY sub-range [a, b], the bytes served equal
    full_archive[a : b + 1]

tested over several hundred random ranges plus every boundary that matters
(inside a header, inside file data, exactly on a segment edge, inside the
central directory, inside the end records) — because the failure mode of
getting that wrong is not an error, it is an archive that extracts to
subtly corrupt files.
"""
import io
import random
import shutil
import subprocess
import zipfile
import zlib
from datetime import datetime, timezone

import pytest

from apps.api.services.zip_stream import (
    Entry,
    archive_etag,
    byte_range,
    dos_timestamp,
    layout,
    render,
    zip64_required,
)


def _entry(path: str, data: bytes, *, when=None) -> tuple[Entry, bytes]:
    t, d = dos_timestamp(when or datetime(2026, 3, 4, 5, 6, 8, tzinfo=timezone.utc))
    return (
        Entry(
            path=path,
            size=len(data),
            crc32=zlib.crc32(data) & 0xFFFFFFFF,
            dos_time=t,
            dos_date=d,
            s3_key=f"raw/{path}",
        ),
        data,
    )


def _assemble(l, blobs: dict[str, bytes], start: int = 0, end: int = None) -> bytes:
    """Serve [start, end] exactly the way the endpoint will.

    Deliberately goes through `byte_range` and `render` rather than
    concatenating a known-good archive: this IS the serving path, so a test
    that bypassed it would be testing a second implementation.
    """
    if end is None:
        end = l.total_size - 1
    out = bytearray()
    for seg, lo, hi in byte_range(l, start, end):
        if seg.is_data:
            out += blobs[l.entries[seg.index].path][lo : hi + 1]
        else:
            out += render(l, seg)[lo : hi + 1]
    return bytes(out)


def _world(*, zip64: bool):
    """A handful of entries covering the cases a real selection has.

    An empty file is in here on purpose: it contributes a local header and a
    central record but NO data segment, and a range walk that emitted a
    zero-length segment would double-count the boundary between the two
    headers around it.
    """
    pairs = [
        _entry("clip.mov", b"the original bytes of a clip" * 7),
        _entry("Sub/inner.mov", bytes(range(256)) * 3),
        _entry("Sub/Deeper/still.jpg", b"\xff\xd8\xff" + b"jpegish" * 11),
        _entry("empty.txt", b""),
        _entry("name with spaces and ümlauts.mp4", b"x" * 1024),
        _entry("one.bin", b"\x00"),
    ]
    entries = [e for e, _ in pairs]
    blobs = {e.path: b for e, b in pairs}
    kwargs = {"size_limit": 300, "entry_limit": 4} if zip64 else {}
    l = layout(entries, **kwargs)
    assert l.zip64 is zip64, "the fixture did not get the layout it asked for"
    return l, blobs


# ── it is a zip, and it is the right zip ────────────────────────────────────

@pytest.mark.parametrize("zip64", [False, True])
def test_the_whole_archive_opens_and_every_member_is_byte_identical(zip64):
    l, blobs = _world(zip64=zip64)
    archive = _assemble(l, blobs)

    assert len(archive) == l.total_size, "Content-Length would have been a lie"

    with zipfile.ZipFile(io.BytesIO(archive)) as zf:
        assert zf.testzip() is None, "a member failed its own CRC"
        assert [i.filename for i in zf.infolist()] == [e.path for e in l.entries]
        for entry in l.entries:
            assert zf.read(entry.path) == blobs[entry.path], entry.path
            info = zf.getinfo(entry.path)
            assert info.compress_type == zipfile.ZIP_STORED
            assert info.file_size == entry.size
            assert info.CRC == entry.crc32


@pytest.mark.parametrize("zip64", [False, True])
def test_the_timestamp_survives_into_the_archive(zip64):
    """The entry's own `created_at`, not "now" — a timestamp that moved
    between two requests would change header bytes a resume splices."""
    l, blobs = _world(zip64=zip64)
    with zipfile.ZipFile(io.BytesIO(_assemble(l, blobs))) as zf:
        for info in zf.infolist():
            assert info.date_time == (2026, 3, 4, 5, 6, 8), info.filename


@pytest.mark.parametrize("zip64", [False, True])
def test_the_filenames_are_flagged_utf8(zip64):
    """Bit 11, in BOTH the local header and the central record. Python
    compares the two names after decoding each by its own flag, so a
    mismatch raises rather than mojibakes — which is why `read()` of the
    umlaut entry above passing is itself part of this check."""
    l, blobs = _world(zip64=zip64)
    with zipfile.ZipFile(io.BytesIO(_assemble(l, blobs))) as zf:
        for info in zf.infolist():
            assert info.flag_bits & 0x800, info.filename


@pytest.mark.parametrize("zip64", [False, True])
def test_a_real_extractor_verifies_it(tmp_path, zip64):
    """`zipfile` is one reader with one set of opinions. unzip and 7z are
    the ones the owner's recipients will actually use."""
    l, blobs = _world(zip64=zip64)
    path = tmp_path / "bundle.zip"
    path.write_bytes(_assemble(l, blobs))

    ran = []
    for binary, args in (("unzip", ["-t"]), ("7z", ["t"]), ("7zz", ["t"])):
        found = shutil.which(binary)
        if not found:
            continue
        proc = subprocess.run(
            [found, *args, str(path)], capture_output=True, text=True, timeout=120
        )
        assert proc.returncode == 0, f"{binary}: {proc.stdout}\n{proc.stderr}"
        ran.append(binary)

    if not ran:
        pytest.skip("neither unzip nor 7z is installed here")


# ── resume equivalence: the property the whole design rests on ─────────────

def _boundaries(l) -> list[int]:
    """Every offset where the answer changes, and its neighbours."""
    out = {0, l.total_size - 1}
    for seg in l.segments:
        for candidate in (
            seg.offset - 1, seg.offset, seg.offset + 1,
            seg.end - 1, seg.end, seg.end + 1,
        ):
            if 0 <= candidate < l.total_size:
                out.add(candidate)
    return sorted(out)


@pytest.mark.parametrize("zip64", [False, True])
def test_every_sub_range_equals_the_same_slice_of_the_whole(zip64):
    l, blobs = _world(zip64=zip64)
    whole = _assemble(l, blobs)
    total = l.total_size

    cases: list[tuple[int, int]] = []

    # Every boundary, paired with itself and with its neighbours — a range
    # that begins or ends exactly on a segment edge is where an inclusive/
    # exclusive slip hides.
    bounds = _boundaries(l)
    for b in bounds:
        cases.append((b, b))
        cases.append((b, min(b + 1, total - 1)))
        cases.append((max(b - 1, 0), b))
        cases.append((b, total - 1))
        cases.append((0, b))
    # And every boundary-to-boundary pair, which covers "begins inside a
    # header and ends inside the central directory" without naming it.
    for i, a in enumerate(bounds):
        for b in bounds[i:]:
            cases.append((a, b))

    rnd = random.Random(217)
    for _ in range(250):
        a = rnd.randrange(total)
        b = rnd.randrange(a, total)
        cases.append((a, b))

    assert len(cases) >= 200, f"only {len(cases)} ranges; the property is undertested"

    for a, b in cases:
        got = _assemble(l, blobs, a, b)
        assert got == whole[a : b + 1], f"range {a}-{b} ({b - a + 1} bytes)"


@pytest.mark.parametrize("zip64", [False, True])
def test_a_download_assembled_from_several_ranges_is_the_same_archive(zip64):
    """What a resumed download actually does: stop at an arbitrary byte,
    come back with `bytes=<that>-`, repeat, concatenate."""
    l, blobs = _world(zip64=zip64)
    whole = _assemble(l, blobs)

    rnd = random.Random(2171)
    for attempt in range(12):
        out = bytearray()
        while len(out) < l.total_size:
            remaining = l.total_size - len(out)
            take = rnd.randrange(1, remaining + 1)
            out += _assemble(l, blobs, len(out), len(out) + take - 1)
        assert bytes(out) == whole, f"attempt {attempt}"
        with zipfile.ZipFile(io.BytesIO(bytes(out))) as zf:
            assert zf.testzip() is None


@pytest.mark.parametrize("zip64", [False, True])
def test_the_segments_tile_the_archive_with_no_gaps_or_overlaps(zip64):
    """The invariant `byte_range` relies on. Stated separately because a
    gap would show up as a short response rather than a wrong byte, and a
    short response is easy to misread as a slow network."""
    l, _ = _world(zip64=zip64)
    cursor = 0
    for seg in l.segments:
        assert seg.length > 0, f"zero-length {seg.kind} segment at {seg.offset}"
        assert seg.offset == cursor, f"{seg.kind} at {seg.offset}, expected {cursor}"
        cursor += seg.length
    assert cursor == l.total_size


# ── the zip64 rule ─────────────────────────────────────────────────────────

def test_a_small_archive_does_not_use_zip64():
    """Not decoration: zip64 everywhere would hide a wrong threshold, since
    a zip64 archive is valid for small files too."""
    entries = [_entry("a.bin", b"a" * 10)[0]]
    assert layout(entries).zip64 is False


def test_an_entry_over_the_size_limit_forces_zip64():
    entries = [_entry("a.bin", b"a" * 10)[0]]
    assert layout(entries, size_limit=5).zip64 is True


def _fields(**overrides):
    base = dict(
        entry_sizes=[10, 20],
        header_offsets=[0, 40],
        central_offset=100,
        central_size=50,
        entry_count=2,
        size_limit=1000,
        entry_limit=100,
    )
    base.update(overrides)
    return base


def test_a_layout_well_inside_the_limits_needs_no_zip64():
    """Non-vacuous guard: without this, every assertion below could be
    passing because the predicate always returns a reason."""
    assert zip64_required(**_fields()) is None


@pytest.mark.parametrize(
    "field,at_the_limit,inside",
    [
        ("entry_count", 100, 99),
        ("central_offset", 1000, 999),
        ("central_size", 1000, 999),
    ],
)
def test_each_scalar_field_at_exactly_the_limit_forces_zip64(field, at_the_limit, inside):
    """THE boundary, and it is not off-by-one pedantry: 0xFFFFFFFF and
    0xFFFF are the ESCAPE values that mean "the real number is in the zip64
    extra field". A field holding one cannot say so, which is why the rule
    is `>=` and never `>`."""
    assert zip64_required(**_fields(**{field: at_the_limit})) == {
        "entry_count": "entry count",
        "central_offset": "central directory offset",
        "central_size": "central directory size",
    }[field]
    assert zip64_required(**_fields(**{field: inside})) is None


@pytest.mark.parametrize(
    "field,reason", [("entry_sizes", "entry size"), ("header_offsets", "local header offset")]
)
def test_each_per_entry_field_at_exactly_the_limit_forces_zip64(field, reason):
    """These two clauses are unreachable through `layout()` — the central
    directory's own offset is the sum of every header and every entry, so
    it trips first — which is exactly why they are tested here rather than
    through an archive. See `zip64_required`'s docstring."""
    assert zip64_required(**_fields(**{field: [10, 1000]})) == reason
    assert zip64_required(**_fields(**{field: [10, 999]})) is None


def test_the_predicate_and_the_layout_agree():
    """The wiring between the two, so neither can be right alone."""
    entries = [_entry(f"f{i}.bin", b"x" * 40)[0] for i in range(4)]
    plain = layout(entries)
    assert plain.zip64 is False
    # Exactly at the central-directory offset: the escape value case.
    assert layout(entries, size_limit=plain.central_offset).zip64 is True
    assert layout(entries, size_limit=plain.central_offset + 1).zip64 is False


def test_an_entry_count_exactly_at_the_limit_forces_zip64():
    entries = [_entry(f"f{i}.bin", b"x")[0] for i in range(6)]
    assert layout(entries, entry_limit=6).zip64 is True
    assert layout(entries, entry_limit=7).zip64 is False


def test_too_many_entries_forces_zip64():
    entries = [_entry(f"f{i}.bin", b"x")[0] for i in range(6)]
    assert layout(entries, entry_limit=6).zip64 is True
    assert layout(entries, entry_limit=7).zip64 is False


def test_a_central_directory_pushed_past_the_limit_forces_zip64():
    """The case that is easy to miss: no single entry is too big, but their
    headers and data together push the central directory's own offset past
    what the classic EOCD can hold."""
    entries = [_entry(f"f{i}.bin", b"x" * 40)[0] for i in range(4)]
    plain = layout(entries)
    assert plain.zip64 is False
    assert layout(entries, size_limit=plain.central_offset).zip64 is True
    assert layout(entries, size_limit=plain.central_offset + 1).zip64 is False


def test_zip64_is_all_or_nothing():
    """Once chosen it is chosen for the whole archive — every local header
    and every central record carries the extra field, so each one grows by
    the same fixed amount. A per-entry decision would make the difference
    depend on which entries overflowed."""
    entries = [e for e, _ in [_entry(f"f{i}.bin", b"x" * 8) for i in range(5)]]
    classic = layout(entries)
    big = layout(entries, size_limit=4)
    assert big.zip64 and not classic.zip64

    headers_classic = [s for s in classic.segments if s.kind == "header"]
    headers_zip64 = [s for s in big.segments if s.kind == "header"]
    growth = {z.length - c.length for c, z in zip(headers_classic, headers_zip64)}
    assert growth == {20}, growth

    central_classic = [s for s in classic.segments if s.kind == "central"]
    central_zip64 = [s for s in big.segments if s.kind == "central"]
    growth = {z.length - c.length for c, z in zip(central_classic, central_zip64)}
    assert growth == {28}, growth


# ── the ETag ───────────────────────────────────────────────────────────────

def test_the_etag_changes_with_anything_that_moves_a_byte():
    base, _ = _entry("a.bin", b"hello")
    assert archive_etag([base]) == archive_etag([base])

    for field, value in (
        ("path", "b.bin"),
        ("size", 6),
        ("crc32", 1),
        ("dos_time", 0),
        ("dos_date", 33),
        ("s3_key", "raw/other"),
    ):
        changed = Entry(**{**base.__dict__, field: value})
        assert archive_etag([changed]) != archive_etag([base]), field


def test_the_etag_depends_on_order():
    a, _ = _entry("a.bin", b"one")
    b, _ = _entry("b.bin", b"two")
    assert archive_etag([a, b]) != archive_etag([b, a])


# ── timestamps ─────────────────────────────────────────────────────────────

def test_a_naive_timestamp_is_read_as_utc():
    assert dos_timestamp(datetime(2026, 3, 4, 5, 6, 8)) == dos_timestamp(
        datetime(2026, 3, 4, 5, 6, 8, tzinfo=timezone.utc)
    )


@pytest.mark.parametrize(
    "value",
    [None, datetime(1970, 1, 1, tzinfo=timezone.utc), datetime(2200, 1, 1, tzinfo=timezone.utc)],
)
def test_an_unrepresentable_timestamp_clamps_rather_than_wrapping(value):
    """MS-DOS cannot hold these, and the failure is silent: the year wraps
    into a different one. Clamped, not rejected — a strange `created_at`
    must not make a file undownloadable."""
    t, d = dos_timestamp(value)
    assert (t, d) == (0, (1 << 5) | 1)
    # And it is a date `zipfile` will actually accept.
    entries = [Entry("a.bin", 1, zlib.crc32(b"x") & 0xFFFFFFFF, t, d, "raw/a")]
    l = layout(entries)
    with zipfile.ZipFile(io.BytesIO(_assemble(l, {"a.bin": b"x"}))) as zf:
        assert zf.getinfo("a.bin").date_time == (1980, 1, 1, 0, 0, 0)
