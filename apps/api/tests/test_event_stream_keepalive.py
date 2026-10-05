"""The SSE stream waits instead of spinning (§210).

What this is about
------------------
`event_stream` used to call `asyncio.wait_for(pubsub.get_message(...),
timeout=30.0)`. `get_message()` with no `timeout` of its own is NON-BLOCKING
in redis-py — it returns None immediately when nothing is ready — so the
coroutine `wait_for` was given always completed instantly, the 30-second
ceiling never applied, and the loop yielded a keepalive and went round again
as fast as the event loop could turn.

Measured on the real thing: **42,090 chunks/second** from ONE idle subscriber
(63,046/s when first found, in §209; the exact figure tracks host load, the
order of magnitude does not). About 820 KB/s of 13-byte comment lines per
connected viewer per project, with a CPU core pegged, continuously, in
production.

Why these tests are shaped the way they are
-------------------------------------------
The defect was invisible to every kind of test that does not watch the CLOCK.
The old code's output was perfectly valid SSE: correct keepalive comments,
correct events, nothing malformed. A test that asserted "an idle stream yields
keepalives" passed against the busy-loop. So the assertions here are about
RATE and LATENCY, which is the only thing that distinguishes the two
implementations:

  a. idle: a bound on how many chunks appear in a window;
  b. live: a bound on how long a published event takes to arrive, with the
     keepalive interval set long enough that a keepalive cannot be mistaken
     for the event;
  c. teardown: the subscription is actually released.

Real Redis. There is no mocking here at all, deliberately — a fake pubsub
would be written against whatever this file believes `get_message` does, which
is exactly the belief that was wrong.

A note on the warnings this file emits
-------------------------------------
It finishes green with a handful of `PytestUnraisableExceptionWarning`s
wrapping "RuntimeError: Event loop is closed". They come from redis-py's own
`Connection` finalisers running after pytest-asyncio has closed the per-test
event loop, and they are not about this code: the fixture below already
disconnects the pool it created, and a module-scoped loop produces MORE of
them, not fewer. Left alone deliberately rather than papered over with a
filterwarnings that could hide a real one. If they ever need to go, the fix is
in how `event_service._get_redis` hands out a fresh `Redis` client per call,
not here.

Skipped unless TEST_REDIS_URL points at a reachable Redis:

    docker run -d --name ff-redis -p 63799:6379 redis:7-alpine
    TEST_REDIS_URL=redis://127.0.0.1:63799/0 \\
      pytest apps/api/tests/test_event_stream_keepalive.py
"""

import asyncio
import json
import os
import time
import uuid

import pytest

REDIS_URL = os.environ.get("TEST_REDIS_URL")

pytestmark = [
    pytest.mark.skipif(
        not REDIS_URL or not REDIS_URL.startswith("redis"),
        reason="needs TEST_REDIS_URL pointing at a reachable Redis",
    ),
    pytest.mark.asyncio,
]


@pytest.fixture(autouse=True)
def _point_event_service_at_the_test_redis(monkeypatch):
    """`event_service` builds its connection pool from `settings.redis_url`
    once and caches it in a module global, so the URL has to be in place
    before the first connection and the cache has to be dropped between tests
    — otherwise test two reuses a pool bound to test one's event loop and
    fails with "got Future attached to a different loop".

    Deliberately a SYNC fixture that only drops the reference. An async
    version that also awaited `pool.disconnect()` was tried, to clear the
    ResourceWarnings described above, and made things worse: it reintroduced
    the cross-loop failures it was meant to tidy up. Dropping the reference is
    enough for correctness here; the warnings are redis-py's finalisers and
    are not this file's to fix.
    """
    from apps.api import config
    from apps.api.services import event_service

    monkeypatch.setattr(config.settings, "redis_url", REDIS_URL, raising=False)
    event_service._pool = None
    yield
    event_service._pool = None


async def drain(gen, *, window: float, limit: int = 100_000):
    """Collect chunks for `window` seconds, then stop.

    `limit` is a guard, not an assertion: without it, a regression to the
    busy-loop would make this helper allocate millions of strings before the
    window elapsed.
    """
    chunks = []
    start = time.monotonic()
    while True:
        left = window - (time.monotonic() - start)
        if left <= 0 or len(chunks) >= limit:
            break
        try:
            chunks.append(await asyncio.wait_for(gen.__anext__(), timeout=left))
        except asyncio.TimeoutError:
            break
    return chunks


# ── a — an idle stream is quiet ────────────────────────────────────────────


async def test_an_idle_stream_yields_a_handful_of_keepalives_not_thousands():
    from apps.api.services.event_service import event_stream

    gen = event_stream(f"idle-{uuid.uuid4().hex[:8]}", keepalive_seconds=0.2)
    try:
        chunks = await drain(gen, window=1.5)
    finally:
        await gen.aclose()

    # 1.5s at one per 0.2s is ~7, plus the initial header-flush keepalive.
    # The bound is deliberately loose on the upper side and nowhere near the
    # busy-loop's tens of thousands: this test exists to tell "waits" from
    # "spins", not to pin a scheduler's exact timing.
    assert len(chunks) <= 15, f"expected a handful, got {len(chunks)}"
    # And it is not silent either — a stream that yields nothing would be
    # reaped by a proxy, which is what the keepalive is for.
    assert len(chunks) >= 2, f"expected at least a couple, got {len(chunks)}"
    assert all(c == ": keepalive\n\n" for c in chunks), set(chunks)


