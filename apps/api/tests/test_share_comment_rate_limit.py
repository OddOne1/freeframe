"""§234 C — POST /share/{token}/comment is metered, and metered per LINK.

It is the only unauthenticated WRITE this API has. Until now the only thing
standing in front of it was the global 300-writes-a-minute middleware, so a
single commenting link could be filled with a comment per request for as
long as anyone cared to keep going.

The argument for keying on the SHARE TOKEN rather than on the IP is §233's,
and nothing about it has changed: `client_ip()` reads X-Real-Ip, which on
this deployment is written somewhere along Cloudflare Tunnel -> Traefik ->
API, and the process cannot tell whether that value is the tunnel's own
address (one flood locks out everybody) or the caller's choice (no limit at
all). The token is neither — a caller can only change which bucket they land
in by holding a different link.

So: the token bucket is the real budget, the IP bucket is a deliberately
generous second brake, and both are settings.

**Redis.** `check_rate_limit` is the repo's own counter, so the Redis under
it is the same clock-owning dict `test_login_rate_limit.py` uses — a
sleep-based window test would be a slow flake, and the repo ships no
fakeredis.
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.middleware.rate_limit import (
    SHARE_COMMENT_IP_ACTION,
    SHARE_COMMENT_TOKEN_ACTION,
    share_token_bucket,
)


# ── a Redis whose clock this file owns (same shape as §233's) ───────────────

class _Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def advance(self, seconds):
        self.now += seconds


class _FakePipeline:
    def __init__(self, redis):
        self._redis = redis
        self._ops = []

    def incr(self, key):
        self._ops.append(("incr", key, None))

    def expire(self, key, seconds, nx=False):
        self._ops.append(("expire", key, (seconds, nx)))

    def execute(self):
        for op, key, arg in self._ops:
            if op == "incr":
                self._redis._incr(key)
            else:
                self._redis._expire(key, arg[0], nx=arg[1])
        self._ops = []


class _FakeRedis:
    def __init__(self, clock):
        self.clock = clock
        self.values = {}
        self.expires_at = {}

    def _alive(self, key):
        deadline = self.expires_at.get(key)
        if deadline is not None and deadline <= self.clock.now:
            self.values.pop(key, None)
            self.expires_at.pop(key, None)
            return False
        return key in self.values

    def _incr(self, key):
        self._alive(key)
        self.values[key] = self.values.get(key, 0) + 1

    def _expire(self, key, seconds, nx=False):
        if nx and key in self.expires_at:
            return
        self.expires_at[key] = self.clock.now + seconds

    def get(self, key):
        return str(self.values[key]) if self._alive(key) else None

    def ttl(self, key):
        if not self._alive(key) or key not in self.expires_at:
            return -1
        return int(self.expires_at[key] - self.clock.now)

    def pipeline(self):
        return _FakePipeline(self)


@pytest.fixture
def clock():
    return _Clock()


@pytest.fixture
def fake_redis(clock):
    redis = _FakeRedis(clock)
    with patch("apps.api.services.redis_service.get_redis", return_value=redis):
        yield redis


@pytest.fixture(autouse=True)
def _only_this_limiter_is_in_play():
    """Silence the two middlewares that would otherwise answer first — the
    setup guard (503 until a superadmin exists, read past the mocked
    session) and the global write limiter, which would collect its own 429s
    from the hundreds of POSTs this file sends. Same reasoning, and the same
    two patches, as test_login_rate_limit.py."""
    from apps.api.middleware import setup_guard

    previous = setup_guard._setup_complete
    setup_guard._setup_complete = True
    with patch(
        "apps.api.middleware.global_rate_limit.get_redis",
        side_effect=RuntimeError("global limiter disabled for this test"),
    ):
        try:
            yield
        finally:
            setup_guard._setup_complete = previous


TOKEN = "a" * 32
OTHER_TOKEN = "b" * 32
BUDGET = 30  # settings.share_comment_rate_limit_per_token


@pytest.fixture
def unknown_link():
    """Every token is invalid: the route answers 404 until the limiter bites.

    Deliberately the invalid case for most of this file — a limiter that
    only ran after validation would be a way to find out which tokens exist.
    """
    from fastapi import HTTPException

    with patch(
        "apps.api.routers.comments.validate_share_link_with_session",
        side_effect=HTTPException(status_code=404, detail="Share link not found"),
    ):
        yield


def _post(client, token=TOKEN, ip="203.0.113.9"):
    return client.post(
        f"/share/{token}/comment",
        json={"body": "hello", "guest_name": "Pat", "guest_email": "pat@example.test"},
        headers={"x-real-ip": ip},
    )


class TestTheTokenBucket:
    def test_the_thirty_first_comment_on_one_link_is_429(
        self, client, mock_db, fake_redis, unknown_link
    ):
        for _ in range(BUDGET):
            assert _post(client).status_code == 404
        throttled = _post(client)
        assert throttled.status_code == 429
        assert "Retry-After" in throttled.headers

    def test_another_link_from_the_same_address_still_works(
        self, client, mock_db, fake_redis, unknown_link
    ):
        """One link being flooded must not cost every other link its
        allowance — which is exactly what a purely IP-keyed limiter would do
        behind a shared tunnel address."""
        for _ in range(BUDGET + 1):
            _post(client, token=TOKEN)
        assert _post(client, token=TOKEN).status_code == 429
        assert _post(client, token=OTHER_TOKEN).status_code == 404

    def test_the_token_is_not_a_redis_key(self, fake_redis, client, mock_db, unknown_link):
        """The share token IS the credential. Redis keys turn up in MONITOR
        output, in slowlog entries and in anything that dumps the keyspace,
        so the bucket holds a hash of it — the same rule §233 applied to the
        login's e-mail."""
        _post(client)
        keys = list(fake_redis.values)
        assert keys
        assert not any(TOKEN in key for key in keys), keys
        assert any(share_token_bucket(TOKEN) in key for key in keys), keys

    def test_it_reopens_when_the_window_passes(
        self, client, mock_db, fake_redis, clock, unknown_link
    ):
        for _ in range(BUDGET + 1):
            _post(client)
        assert _post(client).status_code == 429
        clock.advance(601)
        assert _post(client).status_code == 404

    def test_it_is_still_shut_just_before_the_window_passes(
        self, client, mock_db, fake_redis, clock, unknown_link
    ):
        for _ in range(BUDGET + 1):
            _post(client)
        clock.advance(599)
        assert _post(client).status_code == 429


