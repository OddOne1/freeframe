"""Error responses must never be cacheable (§128).

A `/api/api/...` typo produced a 404 that the browser then replayed from
disk cache for four hours:

    GET /api/api/stream/hls/thumbnail.jpg  ->  404
    Cache-Control: max-age=14400
    Content-Type: application/json, Content-Length: 22   ({"detail":"Not Found"})

Nothing in this application asked for that. FastAPI's unmatched-route 404
sets no Cache-Control at all, and 14400 seconds is four hours -- which is
Cloudflare's DEFAULT Browser Cache TTL, applied to exactly those responses
that arrive from the origin without a caching policy of their own. This
deployment sits behind a Cloudflare Tunnel.

The consequence is worse than a stray header: once a client has hit a
broken URL, fixing the bug server-side changes nothing for that client for
up to four hours, because the browser stops asking. A cached error is a
cached lie about the current state of the server.

So every 4xx and 5xx leaves here with an explicit `no-store`. An origin
policy overrides the edge default, so this settles it for Cloudflare and for
the browser at once. Success responses are untouched -- the .ts segments and
posters that are deliberately cached for a year still are.
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request


class NoCacheErrorsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if response.status_code >= 400:
            # Set, not defaulted: an error path that had inherited a
            # cacheable policy from its success path would keep it otherwise.
            response.headers["Cache-Control"] = "no-store"
            # Belt and braces for intermediaries that predate no-store.
            response.headers["Pragma"] = "no-cache"
        return response
