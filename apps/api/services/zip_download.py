"""Who may stream a frozen zip export, re-decided on every request (§217).

A browser's own download cannot send an `Authorization` header, so the
download URL has to carry its own credential — the same constraint
`proxy_url_for` already works around for originals and thumbnails. The
difference here is what that credential MEANS.

`create_hls_token` mints a token scoped to an S3 PREFIX: whoever holds it
can fetch every object under that asset-version folder for the token's
whole life, and the proxy deliberately performs no further check ("the
token is only ever handed out to callers who already passed that check").
That is acceptable for one asset's objects. It is not acceptable for a
batch download whose link now lives for days, and it would make the §143
permission rules unenforceable: a link whose downloads were switched off
mid-transfer would keep serving.

So a zip-download token carries almost nothing: a type, an expiry, and the
export id. **Every permission decision is re-derived from the export row on
every request** — which is also what makes "re-check on every Range
request, not once" true by construction rather than by remembering to:

  * The row names a share link  -> `validate_share_link_with_session` runs
    again (deleted, disabled, expired, password session), and the link must
    still allow at least one download variant.
  * The row names no share link -> it is the in-app flow, and
    `created_by` is re-read as a live user who must still be able to reach
    the project (member, or the project is public) and must still be an
    active account.

The token is therefore a bearer credential for ONE export, and revoking
access anywhere upstream kills it immediately regardless of how long it was
minted for.
"""
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote

from fastapi import HTTPException
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from ..config import settings

logger = logging.getLogger(__name__)

#: `sub` claim. Its own value, not "hls": a token minted for one purpose
#: must not be redeemable for another, which is the same reasoning
#: redis_service applies five times over to its code pools.
TOKEN_SUBJECT = "zipdl"

#: Where the stream lives. One route, serving both the share flow and the
#: authenticated one — the repo's own history (§30, §32, §139, and the
#: comment at the top of zip_export_service) is a list of permission rules
#: that drifted apart because they were written twice.
DOWNLOAD_PATH = "/stream/zip"


def create_download_token(export_id, *, expires_hours: Optional[int] = None) -> str:
    """A token good for exactly one export, for `download_link_hours`."""
    hours = settings.download_link_hours if expires_hours is None else expires_hours
    return jwt.encode(
        {
            "sub": TOKEN_SUBJECT,
            "exp_id": str(export_id),
            "exp": datetime.now(timezone.utc) + timedelta(hours=hours),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def verify_download_token(token: str, export_id) -> None:
    """Raise unless `token` was minted for `export_id` and is still valid.

    The export id is checked against the PATH rather than trusted from the
    token, so a token for export A cannot be replayed against export B.
    401 for an expired or malformed token specifically, because that is the
    status the clients branch on to fetch a fresh URL (§217 item 5) — a 403
    would be read as "not allowed" and stop the download instead of
    renewing it.
    """
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    if payload.get("sub") != TOKEN_SUBJECT:
        raise HTTPException(status_code=403, detail="Invalid token type")
    if str(payload.get("exp_id") or "") != str(export_id):
        raise HTTPException(status_code=403, detail="Token does not match this download")


def download_url_for(
    export,
    *,
    filename: str,
    share_session: Optional[str] = None,
    expires_hours: Optional[int] = None,
) -> str:
    """The relative URL handed to a client for a STREAMED export.

    `download=` is carried in the query exactly as `proxy_url_for` does it,
    so the filename is resolved at serve time: re-titling a share link
    renames its download with no rebuild, which is a property `cache_key`
    already documents and which a name baked into a token would lose.

    `share_session` is appended only when the caller has one. A
    password-protected link therefore produces a URL that keeps working
    only while that session does — and a URL built without one is refused
    by such a link rather than quietly bypassing the password.
    """
    token = create_download_token(export.id, expires_hours=expires_hours)
    url = f"{DOWNLOAD_PATH}/{export.id}/download?token={token}"
    if filename:
        url += f"&download={quote(filename)}"
    if share_session:
        url += f"&share_session={quote(share_session)}"
    return url


def authorise_export_download(
    db: Session,
    export,
    *,
    share_session: Optional[str] = None,
) -> None:
    """Re-run the real permission check for this export. Raises on refusal.

    Called on EVERY request, including every `Range` request of a resumed
    download, and deliberately delegating to the same helpers the status
    endpoints use rather than re-implementing their rules.
    """
    # Imported here rather than at module scope: services/permissions
    # imports the model layer, and this module is imported from
    # routers/share, which that import chain already reaches.
    from .permissions import (
        get_project_member,
        is_public_project,
        validate_share_link_with_session,
    )

    if export.share_link_id:
        from ..models.share import ShareLink

        link = (
            db.query(ShareLink)
            .filter(ShareLink.id == export.share_link_id)
            .first()
        )
        if not link:
            raise HTTPException(status_code=404, detail="Export not found")
        # By TOKEN, not by id, because that is the function the rest of the
        # share surface uses and it is where the deleted/disabled/expired
        # and password-session rules live. Re-reading them here would be a
        # second copy of a permission rule.
        link = validate_share_link_with_session(
            db, link.token, share_session=share_session, current_user=None
        )
        if not (link.allowed_download_variants or []):
            raise HTTPException(
                status_code=403, detail="Downloads are not allowed for this share link"
            )
        return

    # The in-app flow. `created_by` is the authorisation subject: the
    # status endpoint already refuses an export belonging to another
    # member, so the question on every later request is whether THAT user
    # can still reach the project.
    if not export.created_by:
        raise HTTPException(status_code=404, detail="Export not found")

    from ..models.user import User, UserStatus

    user = (
        db.query(User)
        .filter(User.id == export.created_by, User.deleted_at.is_(None))
        .first()
    )
    if not user or user.status != UserStatus.active:
        raise HTTPException(status_code=403, detail="Access denied")
    if not get_project_member(db, export.project_id, user.id) and not is_public_project(
        db, export.project_id
    ):
        raise HTTPException(status_code=403, detail="Not a project member")


def load_export(db: Session, export_id) -> object:
    """The export row, or a 404 that says nothing about why."""
    from ..models.zip_export import ZipExport

    try:
        ident = uuid.UUID(str(export_id))
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail="Export not found")
    export = db.query(ZipExport).filter(ZipExport.id == ident).first()
    if not export:
        raise HTTPException(status_code=404, detail="Export not found")
    return export