async def test_the_rate_is_bounded_by_the_interval_not_by_the_event_loop():
    """The same property stated as a rate, which is what regressed."""
    from apps.api.services.event_service import event_stream

    gen = event_stream(f"idle-{uuid.uuid4().hex[:8]}", keepalive_seconds=0.25)
    start = time.monotonic()
    try:
        chunks = await drain(gen, window=1.0)
    finally:
        await gen.aclose()
    elapsed = time.monotonic() - start

    rate = len(chunks) / elapsed
    # The busy-loop measured 42,090/s. Anything under ~20/s cannot be it.
    assert rate < 20, f"{rate:.0f} chunks/s — the loop is spinning again"


async def test_the_default_interval_is_the_named_constant():
    """Nothing in production passes `keepalive_seconds`, so the default is
    what actually ships."""
    from apps.api.services import event_service

    assert event_service.KEEPALIVE_SECONDS == 30.0

    gen = event_service.event_stream(f"idle-{uuid.uuid4().hex[:8]}")
    try:
        # One second into a 30-second interval: the initial flush, and then
        # nothing. If the default were ignored this would be thousands.
        chunks = await drain(gen, window=1.0)
    finally:
        await gen.aclose()

    assert len(chunks) <= 2, f"got {len(chunks)} chunks in 1s on a 30s interval"


# ── b — a real event still arrives at once ─────────────────────────────────


async def test_a_published_event_arrives_promptly_not_at_the_next_tick():
    """The keepalive timeout is a ceiling on SILENCE, not a polling interval.

    The interval is set to 30s here on purpose: if the fix had turned the
    stream into a poller, this event could not arrive for 30 seconds, and the
    0.5s bound below would fail. It also means the chunk received cannot be a
    keepalive that happened to land at the right moment.
    """
    from apps.api.services.event_service import event_stream, publish

    project = f"live-{uuid.uuid4().hex[:8]}"
    gen = event_stream(project, keepalive_seconds=30.0)
    try:
        # The initial flush, so the subscription is definitely established
        # before anything is published.
        first = await asyncio.wait_for(gen.__anext__(), timeout=5.0)
        assert first == ": keepalive\n\n"

        sent_at = time.monotonic()
        await publish(project, "transcode_progress", {"asset_id": "a1", "percent": 42})
        chunk = await asyncio.wait_for(gen.__anext__(), timeout=0.5)
        latency = time.monotonic() - sent_at
    finally:
        await gen.aclose()

    assert latency < 0.5, f"took {latency:.3f}s"
    assert chunk.startswith("event: transcode_progress\n")
    assert json.loads(chunk.split("data: ", 1)[1].strip()) == {
        "asset_id": "a1",
        "percent": 42,
    }


async def test_several_events_in_a_row_all_arrive():
    """A blocking read that only woke for one message per timeout window
    would pass the test above and still lose events."""
    from apps.api.services.event_service import event_stream, publish

    project = f"burst-{uuid.uuid4().hex[:8]}"
    gen = event_stream(project, keepalive_seconds=30.0)
    try:
        await asyncio.wait_for(gen.__anext__(), timeout=5.0)  # initial flush

        for i in range(5):
            await publish(project, "transcode_progress", {"n": i})

        received = []
        for _ in range(5):
            received.append(await asyncio.wait_for(gen.__anext__(), timeout=1.0))
    finally:
        await gen.aclose()

    numbers = [
        json.loads(c.split("data: ", 1)[1].strip())["n"] for c in received
    ]
    assert numbers == [0, 1, 2, 3, 4]


async def test_a_non_json_payload_still_reaches_the_client():
    """The fallback branch, which the rewrite kept."""
    from apps.api.services.event_service import _get_redis, event_stream

    project = f"raw-{uuid.uuid4().hex[:8]}"
    gen = event_stream(project, keepalive_seconds=30.0)
    try:
        await asyncio.wait_for(gen.__anext__(), timeout=5.0)
        await _get_redis().publish(f"project:{project}", "not json at all")
        chunk = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    finally:
        await gen.aclose()

    assert chunk == "data: not json at all\n\n"


# ── c — teardown releases the subscription ─────────────────────────────────


async def test_closing_the_generator_releases_the_subscription():
    """A browser tab going away must not leave a Redis subscriber behind.

    Asserted against Redis' own view (PUBSUB CHANNELS), not against a flag on
    our side: the thing that would leak is a real server-side subscription.
    """
    from apps.api.services.event_service import _get_redis, event_stream

    project = f"teardown-{uuid.uuid4().hex[:8]}"
    channel = f"project:{project}"
    r = _get_redis()

    gen = event_stream(project, keepalive_seconds=30.0)
    await asyncio.wait_for(gen.__anext__(), timeout=5.0)
    assert channel in await r.pubsub_channels(), "never subscribed"

    # What FastAPI's StreamingResponse does when the client disconnects.
    await gen.aclose()

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if channel not in await r.pubsub_channels():
            break
        await asyncio.sleep(0.05)

    assert channel not in await r.pubsub_channels(), "subscription leaked"


async def test_many_opened_and_closed_streams_leave_nothing_behind():
    """One tab is easy; the leak that matters is cumulative."""
    from apps.api.services.event_service import _get_redis, event_stream

    r = _get_redis()
    before = set(await r.pubsub_channels())

    for _ in range(10):
        project = f"churn-{uuid.uuid4().hex[:8]}"
        gen = event_stream(project, keepalive_seconds=30.0)
        await asyncio.wait_for(gen.__anext__(), timeout=5.0)
        await gen.aclose()

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if set(await r.pubsub_channels()) <= before:
            break
        await asyncio.sleep(0.05)

    leaked = set(await r.pubsub_channels()) - before
    assert not leaked, f"left {len(leaked)} subscription(s) behind: {leaked}"
