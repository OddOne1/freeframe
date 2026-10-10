"""Serve a zip that was never built, by byte range (§217).

ONE route, for the share flow and the authenticated one alike. That is not
tidiness: `zip_export_service`'s own header lists three occasions (§30,
§32, §139) where this codebase ended up with two copies of a permission
rule that disagreed, and a second copy of a RANGE parser would be the same
mistake in a form that corrupts files rather than leaking them. So the
range header is parsed by `hls_proxy._parse_range_header` — the same
function, with the same three RFC 9110 forms and the same "an unparseable
or multi-range header is IGNORED, not rejected" behaviour — and every
permission decision is re-derived by `zip_download.authorise_export_download`
on every request.

── What a request actually costs ────────────────────────────────────────

The archive's layout is a pure function of the frozen manifest
(services/zip_stream.py), so answering `Range: bytes=a-b` is:

  1. one `authorise_export_download` (a handful of indexed SELECTs),
  2. one `HEAD` per OBJECT the range touches, to prove the bytes still are
     what the manifest froze,
  3. one ranged `GET` per object, streamed through at 1 MiB a time.

Step 2 is the honest cost of refusing to splice mismatched bytes, and it is
O(files in the range), not O(files in the archive): a range inside one 105
GB original is a single HEAD. A hundred-file selection is a hundred LAN
HEADs, a few hundred milliseconds before a multi-gigabyte transfer starts.
It is paid once per Range request, and a resumable download makes a handful
of those, not thousands.

Nothing is written to disk, nothing is copied into the bucket, and there is
no time limit: the request is bounded only by one HTTP stream's throughput
through Cloudflare and this process.
"""
import logging
import time
from typing import Iterator, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models.zip_export import ZipExportStatus
from ..services import s3_service, zip_download, zip_export_service as zx
from ..services import zip_stream as zs
from .hls_proxy import (
    CHUNK_SIZE,
    RANGE_UNSATISFIABLE,
    _parse_range_header,
    _sanitize_download_filename,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["streaming"])


class _ObjectChanged(Exception):
    """A stored object is no longer the size the manifest froze.

    Its own exception because the only correct response is to refuse the
    WHOLE request loudly. Splicing bytes from a replaced object into an
    archive whose central directory describes the old one produces a file
    that downloads cleanly and then fails extraction — the single worst
    outcome available here.
    """


def _layout_for(export) -> zs.Layout:
    entries = zx.streamable_entries(export.manifest)
    if not entries:
        # Every entry skipped. A built export in this state produced an
        # empty archive; refusing is better — there is nothing to download
        # and the per-file reasons are already in the status payload.
        raise HTTPException(status_code=409, detail="Nothing in this download is available")
    layout = zs.layout(entries)
    if export.archive_size is not None and int(export.archive_size) != layout.total_size:
        # The row and the manifest disagree, which means one of them was
        # written by code that no longer matches the other. Loud, because
        # the alternative is a Content-Length that does not describe the
        # body — and a client that trusts it.
        logger.error(
            "zip export %s: stored archive_size %s, layout computes %s",
            export.id, export.archive_size, layout.total_size,
        )
        raise HTTPException(status_code=500, detail="This download is inconsistent")
    return layout


def _verify_sizes(layout: zs.Layout, start: int, end: int) -> None:
    """Prove every object the range touches is still its frozen size.

    Before a single byte of the response is produced, so the failure is a
    status code rather than a truncated body.

    ONE client for all of them, not `s3_service.head_object_size` per key:
    that helper builds a fresh boto3 client on every call, and client
    construction is tens of milliseconds — for a hundred-file selection
    that is seconds of pure setup in front of every Range request.
    """
    client = s3_service.get_s3_client()
    seen = set()
    for seg, _lo, _hi in zs.byte_range(layout, start, end):
        if not seg.is_data or seg.s3_key in seen:
            continue
        seen.add(seg.s3_key)
        expected = layout.entries[seg.index].size
        try:
            head = client.head_object(Bucket=settings.s3_bucket, Key=seg.s3_key)
            actual = int(head["ContentLength"])
        except Exception as exc:
            # A store that did not answer is NOT read as "the object is
            # gone" — same instinct as s3_service.object_exists — but it is
            # still a refusal, because serving bytes we could not verify is
            # the one thing this function exists to prevent.
            raise _ObjectChanged(f"{seg.s3_key} could not be read ({exc})") from exc
        if actual != expected:
            raise _ObjectChanged(
                f"{seg.s3_key} is {actual} bytes, the manifest froze {expected}"
            )


