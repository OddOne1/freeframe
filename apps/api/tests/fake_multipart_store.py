"""A faithful in-memory stand-in for the S3 multipart API (§236).

NOT a test module (no `test_` prefix, so pytest collects nothing here).

Real S3 is not available in this sandbox, so the §236 tests drive the
router against this. It is written to be faithful about the ONE behaviour
the whole task turns on, and that behaviour is a *permissive* one:

    **`complete_multipart_upload` happily assembles whatever subset of
    parts it is given.** Naming only part 1 of a three-part upload returns
    success and leaves an object one third the length. That is what AWS S3,
    MinIO and AIStor all do — the API checks each named ETag against a part
    it holds, never that the set is the whole file — and it is why the
    server, not the client, has to decide which parts make the file.

A fake that refused a short list would make every test here pass against
a completely unfixed server, so this one does not refuse.

── What it implements ──────────────────────────────────────────────────
* `create_multipart_upload(Bucket, Key, ContentType)` -> `{"UploadId"}`
* `upload_part(Bucket, Key, UploadId, PartNumber, Body=bytes|size)` ->
  `{"ETag"}`; re-uploading a part replaces it, as a real store does
* `list_parts(Bucket, Key, UploadId, MaxParts, PartNumberMarker)` ->
  `Parts[{PartNumber, ETag, Size, LastModified}]`, `IsTruncated`,
  `NextPartNumberMarker` — real paging, so `list_multipart_parts`'
  paginator is exercised rather than bypassed
* `complete_multipart_upload(...)` -> assembles an object whose
  ContentLength is the SUM OF THE NAMED PARTS' SIZES (hence truncation),
  consumes the upload id, and returns `{"ETag", "Key", "Bucket"}`
* `abort_multipart_upload(...)` -> drops the upload and its parts
* `head_object(Bucket, Key)` -> `{"ContentLength"}`
* `put_object` / `get_object` / `delete_object`, enough for a completed
  object to be inspected

── Errors it raises, with the codes a real store uses ──────────────────
* `NoSuchUpload` for an unknown (Key, UploadId) on list/complete/abort
* `InvalidPart` when a named part is absent or its ETag does not match
* `InvalidPartOrder` when the numbers are not ascending
* `EntityTooSmall` when a part other than the last is under 5 MiB
* `404`/`NoSuchKey` from `head_object` for a key it does not hold

── What it does NOT model ──────────────────────────────────────────────
Credentials and signing, bucket policy, CORS, versioning, storage classes,
multipart ETag composition (a completed object's ETag here is a plain
hex digest, not the `"<md5>-<n>"` composite AWS returns — nothing in
§236 reads it; the size is the integrity signal, see
`_assembled_at_store`), consistency delays, and part-size validation on
upload (only on complete, which is where a real store enforces it).

`ListMultipartUploads` IS modelled since §238 (`list_multipart_uploads`
below), which needs it to find the upload id of an abandoned upload by
key — §215's sweeper still has its own fakes.
"""

from __future__ import annotations

import hashlib
import threading
import uuid
from datetime import datetime, timezone

from botocore.exceptions import ClientError

#: S3's own floor for every part but the last.
MIN_PART_BYTES = 5 * 1024 * 1024


def _error(code: str, op: str, message: str | None = None) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": message or code}}, op
    )


