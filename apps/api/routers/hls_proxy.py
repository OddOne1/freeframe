"""Media proxy for secure asset delivery.

Every object a client needs to view or download — HLS manifests, HLS
segments, thumbnails, images, audio files, original uploads — is proxied
through this router instead of being handed out as a direct presigned S3
URL. That means the S3/AIStor bucket never needs to be reachable from
outside the Docker/LAN network: only this API container needs a connection
to it. Access is still gated by a short-lived JWT scoped to the object's
S3 prefix (`create_hls_token` / `proxy_url_for`), so the proxy itself
doesn't need to re-check project membership on every request — the token
is only ever handed out to callers who already passed that check.
"""

import logging
import posixpath
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from jose import jwt, JWTError
from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from ..config import settings
from ..services.s3_service import get_s3_client, CONTENT_TYPE_MAP

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["streaming"])

CHUNK_SIZE = 1024 * 1024  # 1 MB, used when streaming object bodies through


def create_hls_token(s3_prefix: str, expires_hours: int = 24) -> str:
    """Create a short-lived JWT scoped to everything under an S3 prefix."""
    payload = {
        "sub": "hls",
        "pfx": s3_prefix,
        "exp": datetime.now(timezone.utc) + timedelta(hours=expires_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _verify_hls_token(token: str) -> str:
    """Verify a proxy token and return its s3_prefix."""
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        if payload.get("sub") != "hls":
            raise HTTPException(status_code=403, detail="Invalid token type")
        return payload["pfx"]
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")


def proxy_url_for(s3_key: str, expires_hours: int = 24, download_filename: str | None = None) -> str:
    """Build a relative, token-authenticated proxy URL for a single S3 object.

    Use this everywhere a direct presigned S3 URL used to be returned to a
    client (thumbnails, images, audio, downloads, share links). The bucket
    itself never has to be reachable by the browser.
    """
    prefix, filename = posixpath.split(s3_key)
    token = create_hls_token(prefix, expires_hours)
    url = f"/stream/hls/{filename}?token={token}"
    if download_filename:
        url += f"&download={quote(download_filename)}"
    return url


def _rewrite_manifest(content: str, s3_prefix: str, manifest_path: str, token: str) -> str:
    """Rewrite URLs in an m3u8 manifest.

    - .m3u8 references -> proxy URLs with the same token (appended as query param)
    - .ts references -> proxy URLs with the same token (previously: presigned S3 URLs)

    Per RFC 8216 §4.1, a relative URI inside a manifest is resolved by the
    client against *that manifest's own URL* — not the top-level master
    playlist's URL. So references here are passed through unchanged (only
    the token is appended); they must NOT be prefixed with the current
    manifest's own directory. Doing that previously caused level playlists
    (served at .../hls/{level}/playlist.m3u8) to emit segment references
    like "{level}/seg_000.ts", which every spec-compliant client (hls.js,
    Safari's native HLS) then resolved to a double-nested, nonexistent
    ".../hls/{level}/{level}/seg_000.ts" — a 404 that surfaced as a fatal
    HLS network error and blocked all playback.
    """
    lines = content.split("\n")
    result = []

    for line in lines:
        stripped = line.strip()

        # Pass through comments/tags and empty lines
        if not stripped or stripped.startswith("#"):
            result.append(line)
            continue

        # Segment/playlist references are already correctly relative to this
        # manifest's own location — just attach the auth token.
        if stripped.endswith(".m3u8") or stripped.endswith(".ts"):
            result.append(f"{stripped}?token={token}")
        else:
            result.append(line)

    return "\n".join(result)


# `bytes=<first>-<last>`, `bytes=<first>-` and `bytes=-<suffix-length>` are
# the three single-range forms RFC 9110 §14.1.1 defines. Anything else
# (notably a multi-range request, `bytes=0-99,200-299`) is deliberately not
# supported: serving one would mean building a multipart/byteranges body,
# and no client this proxy actually serves — browsers resuming a download,
# curl --continue-at, video seeking — ever asks for one.
_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")

RANGE_UNSATISFIABLE = "unsatisfiable"


def _parse_range_header(value: str, total: int):
    """Resolve a Range header against a known object size.

    Returns an inclusive `(start, end)` pair, `RANGE_UNSATISFIABLE` when the
    range falls entirely past the end of the object, or `None` when the
    header should simply be ignored and the whole object served. Per RFC
    9110 §14.2 an unparseable Range header is ignored, not rejected — that
    is what keeps a malformed or multi-range header degrading into a plain
    200 instead of failing the download outright.
    """
    match = _RANGE_RE.match(value.strip())
    if not match:
        return None

    first, last = match.group(1), match.group(2)

    if not first and not last:
        return None

    if total == 0:
        return RANGE_UNSATISFIABLE

    if not first:
        # Suffix range: the last N bytes. N == 0 is meaningless, not a range.
        suffix = int(last)
        if suffix == 0:
            return RANGE_UNSATISFIABLE
        start = max(total - suffix, 0)
        end = total - 1
    else:
        start = int(first)
        end = int(last) if last else total - 1
        if start >= total:
            return RANGE_UNSATISFIABLE
        if end < start:
            return None
        end = min(end, total - 1)

    return start, end


def _sanitize_download_filename(name: str) -> str:
    safe = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return safe.replace("\\", "\\\\").replace('"', '\\"')


@router.get("/hls/{path:path}")
def hls_proxy(
    path: str,
    token: str = Query(...),
    download: str | None = Query(default=None),
    range_header: str | None = Header(default=None, alias="Range"),
):
    """Proxy any object under a token's S3 prefix.

    - `.m3u8` paths are fetched, rewritten (see `_rewrite_manifest`), and
      returned as text.
    - Everything else (HLS segments, thumbnails, images, audio, original
      files) is streamed through as raw bytes with the appropriate
      Content-Type, so the client never needs direct S3/AIStor access.

    Non-manifest objects are range-capable (§176). Every large download in
    this app — zip exports, raw originals, graded LUT exports — comes
    through here, and without `Accept-Ranges`/`Content-Length` a browser
    has no way to resume one: a multi-GB transfer that drops at 80% used
    to restart from byte 0, which made a 13 GB share-link zip effectively
    undownloadable over a connection that blips even once. Manifests stay
    a whole-file fetch — they are tiny text and nothing ever seeks them.
    """
    s3_prefix = _verify_hls_token(token)

    # Prevent directory traversal
    normalised = posixpath.normpath(path)
    if normalised.startswith("..") or normalised.startswith("/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    # Defense-in-depth: verify resolved key stays within the token's prefix
    s3_key = f"{s3_prefix}/{normalised}"
    if not s3_key.startswith(s3_prefix + "/"):
        raise HTTPException(status_code=400, detail="Invalid path")

    s3 = get_s3_client()

    if normalised.endswith(".m3u8"):
        try:
            obj = s3.get_object(Bucket=settings.s3_bucket, Key=s3_key)
            content = obj["Body"].read().decode("utf-8")
        except s3.exceptions.NoSuchKey:
            raise HTTPException(status_code=404, detail="Manifest not found")
        except Exception as e:
            logger.error("Failed to fetch HLS manifest %s: %s", s3_key, e)
            raise HTTPException(status_code=404, detail="Manifest not found")

        rewritten = _rewrite_manifest(content, s3_prefix, normalised, token)

        return Response(
            content=rewritten,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-cache"},
        )

    # Any other object: stream raw bytes through this container.
    ext = posixpath.splitext(normalised)[1].lower()
    content_type, cache_control = CONTENT_TYPE_MAP.get(ext, ("application/octet-stream", "no-cache"))

    byte_range = None
    if range_header:
        # The object's size has to be known before the range can be resolved
        # (an open-ended `bytes=500-` or a suffix `bytes=-500` is meaningless
        # without it), and it is the denominator of every Content-Range this
        # branch emits. One extra HEAD against the LAN bucket, and only on a
        # request that actually carries a Range header.
        try:
            head = s3.head_object(Bucket=settings.s3_bucket, Key=s3_key)
        except Exception as e:
            logger.error("Failed to stat object %s: %s", s3_key, e)
            raise HTTPException(status_code=404, detail="Object not found")

        total = head["ContentLength"]
        byte_range = _parse_range_header(range_header, total)

        if byte_range == RANGE_UNSATISFIABLE:
            raise HTTPException(
                status_code=416,
                detail="Requested range not satisfiable",
                headers={"Content-Range": f"bytes */{total}", "Accept-Ranges": "bytes"},
            )

    get_kwargs = {"Bucket": settings.s3_bucket, "Key": s3_key}
    if byte_range:
        get_kwargs["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"

    try:
        obj = s3.get_object(**get_kwargs)
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=404, detail="Object not found")
    except Exception as e:
        logger.error("Failed to fetch object %s: %s", s3_key, e)
        raise HTTPException(status_code=404, detail="Object not found")

    headers = {"Cache-Control": cache_control, "Accept-Ranges": "bytes"}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{_sanitize_download_filename(download)}"'

    if byte_range:
        start, end = byte_range
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
        headers["Content-Length"] = str(end - start + 1)
        status_code = 206
    else:
        # Previously fetched from S3 and thrown away: without Content-Length
        # the response falls back to chunked transfer encoding, so no client
        # can show real progress or resume, and nothing downstream knows how
        # big the transfer is meant to be. Read defensively — every real S3
        # response carries it, but falling back to chunked beats a 500 if
        # some S3-compatible backend ever omits it.
        if obj.get("ContentLength") is not None:
            headers["Content-Length"] = str(obj["ContentLength"])
        status_code = 200

    def _stream():
        body = obj["Body"]
        while True:
            chunk = body.read(CHUNK_SIZE)
            if not chunk:
                break
            yield chunk

    return StreamingResponse(
        _stream(),
        status_code=status_code,
        media_type=content_type,
        headers=headers,
    )