def _body_stream(layout: zs.Layout, start: int, end: int) -> Iterator[bytes]:
    """The bytes of `[start, end]`, inclusive, in archive order.

    Synthetic segments are rendered and sliced; data segments become one
    ranged S3 `GET` each, read at 1 MiB like `hls_proxy`.

    The `finally` is load-bearing. When the client disconnects, Starlette
    closes this generator, which raises `GeneratorExit` at the `yield` —
    and without the close below the boto3 body, and the socket under it,
    stay open for the life of the worker process. A download manager that
    opens eight ranges and abandons seven is the normal case, not the
    exception.
    """
    client = s3_service.get_s3_client()
    last_delivery = time.monotonic()

    for seg, lo, hi in zs.byte_range(layout, start, end):
        if not seg.is_data:
            yield zs.render(layout, seg)[lo : hi + 1]
            last_delivery = time.monotonic()
            continue

        entry = layout.entries[seg.index]
        obj = client.get_object(
            Bucket=settings.s3_bucket,
            Key=seg.s3_key,
            Range=f"bytes={lo}-{hi}",
        )
        # Belt and braces against a change between `_verify_sizes` and
        # here. `ContentRange` carries the object's total, so this costs
        # nothing extra — and it is checked BEFORE the first byte of this
        # object is yielded, so a mismatched object is never spliced even
        # though the status code has already been sent.
        total = _content_range_total(obj.get("ContentRange"))
        if total is not None and total != entry.size:
            try:
                obj["Body"].close()
            finally:
                raise _ObjectChanged(
                    f"{seg.s3_key} is {total} bytes, the manifest froze {entry.size}"
                )

        body = obj["Body"]
        try:
            while True:
                read_started = time.monotonic()
                chunk = body.read(CHUNK_SIZE)
                if time.monotonic() - read_started > settings.zip_stream_idle_seconds:
                    raise _ObjectChanged(
                        f"{seg.s3_key}: a {CHUNK_SIZE} byte read took longer than "
                        f"{settings.zip_stream_idle_seconds}s"
                    )
                if not chunk:
                    break
                yield chunk
                now = time.monotonic()
                if now - last_delivery > settings.zip_stream_stall_seconds:
                    # The client took longer than the stall ceiling to
                    # accept the previous chunk. Stop rather than holding
                    # an upstream read open for the rest of the token's
                    # life: a client that is really still there resumes
                    # with a fresh Range, which costs it nothing.
                    logger.warning(
                        "zip stream: abandoning a stalled client after %.0fs", now - last_delivery
                    )
                    return
                last_delivery = now
        finally:
            try:
                body.close()
            except Exception:
                pass


def _content_range_total(value: Optional[str]) -> Optional[int]:
    """The `/N` of a `bytes a-b/N` header, or None if it is not there."""
    if not value or "/" not in value:
        return None
    tail = value.rsplit("/", 1)[1].strip()
    return int(tail) if tail.isdigit() else None


# Two decorators rather than `api_route(methods=["GET", "HEAD"])`: that form
# generates one operation id for both verbs, which FastAPI warns about and
# which makes the OpenAPI document (and anything generated from it) name
# only one of them.
@router.get("/zip/{export_id}/download", operation_id="stream_zip_export")
@router.head("/zip/{export_id}/download", operation_id="head_zip_export")
def stream_zip_export(
    export_id: str,
    request: Request,
    token: str = Query(...),
    download: Optional[str] = Query(default=None),
    share_session: Optional[str] = Query(default=None, alias="share_session"),
    range_header: Optional[str] = Header(default=None, alias="Range"),
    if_range: Optional[str] = Header(default=None, alias="If-Range"),
    db: Session = Depends(get_db),
):
    """Stream one frozen export, honouring `Range`.

    `HEAD` answers with the same status, `Content-Length` and headers and no
    body, which is what a download manager asks for first to decide whether
    it can resume at all.
    """
    zip_download.verify_download_token(token, export_id)
    export = zip_download.load_export(db, export_id)
    # Re-derived here, on every request, including every Range request of a
    # resumed download. A link switched off mid-transfer stops serving at
    # the next range rather than at the next token expiry.
    zip_download.authorise_export_download(db, export, share_session=share_session)

    if not export.is_streamed:
        # A pre-§217 row still has a real archive in `zip-exports/`, and
        # `_zip_status_payload` hands those out through `proxy_url_for`
        # instead. Reaching here means a client built this URL by hand.
        raise HTTPException(status_code=404, detail="Export not found")
    if export.status != ZipExportStatus.ready:
        raise HTTPException(
            status_code=409,
            detail="This download is not ready yet",
        )

    layout = _layout_for(export)
    total = layout.total_size
    etag = f'"{export.etag}"' if export.etag else None

    byte_range = None
    if range_header:
        # §217 — `If-Range` is checked BEFORE the range is honoured, and a
        # stale validator means a full 200, never a 206. A 206 against a
        # manifest that has changed is the one answer that corrupts
        # silently: the client appends new bytes to old ones and the
        # archive's central directory describes neither.
        if if_range and etag and if_range.strip() != etag:
            logger.info(
                "zip export %s: If-Range %s does not match %s; serving the whole archive",
                export.id, if_range.strip(), etag,
            )
        else:
            byte_range = _parse_range_header(range_header, total)
            if byte_range == RANGE_UNSATISFIABLE:
                raise HTTPException(
                    status_code=416,
                    detail="Requested range not satisfiable",
                    headers={
                        "Content-Range": f"bytes */{total}",
                        "Accept-Ranges": "bytes",
                    },
                )

    start, end = byte_range if byte_range else (0, total - 1)

    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
        # No caching: the response depends on the live permission check
        # above, and a proxy that cached it would serve a revoked link.
        "Cache-Control": "no-store",
    }
    if etag:
        headers["ETag"] = etag
    name = download or f"{export.id}.zip"
    headers["Content-Disposition"] = (
        f'attachment; filename="{_sanitize_download_filename(name)}"'
    )
    status_code = 200
    if byte_range:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        status_code = 206

    if request.method == "HEAD":
        # Same headers, no body, and NO upstream reads: a HEAD that HEADed
        # every member would make "can I resume?" cost as much as the
        # download's first chunk.
        return Response(status_code=status_code, headers=headers, media_type="application/zip")

    try:
        _verify_sizes(layout, start, end)
    except _ObjectChanged as exc:
        # 409, not 404 or 500: the request is well-formed and the export
        # exists, but the thing it describes no longer matches storage. The
        # client must start again from zero rather than resume.
        logger.error("zip export %s refused: %s", export.id, exc)
        raise HTTPException(
            status_code=409,
            detail=(
                "A file in this download has changed since it was prepared. "
                "Request the download again."
            ),
        )

    return StreamingResponse(
        _body_stream(layout, start, end),
        status_code=status_code,
        media_type="application/zip",
        headers=headers,
    )
