"""What makes a multipart upload a whole file (§236).

`/upload/complete` used to hand `CompleteMultipartUpload` the part list
the BROWSER sent. S3 checks each listed ETag against a part it holds; it
does not check that the list is the whole file. A client that omits a
part — a bug, a lost response, a resume that skipped one — therefore gets
a `200` and an object assembled from the parts it named, which §180 then
reconciles to the truncated size and the transcoder processes as if it
were whole. The user's master is silently short.

So the list is built HERE, from `list_multipart_parts(..., strict=True)`,
and checked against the size the version itself declared at initiate.
Everything in this module is about that one question — is what the store
holds the whole file? — and about saying so in a shape the two clients can
act on.

Also here: the gone-upload codes, so `/upload/complete` and
`/upload/abort` agree on what "this upload no longer exists at the store"
looks like rather than each keeping its own list.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: Error codes that mean "(key, upload_id) names no multipart upload".
#:
#: `NoSuchKey`, `404` and `NotFound` are in here beside `NoSuchUpload`
#: because stores disagree about which one an unknown UploadId produces.
#: `services/s3_service.list_multipart_parts` already maps the first two
#: to `NoSuchUploadError`; this set is for the calls that have no such
#: wrapper (`complete_multipart_upload`, `abort_multipart_upload`), so the
#: router can ask one question instead of matching codes in two places.
UPLOAD_GONE_CODES = frozenset({"NoSuchUpload", "NoSuchKey", "404", "NotFound"})

#: Store-side refusals of a part list that is syntactically whole but that
#: the store will not assemble. Mapped to 409 rather than 502: retrying the
#: same request cannot help, and the upload stays open so a client can
#: re-send the offending part.
PART_REFUSAL_CODES = frozenset({
    "InvalidPart", "InvalidPartOrder", "EntityTooSmall", "InvalidRequest",
})


def is_upload_gone(err) -> bool:
    """Does this `ClientError` mean the multipart upload is not there?"""
    code = str((getattr(err, "response", None) or {}).get("Error", {}).get("Code", ""))
    return code in UPLOAD_GONE_CODES


def error_code_of(err) -> str:
    return str((getattr(err, "response", None) or {}).get("Error", {}).get("Code", ""))


class PartsIncomplete(Exception):
    """What the store holds is not the whole file.

    Carries the numbers a client needs to resume and an operator needs to
    read a log line: which part numbers are missing, how many bytes the
    store holds and how many the version declared.

    Deliberately NOT a reason to abort anything. The upload stays open at
    the store and the version stays `uploading`, because the honest state
    of a file with a part missing is "unfinished", not "failed" — and the
    bytes that did arrive are often hours of transfer.
    """

    #: The code both clients branch on. Web re-enters its resume path on it.
    code = "parts_incomplete"

    def __init__(
        self,
        message: str,
        *,
        missing: list[int] | None = None,
        missing_count: int | None = None,
        stored_bytes: int | None = None,
        declared_bytes: int | None = None,
        listed: int | None = None,
    ):
        super().__init__(message)
        self.message = message
        self.missing = missing
        self.missing_count = missing_count
        self.stored_bytes = stored_bytes
        self.declared_bytes = declared_bytes
        self.listed = listed

    #: At most this many part numbers are named individually. A 9,500-part
    #: upload that lost its first part would otherwise put 9,499 integers in
    #: a response body and a log line; past a handful the count is the
    #: actionable part, and the client re-lists `GET /upload/parts` anyway.
    MAX_NAMED_MISSING = 32

    @property
    def detail(self) -> dict:
        """The 409 body, as `schemas.upload.UploadErrorDetail` describes it."""
        from ..schemas.upload import UploadErrorDetail

        missing = self.missing
        named: list[int] | None = None
        count = self.missing_count
        if missing is not None:
            count = len(missing)
            if count <= self.MAX_NAMED_MISSING:
                named = missing
        return UploadErrorDetail(
            code=self.code,
            message=self.message,
            missing=named,
            missing_count=count,
        ).model_dump(exclude_none=True)

    @property
    def log_note(self) -> str:
        """One line for the operator. No ETags — see `parts_for_completion`."""
        return (
            f"{self.message} (listed={self.listed}, stored_bytes={self.stored_bytes}, "
            f"declared_bytes={self.declared_bytes}, missing_count={self.missing_count})"
        )


def parts_for_completion(stored: list[dict], declared_bytes: int) -> list[dict]:
    """The `MultipartUpload.Parts` list for a file the store holds in full.

    `stored` is `list_multipart_parts`' answer — PartNumber / ETag / Size /
    LastModified. The returned list carries only PartNumber and ETag,
    because that is all `CompleteMultipartUpload` accepts and passing the
    rest through is how a `LastModified` ends up in an XML body.

    Two checks, and only two:

    * **Part numbers are exactly 1..N.** A gap is a part that never
      arrived, and completing around it is the truncation this whole
      change exists to stop.
    * **The sizes total `declared_bytes`** — the size the version recorded
      at initiate.

    NOTHING HERE LOOKS AT THE PART SIZE, and that is deliberate. Upstream
    also requires every part but the last to be the same size (Cloudflare
    R2 enforces it). We do not, because it is a second way to refuse a
    file that is actually whole: a resumed upload may legitimately mix part
    sizes across runs, `settings.upload_max_part_bytes` can move between
    two runs of the same file (§214 will move it), and an older client that
    chose its own 10 MiB against a 16 MiB plan is still sending a complete
    file. Contiguity and the byte total already answer "is this the whole
    file?" without an opinion about how it was cut.

    A declared size of 0 is a legal file and is handled by the same two
    rules: the store must hold exactly part 1, of 0 bytes. An empty listing
    is NOT accepted for it — `CompleteMultipartUpload` needs at least one
    part, so there is nothing that could be completed.

    Raises `PartsIncomplete`, whose `detail` is the 409 body.
    """
    declared = int(declared_bytes or 0)

    by_number: dict[int, list[dict]] = {}
    for part in stored:
        by_number.setdefault(int(part["PartNumber"]), []).append(part)
    numbers = sorted(by_number)

    if not numbers:
        raise PartsIncomplete(
            "No uploaded parts were found for this upload. Send the file's parts, "
            "then complete it again.",
            missing=[1],
            stored_bytes=0,
            declared_bytes=declared,
            listed=0,
        )

    expected = list(range(1, numbers[-1] + 1))
    if numbers != expected:
        missing = sorted(set(expected) - set(numbers))
        raise PartsIncomplete(
            f"This upload is missing {len(missing)} part(s), starting at part "
            f"{missing[0]}. Send the missing parts, then complete it again.",
            missing=missing,
            stored_bytes=sum(int(p.get("Size") or 0) for p in stored),
            declared_bytes=declared,
            listed=len(numbers),
        )

    # A part number the store lists TWICE cannot be resolved here. Choosing
    # between two writes of the same part needs the ETag to be matched
    # against the bytes that were meant, which is exactly what cannot be
    # checked from this side — and picking the stale one assembles the wrong
    # file silently. Refusing is the only honest answer; it reads as
    # `parts_incomplete` because the client's move is the same (re-list, and
    # if it persists, upload again) and because a second code would be a
    # second branch in two clients for a case our store does not produce.
    duplicated = [n for n in numbers if len(by_number[n]) > 1]
    if duplicated:
        raise PartsIncomplete(
            f"Storage reported part {duplicated[0]} more than once, so this upload "
            "cannot be assembled safely. Please upload this file again.",
            # No part numbers: nothing is missing, and naming the duplicate
            # as "missing" would send a client to re-upload a part that is
            # already there twice.
            missing=None,
            stored_bytes=sum(int(p.get("Size") or 0) for p in stored),
            declared_bytes=declared,
            listed=len(numbers),
        )

    parts = [by_number[n][0] for n in numbers]
    total = sum(int(p.get("Size") or 0) for p in parts)
    if total != declared:
        # No part numbers are named: every part the store knows about is
        # present and contiguous, so "which part" has no answer — the bytes
        # simply do not add up to the file the version declared. A short
        # last part, a part overwritten with fewer bytes, or a client that
        # declared a size it never sent all land here.
        raise PartsIncomplete(
            f"The {len(parts)} uploaded part(s) total {total:,} bytes but this file was "
            f"declared as {declared:,} bytes. Send the rest of the file, then complete "
            "it again.",
            missing_count=None,
            stored_bytes=total,
            declared_bytes=declared,
            listed=len(parts),
        )

    missing_etag = [p["PartNumber"] for p in parts if not p.get("ETag")]
    if missing_etag:
        # The store listed a part without an ETag. Completion needs one per
        # part, and inventing or omitting it would either fail at the store
        # or silently drop the part from the object.
        raise PartsIncomplete(
            f"Storage listed part {missing_etag[0]} without an ETag, so this upload "
            "cannot be completed. Send that part again, then complete it again.",
            missing=missing_etag,
            stored_bytes=total,
            declared_bytes=declared,
            listed=len(parts),
        )

    return [{"PartNumber": int(p["PartNumber"]), "ETag": p["ETag"]} for p in parts]


def note_client_disagreement(client_parts, stored_parts, version_id, key) -> None:
    """Log when the client's list and the store's differ (§236).

    COUNTS ONLY. The ETags are the one thing in either list that is
    sensitive-adjacent — they are the handles a replayed completion would
    need — and they are also the least informative thing to read in a log.
    What an operator wants from this line is whether a client is routinely
    under-reporting, which is a number.

    The client's `parts` field is still accepted (an older client always
    sends it) and is never used to build the completion, so this is pure
    observation: nothing branches on it.
    """
    if not client_parts:
        return
    if len(client_parts) == len(stored_parts):
        return
    logger.warning(
        "upload %s (key %s): client reported %d part(s), the store holds %d — "
        "completing from the store's list",
        version_id, key, len(client_parts), len(stored_parts),
    )
