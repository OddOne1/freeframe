from fastapi import APIRouter, Depends, Query, HTTPException, Request, status
from fastapi.responses import StreamingResponse
import uuid
from typing import Optional
from pydantic import BaseModel
from sqlalchemy.orm import Session
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User, UserStatus
from ..services.event_service import event_stream
from ..services.permissions import get_project_member, is_public_project
from ..services.redis_service import (
    consume_event_ticket,
    generate_event_ticket,
    store_event_ticket,
)

router = APIRouter(prefix="/events", tags=["events"])


class EventTicketResponse(BaseModel):
    """§211 — a single-use key to one project's stream, for 60 seconds.

    `ticket` is opaque: 32 random bytes, carrying no user id, no project id
    and no readable expiry. Everything it means lives in Redis under it.
    """

    ticket: str
    #: Echoed so a client can assert it got a ticket for the stream it is
    #: about to open, rather than silently connecting to the wrong one.
    project_id: uuid.UUID
    expires_in: int


def _require_project_read_access(
    db: Session, project_id: uuid.UUID, user: User
) -> None:
    """The same rule the stream itself applied before §211: a member, or a
    public project. Lifted into one function so issuance and connection
    cannot drift on who may read what."""
    if not get_project_member(db, project_id, user.id) and not is_public_project(
        db, project_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member"
        )


@router.post("/ticket", response_model=EventTicketResponse)
def create_event_ticket(
    project_id: uuid.UUID = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Mint a ticket for this project's event stream (§211).

    This is the authenticated door the stream no longer has one of. Because it
    goes through `get_current_user` like every other endpoint, it gets the
    checks the stream was missing for free and cannot forget them:

      * the `tv` claim is compared against `users.token_version`, so a session
        ended by §207 (the `require_2fa` flip, a password change, an admin 2FA
        reset) cannot mint a ticket — which is what makes session invalidation
        finally reach the stream;
      * a deactivated account is refused, because `get_current_user` re-reads
        `status`;
      * §200's account gate applies, since it is middleware over everything
        outside `/auth/*`.

    Why `POST` for something that reads nothing: a ticket is minted, not
    fetched. It changes server state (a new key in Redis), it must never be
    cached by a browser or a proxy, and it must not be prefetchable from a
    link. A GET would be all three of those things.

    The ticket is returned in the BODY, never in a redirect or a URL, so the
    only place it is written down is the stream request the client makes next.
    """
    _require_project_read_access(db, project_id, current_user)

    ticket = generate_event_ticket()
    store_event_ticket(ticket, str(current_user.id), str(project_id))
    # Deliberately not logged, here or anywhere: a ticket in a log file is the
    # thing §211 exists to stop (§209 found the access token in exactly that
    # position). The only acceptable trace is that a ticket was issued, which
    # the access log already records as a POST to this path.
    from ..services.redis_service import EVENT_TICKET_TTL_SECONDS

    return EventTicketResponse(
        ticket=ticket,
        project_id=project_id,
        expires_in=EVENT_TICKET_TTL_SECONDS,
    )


@router.get("/{project_id}")
async def stream_events(
    project_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
    ticket: Optional[str] = Query(None),
):
    """Subscribe to a project's live events.

    §211 — authenticated by a ticket from POST /events/ticket, and by nothing
    else. The `?token=<access token>` parameter this endpoint used to accept
    is GONE, not deprecated:

      * it put a full-API-scope bearer token into Cloudflare's logs, Traefik's
        logs and the browser's history, where it stayed valid for its whole
        lifetime;
      * and the branch that read it decoded the JWT by hand, so it never
        compared `tv` against `users.token_version`. A user signed out
        everywhere by §207 kept a working event stream until that token
        expired.

    Removed outright rather than kept behind a flag because §211's step 0
    checked every client: the web app is the only one (`hooks/use-sse.ts`, via
    `useSSE` in the asset page and the upload bridge), the desktop app does not
    use this endpoint at all, and share-link guests never reach it — they get
    `/share/{token}/stream/{asset_id}`, which is a media URL, not SSE. The
    desktop app's embedded webview loads the deployed web app over HTTP
    (`webview.js`), so it picks up the new client with the server and cannot
    be left behind on an old one. There is nothing to be backwards-compatible
    with, and a legacy path nobody needs is just the hole still being open.

    The ticket is consumed atomically, so a second connection cannot replay
    it, and the user is re-read and re-checked here as well as at issuance:
    60 seconds is short, but it is long enough for an account to be
    deactivated in.
    """
    binding = consume_event_ticket(ticket) if ticket else None
    if not binding:
        # Unknown, expired, already used, or absent — all the same answer, so
        # that probing cannot tell a never-existed ticket from a spent one.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired stream ticket",
        )

    if binding["project_id"] != str(project_id):
        # A ticket is minted against one project, because the permission
        # check happens at issuance. Honouring it for another project would
        # make one legitimate ticket a key to every project.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired stream ticket",
        )

    try:
        user = (
            db.query(User)
            .filter(User.id == uuid.UUID(binding["user_id"]))
            .first()
        )
    except (ValueError, TypeError):
        user = None
    if not user or user.deleted_at is not None or user.status == UserStatus.deactivated:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired stream ticket",
        )

    # Re-checked on connect, not just at issuance: project membership can be
    # revoked inside the ticket's 60-second window.
    _require_project_read_access(db, project_id, user)

    return StreamingResponse(
        event_stream(str(project_id)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
