"""Redis-backed SSE event bus for cross-process real-time events."""
import json
from typing import AsyncGenerator, Optional
import redis.asyncio as aioredis
from ..config import settings

_pool = None

#: How long to wait for a real event before sending a comment line to keep the
#: connection alive (§210).
#:
#: This is a BLOCKING wait inside Redis' own pubsub reader, which is the whole
#: point — see event_stream. 30s is comfortably under the 60s that proxies and
#: load balancers typically use to reap an idle connection, and sending one
#: 13-byte comment every 30s costs nothing.
KEEPALIVE_SECONDS = 30.0


def _get_redis():
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(settings.redis_url, decode_responses=True)
    return aioredis.Redis(connection_pool=_pool)


async def publish(project_id: str, event_type: str, payload: dict) -> None:
    """Publish an event to a Redis channel for the project."""
    r = _get_redis()
    message = json.dumps({"type": event_type, "payload": payload})
    await r.publish(f"project:{project_id}", message)


async def event_stream(
    project_id: str,
    keepalive_seconds: Optional[float] = None,
) -> AsyncGenerator[str, None]:
    """Subscribe to a Redis channel and yield SSE messages.

    §210 — the wait below is the entire subject of this function.

    What was here before: `asyncio.wait_for(pubsub.get_message(...),
    timeout=30.0)`. That reads as "wait up to 30 seconds for an event, then
    send a keepalive", and it is not what it does. `get_message()` without a
    `timeout` of its own is NON-BLOCKING in redis-py: it returns None
    immediately when no message is ready. So the coroutine handed to
    `wait_for` completed instantly, the 30-second ceiling never applied to
    anything, and the loop fell straight through to `yield ": keepalive"` and
    went round again, as fast as the event loop could turn.

    Measured on the real thing before the fix: **63,046 chunks in 1.00
    second** from one idle subscriber — about 820 KB/s of keepalive comments
    per connected viewer per project, plus a pegged CPU core, continuously,
    in production. It also meant a connection was never actually idle, which
    is the likeliest reason the stream was seen dying and reconnecting every
    ~10 seconds: something between the browser and uvicorn was cutting a
    connection that would not stop talking.

    The fix is to let Redis do the waiting. `get_message(timeout=...)` blocks
    in the pubsub reader until either a message arrives or the timeout
    elapses, returning None in the second case. A real event therefore still
    arrives the moment it is published — the timeout is a ceiling on
    *silence*, not a polling interval — and an idle stream emits exactly one
    comment line per `keepalive_seconds`.

    `keepalive_seconds` is injectable so a test can assert the shape of this
    in a second or two instead of a minute; production passes nothing and
    gets KEEPALIVE_SECONDS.
    """
    interval = KEEPALIVE_SECONDS if keepalive_seconds is None else keepalive_seconds
    r = _get_redis()
    pubsub = r.pubsub()
    await pubsub.subscribe(f"project:{project_id}")
    try:
        while True:
            # Blocks here. Returns None both on timeout and for a message
            # being ignored (the subscribe confirmation), and both mean
            # "nothing to forward" — so both produce a keepalive.
            #
            # In practice that makes the FIRST chunk a keepalive, emitted as
            # soon as the subscription is confirmed rather than 30s later.
            # Kept deliberately: it flushes the response headers, so the
            # browser fires EventSource.onopen straight away instead of
            # sitting in CONNECTING until the first real event. After that
            # the only source of a None is the timeout.
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=interval
            )
            if message and message["type"] == "message":
                try:
                    parsed = json.loads(message["data"])
                    event_type = parsed.get("type", "message")
                    payload = json.dumps(parsed.get("payload", parsed))
                    yield f"event: {event_type}\ndata: {payload}\n\n"
                except (json.JSONDecodeError, TypeError):
                    yield f"data: {message['data']}\n\n"
            else:
                yield ": keepalive\n\n"
    finally:
        # Reached on a clean return, on GeneratorExit when the client goes
        # away, and on cancellation — so the subscription is released in all
        # three cases rather than left holding a Redis connection per
        # abandoned browser tab.
        await pubsub.unsubscribe(f"project:{project_id}")
        await pubsub.aclose()