class FakeMultipartStore:
    """One bucket's worth of multipart uploads and finished objects."""

    def __init__(self):
        # (key, upload_id) -> {part_number: {"ETag","Size","LastModified"}}
        self._uploads: dict[tuple[str, str], dict[int, dict]] = {}
        # key -> bytes-length of the assembled object
        self.objects: dict[str, int] = {}
        self._lock = threading.Lock()
        #: Every call made, as (operation, key) — tests assert on this
        #: rather than on mock internals.
        self.calls: list[tuple[str, str]] = []

    # ── test-facing helpers ────────────────────────────────────────────

    def open_uploads(self) -> list[tuple[str, str]]:
        return sorted(self._uploads)

    def part_numbers(self, key: str, upload_id: str) -> list[int]:
        return sorted(self._uploads.get((key, upload_id), {}))

    def seed_upload(self, key: str, upload_id: str, sizes: dict[int, int]) -> None:
        """Plant an in-progress upload holding parts of the given sizes."""
        self._uploads[(key, upload_id)] = {
            n: {
                "ETag": f'"{hashlib.md5(f"{key}:{n}:{size}".encode()).hexdigest()}"',
                "Size": int(size),
                "LastModified": datetime.now(timezone.utc),
            }
            for n, size in sizes.items()
        }

    def count(self, operation: str) -> int:
        return sum(1 for op, _ in self.calls if op == operation)

    # ── the S3 surface ─────────────────────────────────────────────────

    def create_multipart_upload(self, Bucket=None, Key=None, ContentType=None, **_):
        upload_id = f"fake-{uuid.uuid4().hex}"
        with self._lock:
            self.calls.append(("create_multipart_upload", Key))
            self._uploads[(Key, upload_id)] = {}
        return {"UploadId": upload_id}

    def upload_part(self, Bucket=None, Key=None, UploadId=None, PartNumber=None,
                    Body=None, **_):
        size = len(Body) if isinstance(Body, (bytes, bytearray)) else int(Body or 0)
        with self._lock:
            self.calls.append(("upload_part", Key))
            parts = self._uploads.get((Key, UploadId))
            if parts is None:
                raise _error("NoSuchUpload", "UploadPart")
            etag = f'"{hashlib.md5(f"{Key}:{PartNumber}:{size}".encode()).hexdigest()}"'
            parts[int(PartNumber)] = {
                "ETag": etag,
                "Size": size,
                "LastModified": datetime.now(timezone.utc),
            }
        return {"ETag": etag}

    def list_parts(self, Bucket=None, Key=None, UploadId=None, MaxParts=1000,
                   PartNumberMarker=None, **_):
        with self._lock:
            self.calls.append(("list_parts", Key))
            parts = self._uploads.get((Key, UploadId))
            if parts is None:
                raise _error("NoSuchUpload", "ListParts")
            numbers = sorted(parts)
        after = int(PartNumberMarker or 0)
        page_numbers = [n for n in numbers if n > after][: int(MaxParts)]
        truncated = bool([n for n in numbers if n > after][int(MaxParts):])
        return {
            "Parts": [
                {"PartNumber": n, **{k: v for k, v in parts[n].items()}}
                for n in page_numbers
            ],
            "IsTruncated": truncated,
            "NextPartNumberMarker": page_numbers[-1] if (truncated and page_numbers) else None,
            "MaxParts": int(MaxParts),
        }

    def complete_multipart_upload(self, Bucket=None, Key=None, UploadId=None,
                                  MultipartUpload=None, **_):
        named = list((MultipartUpload or {}).get("Parts") or [])
        with self._lock:
            self.calls.append(("complete_multipart_upload", Key))
            parts = self._uploads.get((Key, UploadId))
            if parts is None:
                raise _error("NoSuchUpload", "CompleteMultipartUpload")
            if not named:
                raise _error("InvalidRequest", "CompleteMultipartUpload",
                             "You must specify at least one part")
            numbers = [int(p["PartNumber"]) for p in named]
            if numbers != sorted(numbers) or len(set(numbers)) != len(numbers):
                raise _error("InvalidPartOrder", "CompleteMultipartUpload")
            total = 0
            for index, p in enumerate(named):
                n = int(p["PartNumber"])
                held = parts.get(n)
                if held is None or held["ETag"].strip('"') != str(p["ETag"]).strip('"'):
                    raise _error("InvalidPart", "CompleteMultipartUpload",
                                 f"part {n} does not match")
                is_last = index == len(named) - 1
                if not is_last and held["Size"] < MIN_PART_BYTES:
                    raise _error("EntityTooSmall", "CompleteMultipartUpload",
                                 f"part {n} is too small")
                total += held["Size"]
            # THE FAITHFUL, DANGEROUS BIT: only the NAMED parts are
            # assembled, and a subset is not an error.
            self.objects[Key] = total
            del self._uploads[(Key, UploadId)]
        return {"ETag": f'"{hashlib.md5(Key.encode()).hexdigest()}"',
                "Key": Key, "Bucket": Bucket}

    def list_multipart_uploads(self, Bucket=None, Prefix="", MaxUploads=1000,
                               KeyMarker=None, UploadIdMarker=None, **_):
        """Every open upload under `Prefix` (§238).

        Added for §238, which has to find the upload id of an abandoned
        upload the way §215's sweeper does — by listing the store, because
        nothing stores it. Paged on BOTH markers together, as the real API
        is: one key can hold several open uploads, so `services/s3_service.py`'s
        paginator sends back `NextKeyMarker` AND `NextUploadIdMarker`, and
        a fake that only honoured the key marker would let a broken
        paginator pass.
        """
        with self._lock:
            self.calls.append(("list_multipart_uploads", Prefix))
            open_uploads = sorted(
                (k, u) for (k, u) in self._uploads
                if k.startswith(Prefix or "")
            )
        after = (KeyMarker, UploadIdMarker)
        if KeyMarker is not None:
            open_uploads = [
                (k, u) for (k, u) in open_uploads
                if (k, u) > (after[0], after[1] or "")
            ]
        page = open_uploads[: int(MaxUploads)]
        truncated = len(open_uploads) > len(page)
        return {
            "Uploads": [
                {"Key": k, "UploadId": u,
                 "Initiated": datetime.now(timezone.utc)}
                for k, u in page
            ],
            "IsTruncated": truncated,
            "NextKeyMarker": page[-1][0] if (truncated and page) else None,
            "NextUploadIdMarker": page[-1][1] if (truncated and page) else None,
        }

    def abort_multipart_upload(self, Bucket=None, Key=None, UploadId=None, **_):
        with self._lock:
            self.calls.append(("abort_multipart_upload", Key))
            if self._uploads.pop((Key, UploadId), None) is None:
                raise _error("NoSuchUpload", "AbortMultipartUpload")
        return {}

    def head_object(self, Bucket=None, Key=None, **_):
        with self._lock:
            self.calls.append(("head_object", Key))
            if Key not in self.objects:
                raise _error("404", "HeadObject", "Not Found")
            return {"ContentLength": self.objects[Key]}

    def put_object(self, Bucket=None, Key=None, Body=b"", **_):
        with self._lock:
            self.calls.append(("put_object", Key))
            self.objects[Key] = len(Body) if isinstance(Body, (bytes, bytearray)) else int(Body or 0)
        return {}

    def delete_object(self, Bucket=None, Key=None, **_):
        with self._lock:
            self.calls.append(("delete_object", Key))
            self.objects.pop(Key, None)
        return {}
