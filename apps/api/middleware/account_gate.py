"""The account-setup gate, enforced server-side for every route (§200).

Every account must end up with a password and a verified password-reset
address. While either is outstanding, this refuses every request except the
handful that exist to SATISFY the requirement, with:

    403 {"detail": "account_setup_required"}

**Why a middleware and not a dependency.** A dependency has to be added to
each router, and the value of this gate is that it holds for routes nobody
remembered — the next router someone adds is covered by construction rather
than by review. The same argument SetupGuardMiddleware already makes for the
fresh-install case, one layer down.

**Why the browser is not asked.** `/auth/me` reports `must_set_password` and
`backup_email_state` so the web app can render the gate instead of the
dashboard, but that is presentation. The block itself is computed here, from
the same columns, on every request — so a client that ignores those fields,
or is written against an older API, or is simply `curl`, gets exactly the same
answer. A gate a client can decline is a suggestion.

**Cost, stated rather than discovered later.** This opens its own session and
does one primary-key lookup per authenticated, non-exempt request — the same
row `get_current_user` reads a moment later. It cannot be shared: this runs
before any route, so there is no request state to read from and nothing to
write into. The alternative is a dependency on every router, which is the
thing a middleware exists to avoid and which fails open for whatever router
somebody forgets. One indexed lookup is the price of a gate that holds by
construction. SetupGuardMiddleware caches its answer after the first success;
this one cannot, because the answer is per-user and changes the moment the
user acts on it.

**Fail closed, with one deliberate exception.** If the database cannot be
reached this middleware lets the request through, matching
SetupGuardMiddleware's own choice directly above it in the stack: the route
behind it will fail on its own DB access and say something truthful, whereas a
403 here would blame the user's account setup for an outage. What this does
NOT do is let a request through because the token was odd — an unreadable or
stale token falls through to the route's own `get_current_user`, which is the
one place that decides what a token is worth.
"""

import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

#: The exact string clients branch on. A stable token rather than a sentence:
#: `apps/web` reads it to decide whether an error is "you are gated" or "that
#: genuinely failed", and prose would make that comparison a translation bug
#: waiting to happen.
ACCOUNT_SETUP_REQUIRED = "account_setup_required"

#: Paths that stay reachable while the gate is up.
#:
#: `/auth` covers the whole router on purpose, including the gate's own
#: endpoints (/auth/backup-email, /auth/set-password) and /auth/me — which is
#: what the client reads to find out it is gated, so putting it behind the
#: gate would leave a browser with a 403 and no way to learn why.
#:
#: The rest mirror SetupGuardMiddleware's list for the same reasons: /share/
#: is anonymous and belongs to people who have no account here at all and must
#: not be collateral damage; /site-settings backs the login screen's branding;
#: /setup is the fresh-install flow; /health is what tells the operator the
#: container is alive.
EXEMPT_PREFIXES = (
    "/auth",
    "/setup",
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/share/",
    "/site-settings",
)


class AccountGateMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        if any(path.startswith(prefix) for prefix in EXEMPT_PREFIXES):
            return await call_next(request)

        # CORS preflight carries no Authorization header by definition, so
        # gating it would break every cross-origin request from the web app
        # before the real request was ever made.
        if request.method == "OPTIONS":
            return await call_next(request)

        auth = request.headers.get("authorization") or ""
        scheme, _, token = auth.partition(" ")
        if scheme.lower() != "bearer" or not token:
            # No session to judge. The route's own dependency decides whether
            # that is a 401 or perfectly fine — this middleware has no opinion
            # about anonymous traffic.
            return await call_next(request)

        try:
            from ..database import SessionLocal
            from ..models.user import gate_outstanding
            from ..services.auth_service import (
                decode_token, get_user_by_id, token_version_of,
            )

            payload = decode_token(token)
            if not payload or payload.get("type") != "access":
                return await call_next(request)

            db = SessionLocal()
            try:
                user = get_user_by_id(db, uuid.UUID(payload["sub"]))
                if not user:
                    return await call_next(request)
                # A token this user's own row has already invalidated (§199)
                # is not a session, so it is not one to gate. Left to
                # get_current_user, which answers 401 — the honest status.
                if token_version_of(payload) != (user.token_version or 0):
                    return await call_next(request)
                blocked = gate_outstanding(user)
            finally:
                db.close()
        except Exception:
            # See the module docstring: an unreachable database must not be
            # reported to the user as a problem with their account.
            return await call_next(request)

        if blocked:
            return JSONResponse(
                status_code=403, content={"detail": ACCOUNT_SETUP_REQUIRED}
            )

        return await call_next(request)
