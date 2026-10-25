"""
Rate-limiting dependencies for FastAPI routes.

Usage:
    @router.post("/endpoint", dependencies=[Depends(rate_limit("action", 5, 60))])
    def my_endpoint(): ...

This limits to 5 requests per 60 seconds per IP for "action".

§233 — `login_rate_limit` below is the second kind, and it exists because
the per-IP kind is the wrong tool for a password login on this deployment.
Read its docstring before adding another caller of either.
"""

import hashlib
from typing import Optional

from fastapi import HTTPException, Request, status

from ..config import settings
from ..services.redis_service import check_rate_limit


def client_ip(request: Request) -> str:
    """The address this request is attributed to.

    X-Real-Ip when a reverse proxy set it, the ASGI peer otherwise. NOT
    X-Forwarded-For, which a client can write itself.

    §233 — how much this is worth depends entirely on the proxy in front of
    the API, which the code cannot see. On this deployment the path is
    Cloudflare Tunnel -> Traefik -> API; if the tunnel's own address ends up
    here, every user shares one bucket, and if the header reaches us
    unoverwritten, a caller picks their own bucket. Both failure modes are
    real and neither is detectable from inside the process, which is why the
    login limit below does not rely on this value alone.
    """
    return request.headers.get("x-real-ip") or (
        request.client.host if request.client else "unknown"
    )


def _too_many(retry_after: int) -> HTTPException:
    """The one throttled response shape, used by both limiters.

    Same status, same wording, same header as the IP limiter has always
    returned — a caller cannot tell from the response WHICH bucket it hit,
    and in particular cannot tell an email bucket (which implies nothing
    about whether that account exists) from an IP one.
    """
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail=f"Too many requests. Please try again in {retry_after} seconds.",
        headers={"Retry-After": str(retry_after)},
    )


def rate_limit(action: str, max_requests: int, window_seconds: int):
    """
    Returns a FastAPI dependency that enforces IP-based rate limiting.

    Args:
        action: Unique key for this rate limit (e.g. "send_magic_code")
        max_requests: Maximum requests allowed in the window
        window_seconds: Time window in seconds
    """

    def _dependency(request: Request):
        allowed, retry_after = check_rate_limit(
            client_ip(request), action, max_requests, window_seconds
        )
        if not allowed:
            raise _too_many(retry_after)

    return _dependency


# ── §233 — metering the password login ──────────────────────────────────────

#: Redis action names. `login_email` holds a SHA-256 of the submitted
#: address, never the address itself: `check_rate_limit` builds
#: `rate_limit:<action>:<value>`, and Redis keys show up in MONITOR output,
#: in slowlog entries and in anything that dumps the keyspace. A per-account
#: limiter whose keys are a list of everyone who tried to sign in would be a
#: worse leak than the one it closes.
#:
#: Distinct from every `action` string used with `rate_limit()` above, so the
#: two namespaces cannot collide.
LOGIN_EMAIL_ACTION = "login_email"
LOGIN_IP_ACTION = "login_ip"


def login_email_bucket(email: str) -> str:
    """The bucket an address falls in: lower-cased, stripped, then hashed.

    Matches `get_user_by_email`'s normalisation (`strip().lower()`) so that
    `Alice@Example.com` and `alice@example.com ` share one budget — two
    spellings of one account must not be two allowances.
    """
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


def _submitted_email(payload: object) -> Optional[str]:
    """The `email` field of a parsed JSON body, if there is a usable one.

    Deliberately forgiving: this runs before FastAPI has validated anything,
    so the body may be malformed, may not be an object, or may have no
    `email` at all. None of that is this function's problem to report — the
    route's own validation answers 422 a moment later. What matters is that
    a body we cannot read never raises here and never silently skips the
    IP brake.
    """
    if not isinstance(payload, dict):
        return None
    email = payload.get("email")
    if not isinstance(email, str) or not email.strip():
        return None
    return email


async def login_rate_limit(request: Request) -> None:
    """Meter POST /auth/login, by TARGET ACCOUNT first and by IP second.

    **Why not the plain per-IP limiter.** `rate_limit()` keys on
    `client_ip()`, and on this deployment that value is whatever Cloudflare
    Tunnel and Traefik leave in X-Real-Ip. Neither possibility is safe for a
    login: if every request arrives with the tunnel's address, one user's
    failed attempts lock out the whole instance; if the header survives from
    the client, an attacker rotates it and is never limited at all. The code
    cannot tell which it is, so it does not bet on either.

    **The account bucket.** The normalised, lower-cased email from the
    request body, hashed. A caller cannot change which bucket they land in
    without changing which account they are attacking, which is the whole
    point: it is unspoofable, and one account being hammered cannot cost any
    other account its allowance. Every attempt counts, successes included —
    a legitimate person does not sign in ten times in ten minutes, and
    counting only failures would let a working password keep the budget
    topped up.

    **The IP bucket** is a coarse second brake, deliberately generous
    (60/600s by default) so that a shared NAT or the tunnel's own address
    does not lock out real users. It is worth exactly as much as the header
    behind it — see `client_ip` — which is why it is the loose one.

    **It cannot reveal whether an account exists.** The bucket is derived
    from the SUBMITTED STRING, before any database lookup, so an unknown
    address is metered identically to a known one and a throttled response
    is byte-identical either way (see `_too_many`). Nothing here branches on
    whether a user was found, and nothing here touches the database, so the
    timing does not either.

    **It does nothing to a request that is under budget.** A non-throttled
    login goes through unchanged — the §191 2FA outcomes, the pending token,
    the response shape are all exactly as before.

    Both bucket sizes are settings, so an operator who finds either wrong
    for their traffic can move it without a code change. Read at call time,
    not at import, so tests (and a restart-free config reload, if one ever
    lands) see the current value.
    """
    try:
        payload = await request.json()
    except Exception:
        # Not JSON, or no body. The route answers 422 in a moment; the IP
        # brake below still applies, so a flood of junk bodies is not a way
        # around the limiter.
        payload = None

    email = _submitted_email(payload)
    if email is not None:
        allowed, retry_after = check_rate_limit(
            login_email_bucket(email),
            LOGIN_EMAIL_ACTION,
            settings.login_rate_limit_per_email,
            settings.login_rate_limit_email_window_seconds,
        )
        if not allowed:
            raise _too_many(retry_after)

    allowed, retry_after = check_rate_limit(
        client_ip(request),
        LOGIN_IP_ACTION,
        settings.login_rate_limit_per_ip,
        settings.login_rate_limit_ip_window_seconds,
    )
    if not allowed:
        raise _too_many(retry_after)
