"""One part-size policy for every multipart upload (§213).

Two initiate endpoints create multipart uploads — `POST /upload/initiate`
and `POST /assets/{id}/versions` — and before this module they each
hard-coded nothing at all: the part size was whatever the CLIENT chose
(web 10 MiB, desktop 16 MiB), and the only size check was a
hand-written `MAX_FILE_SIZE_BYTES = 2000 GiB` that no part arithmetic
could honour. A 2000 GiB file was accepted by the server and then died
on the client at part 10,001, hours in.

So the maximum file size was a lie in both directions: the number the
server advertised could not be uploaded, and the number that could be
was never stated anywhere.

This module makes the ceiling arithmetic rather than opinion:

    part_size  = max(MIN_PART_BYTES, ceil(size / PART_DIVISOR) -> whole MiB)
    capped at   settings.upload_max_part_bytes
    total_parts = ceil(size / part_size)      and must be <= 10,000

and the effective maximum file size is therefore
`upload_max_part_bytes * 10_000` — a CONFIG VALUE, not a constant in
code. Raising that one setting is the only edit needed to lift the
ceiling, which is what §214 (moving part PUTs off the Cloudflare route
that 413s anything over ~100 MB) will want to do.

── Why the smallest part that fits ──────────────────────────────────────
A failed part costs its own bytes, re-read and re-sent. Picking one huge
part size for everything would make a small file's single retry
expensive for no reason, so the rule is: stay at the 16 MiB floor until
the file is big enough to need more, then grow only as much as 9,500
parts requires. The 500-part headroom under S3's 10,000 is deliberate —
it absorbs the rounding up to a whole MiB without ever landing on the
limit itself.
"""

# Kept importable on older interpreters: this module is pure arithmetic
# and is the one piece of §213 that can be checked without the whole app
# stack around it.
from __future__ import annotations

from dataclasses import dataclass

MIB = 1024 * 1024

#: S3/AIStor's own hard limits. Not ours to change.
S3_MAX_PARTS = 10_000
S3_MIN_PART_BYTES = 5 * MIB

#: The part count the divisor aims for, leaving 500 parts of headroom under
#: S3_MAX_PARTS for the round-up-to-a-whole-MiB below.
PART_DIVISOR = 9_500

#: Never go below this, however small the file. A 16 MiB part is a cheap
#: retry and keeps part counts sane for the common case.
MIN_PART_BYTES = 16 * MIB


class UploadTooLarge(Exception):
    """This file cannot be uploaded under the configured part ceiling.

    Carries the three numbers the caller has to put in front of a user:
    what was asked for, what is possible, and why. Raised BEFORE any
    multipart upload is created and before any database row exists, so a
    refusal leaves nothing behind.
    """

    def __init__(self, size_bytes: int, max_bytes: int, max_part_bytes: int):
        self.size_bytes = size_bytes
        self.max_bytes = max_bytes
        self.max_part_bytes = max_part_bytes
        super().__init__(self.detail)

    @property
    def detail(self) -> str:
        # Two decimals and the exact byte counts, because one decimal is
        # not enough to tell a refused file from the limit it missed: a
        # file one byte over the 878.906 GiB ceiling rendered as
        # "This file is 878.9 GiB. The maximum upload size is 878.9 GiB",
        # which reads as a bug rather than as an answer.
        gib = lambda n: n / 1024 ** 3  # noqa: E731 — one-line formatter
        return (
            f"This file is {gib(self.size_bytes):.2f} GiB "
            f"({self.size_bytes:,} bytes). The maximum upload size is "
            f"{gib(self.max_bytes):.2f} GiB ({self.max_bytes:,} bytes), which is "
            f"{S3_MAX_PARTS:,} parts of {self.max_part_bytes / MIB:.0f} MiB — "
            "the part size is capped by the upload route, not by storage."
        )


@dataclass(frozen=True)
class PartPlan:
    part_size: int
    total_parts: int


def _cap() -> int:
    """The configured per-part ceiling, read live.

    Read through `settings` at call time rather than captured at import:
    a test that moves the ceiling must be able to move it, and that test
    is the proof that §214 only has to change this one value.
    """
    from ..config import settings

    configured = int(getattr(settings, "upload_max_part_bytes", 0) or 0)
    # A cap below S3's own minimum part size would make every multi-part
    # upload invalid at the store. Clamp rather than fail: a mistyped env
    # var should degrade to the smallest legal part, not refuse every
    # upload on the instance.
    return max(configured, S3_MIN_PART_BYTES)


def _operator_max() -> int | None:
    from ..config import settings

    raw = getattr(settings, "upload_max_file_bytes", None)
    if raw in (None, "", 0):
        return None
    return int(raw)


def max_file_bytes() -> int:
    """The largest file this instance can actually accept, right now.

    `upload_max_part_bytes * 10,000`, unless an operator has set a LOWER
    bound with `upload_max_file_bytes`. Nothing may raise the ceiling
    above what the part arithmetic can honour — that is the shape of the
    old 2000 GiB lie.
    """
    arithmetic = _cap() * S3_MAX_PARTS
    operator = _operator_max()
    return min(arithmetic, operator) if operator is not None else arithmetic


def plan_parts(file_size_bytes: int) -> PartPlan:
    """How this file should be split, or `UploadTooLarge` if it cannot be.

    Guarantees, for any accepted size:
      * `part_size >= S3_MIN_PART_BYTES` (and `>= MIN_PART_BYTES` unless
        the configured cap is lower than the floor)
      * `part_size <= ` the configured cap
      * `total_parts <= S3_MAX_PARTS`
      * `part_size * total_parts >= size` — every byte is covered
      * `(total_parts - 1) * part_size < size` — no part is empty
    """
    size = int(file_size_bytes)
    if size < 0:
        raise ValueError("file size cannot be negative")

    cap = _cap()
    operator = _operator_max()
    if operator is not None and size > operator:
        raise UploadTooLarge(size, max_file_bytes(), cap)

    # ceil(size / PART_DIVISOR), then up to a whole MiB. Whole MiB because
    # a part size of 20,131,787 bytes is a number nobody can check by eye,
    # and the cost of rounding up is a handful of parts.
    aimed = -(-size // PART_DIVISOR) if size else 0
    whole_mib = -(-aimed // MIB) * MIB
    part_size = max(MIN_PART_BYTES, whole_mib)
    if part_size > cap:
        part_size = cap
    # A cap below the floor is legal (an operator may have reasons); the
    # clamp in _cap() already keeps it at or above S3's minimum.
    part_size = max(part_size, S3_MIN_PART_BYTES)

    total_parts = max(1, -(-size // part_size))
    if total_parts > S3_MAX_PARTS:
        raise UploadTooLarge(size, max_file_bytes(), cap)

    return PartPlan(part_size=part_size, total_parts=total_parts)