class TestItSaysNothingAboutTheLink:
    def test_a_valid_and_an_invalid_link_throttle_identically(
        self, client, mock_db, fake_redis
    ):
        """The one property that makes the limiter safe to put in front of
        validation: the throttled answer cannot be read as "this token
        exists"."""
        from fastapi import HTTPException

        def _throttle_on(token):
            with patch(
                "apps.api.routers.comments.validate_share_link_with_session",
                side_effect=HTTPException(404, "Share link not found"),
            ):
                for _ in range(BUDGET + 1):
                    _post(client, token=token)
                return _post(client, token=token)

        invalid = _throttle_on("c" * 32)

        # A VALID link, which the route then refuses for another reason.
        link = MagicMock()
        link.permission = "view"
        with patch(
            "apps.api.routers.comments.validate_share_link_with_session",
            return_value=link,
        ):
            valid_token = "d" * 32
            for _ in range(BUDGET + 1):
                _post(client, token=valid_token)
            valid = _post(client, token=valid_token)

        assert invalid.status_code == valid.status_code == 429
        assert invalid.json() == valid.json()
        assert invalid.headers.get("Retry-After") == valid.headers.get("Retry-After")

    def test_it_runs_before_validation_at_all(self, client, mock_db, fake_redis):
        """Once the budget is spent, the route is not even reached — so a
        caller cannot burn the budget and then keep probing."""
        from fastapi import HTTPException

        with patch(
            "apps.api.routers.comments.validate_share_link_with_session",
            side_effect=HTTPException(404, "Share link not found"),
        ) as validate:
            for _ in range(BUDGET + 1):
                _post(client)
            calls_before = validate.call_count
            assert _post(client).status_code == 429
            assert validate.call_count == calls_before


class TestTheIpBrake:
    def test_it_exists_and_is_generous(
        self, client, mock_db, fake_redis, unknown_link, monkeypatch
    ):
        """Kept loose on purpose: the address may be a whole agency's, or the
        tunnel's own. Lowered here so the test does not have to send 120
        requests across four tokens to prove it is wired up."""
        from apps.api.config import settings

        monkeypatch.setattr(settings, "share_comment_rate_limit_per_ip", 5)
        for i in range(5):
            assert _post(client, token=f"{i:032d}").status_code == 404
        # A SIXTH token from the same address: the token buckets are all
        # empty, so only the IP brake can answer.
        assert _post(client, token="e" * 32).status_code == 429

    def test_another_address_is_unaffected(
        self, client, mock_db, fake_redis, unknown_link, monkeypatch
    ):
        from apps.api.config import settings

        monkeypatch.setattr(settings, "share_comment_rate_limit_per_ip", 5)
        for i in range(6):
            _post(client, token=f"{i:032d}", ip="203.0.113.9")
        assert _post(client, token="f" * 32, ip="203.0.113.9").status_code == 429
        assert _post(client, token="g" * 32, ip="198.51.100.4").status_code == 404


class TestTheConfiguration:
    def test_both_budgets_are_settings(self):
        from apps.api.config import settings

        assert settings.share_comment_rate_limit_per_token == 30
        assert settings.share_comment_rate_limit_token_window_seconds == 600
        # Generous, and more generous than the token bucket.
        assert (
            settings.share_comment_rate_limit_per_ip
            > settings.share_comment_rate_limit_per_token
        )

    def test_the_actions_cannot_collide_with_any_other_bucket(self):
        from apps.api.middleware import rate_limit as rl

        assert SHARE_COMMENT_TOKEN_ACTION != SHARE_COMMENT_IP_ACTION
        for other in (rl.LOGIN_EMAIL_ACTION, rl.LOGIN_IP_ACTION):
            assert other not in (SHARE_COMMENT_TOKEN_ACTION, SHARE_COMMENT_IP_ACTION)

    def test_the_budget_is_read_at_call_time(
        self, client, mock_db, fake_redis, unknown_link, monkeypatch
    ):
        """Not captured at import, so an operator's override — and a test's —
        takes effect."""
        from apps.api.config import settings

        monkeypatch.setattr(settings, "share_comment_rate_limit_per_token", 2)
        token = uuid.uuid4().hex
        assert _post(client, token=token).status_code == 404
        assert _post(client, token=token).status_code == 404
        assert _post(client, token=token).status_code == 429

    def test_the_listing_is_not_metered_by_this(self, client, mock_db, fake_redis):
        """GET /share/{token}/comments is a read and keeps the behaviour it
        had; this limiter is about the write. Pinned so a later "symmetry"
        change is a deliberate one."""
        from apps.api.main import app
        from apps.api.middleware.rate_limit import share_comment_rate_limit

        route = [
            r for r in app.routes
            if getattr(r, "path", None) == "/share/{token}/comments"
        ][0]
        assert not any(
            d.call is share_comment_rate_limit for d in route.dependant.dependencies
        )
