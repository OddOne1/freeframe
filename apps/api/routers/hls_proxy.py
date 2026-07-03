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
from fastapi import APIRouter, HTTPException, Query
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


def _sanitize_download_filename(name: str) -> str:
    safe = re.sub(r"[\x00-\x1f\x7f]", "", name)
    return safe.replace("\\", "\\\\").replace('"', '\\"')


@router.get("/hls/{path:path}")
def hls_proxy(path: str, token: str = Query(...), download: str | None = Query(default=None)):
    """Proxy any object under a token's S3 prefix.

    - `.m3u8` paths are fetched, rewritten (see `_rewrite_manifest`), and
      returned as text.
    - Everything else (HLS segments, thumbnails, images, audio, original
      files) is streamed through as raw bytes with the appropriate
      Content-Type, so the client never needs direct S3/AIStor access.
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

    try:
        obj = s3.get_object(Bucket=settings.s3_bucket, Key=s3_key)
    except s3.exceptions.NoSuchKey:
        raise HTTPException(status_code=404, detail="Object not found")
    except Exception as e:
        logger.error("Failed to fetch object %s: %s", s3_key, e)
        raise HTTPException(status_code=404, detail="Object not found")

    headers = {"Cache-Control": cache_control}
    if download:
        headers["Content-Disposition"] = f'attachment; filename="{_sanitize_download_filename(download)}"'

    def _stream():
        body = obj["Body"]
        while True:
            chunk = body.read(CHUNK_SIZE)
            if not chunk:
                break
            yield chunk

    return StreamingResponse(_stream(), media_type=content_type, headers=headers)
