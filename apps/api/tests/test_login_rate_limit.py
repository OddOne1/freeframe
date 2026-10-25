"""§233 — POST /auth/login is metered, and metered per ACCOUNT.

Eight auth routes carried `rate_limit(...)` and the password login did not,
so a password could be guessed at whatever rate the global 300-writes-a-
minute middleware allowed. The obvious fix — hang the existing dependency on
it — is the wrong one here, and that is what most of this file is about.

`rate_limit()` keys on `X-Real-Ip`, and on this deployment that header is
written somewhere along Cloudflare Tunnel -> Traefik -> API. Two
possibilities, and nothing inside the process can distinguish them:

  * the value is the tunnel's own address, identical for every user — then
    one person's ten bad attempts lock everybody out of the instance;
  * the value is whatever the client sent — then an attacker increments it
    and is never limited at all.

So the real budget is keyed on the SUBMITTED EMAIL, hashed, and the IP keeps
only a deliberately generous brake. The properties worth testing are
therefore: the account bucket bites, it bites the right account and no
other, it cannot be read as an oracle for whether an account exists, it
expires, and the IP brake still exists and is configurable.

**Redis.** `check_rate_limit` is the repo's own counter and its arithmetic is
what these tests exercise, so the Redis underneath it is a dict with a clock
this file can advance (`_FakeRedis`) — the repo ships no fakeredis, and a
sleep-based window test is a slow flake. The same scenarios run against a
REAL Redis when TEST_REDIS_URL is set; see the last class.
"""
import os
import time
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserStatus


_FAKE_HASH = "$2b$12$fakehashforteststhatisnotrealatall00000000000000000000"
_VERIFY_PATCH = "apps.api.routers.auth.verify_password"

#: Strong enough for §200's policy; the login route never checks it, but a
#: password that looks plausible keeps these tests readable next to the ones
#: that do.
GOOD_PASSWORD = "Wq7#vLm2$kPz"


# ── a Redis whose clock this file owns ──────────────────────────────────────

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
    """Only the four operations `check_rate_limit` actually performs.

    Expiry is evaluated against `clock.now` rather than wall time, so the
    window-reset test is exact instead of sleeping for ten minutes.
    """

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
def _only_the_login_limiter_is_in_play():
    """Silence the two middlewares that would otherwise answer first.

    SetupGuardMiddleware reaches past the mocked session to the real
    `SessionLocal` and answers 503 until a superadmin exists — so with a
    reachable DATABASE_URL every assertion here would be about the guard.
    Same flag the rest of the suite gets for free from an unreachable one.

    GlobalRateLimitMiddleware is the subtler of the two: 300 writes per
    minute per identity, counted in a REAL Redis if REDIS_URL happens to
    point at one. This file deliberately sends hundreds of POSTs from one
    address, so it would start collecting that middleware's 429s instead of
    the login limiter's and the tests would pass or fail on how many ran
    before them. It holds its own `get_redis` reference (imported into its
    module at import time), so it is patched there and nowhere else — the
    login limiter's own Redis stays exactly as each test set it up.
    """
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


def _user(email):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.password_hash = _FAKE_HASH
    u.status = UserStatus.active
    u.deleted_at = None
    u.two_factor_enabled = False
    u.two_factor_method = None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    u.token_version = 0
    u.require_2fa = False
    return u


def _login(client, email, *, ip="203.0.113.7", password=GOOD_PASSWORD):
    return client.post(
        "/auth/login",
        json={"email": email, "password": password},
        headers={"x-real-ip": ip},
    )


# ── the account bucket ───────────────────────────────────────────────────────

class TestTheAccountBucket:
    def test_the_eleventh_attempt_for_one_email_is_429(self, client, mock_db, fake_redis):
        """Ten through, the eleventh throttled, with the limiter's own shape."""
        mock_db.first.return_value = None  # unknown address: every attempt 401s

        for n in range(10):
            resp = _login(client, "target@example.com")
            assert resp.status_code == 401, f"attempt {n + 1} should have gone through"

        resp = _login(client, "target@example.com")
        assert resp.status_code == 429
        assert "Retry-After" in resp.headers
        assert int(resp.headers["Retry-After"]) > 0
        assert "Too many requests" in resp.json()["detail"]

    def test_a_different_email_from_the_same_ip_still_works(
        self, client, mock_db, fake_redis
    ):
        """The point of keying on the account rather than the address.

        Under a per-IP limit this is the test that fails behind a tunnel:
        one user's bad attempts would spend the budget everyone shares.
        """
        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, "target@example.com")
        assert _login(client, "target@example.com").status_code == 429

        mock_db.first.return_value = _user("bystander@example.com")
        with patch(_VERIFY_PATCH, return_value=True):
            resp = _login(client, "bystander@example.com")  # same IP
        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_successes_count_too(self, client, mock_db, fake_redis):
        """Ten good logins also spend the budget.

        Deliberate: counting only failures lets an attacker who has found
        the password keep the bucket topped up, and nobody signs in ten
        times in ten minutes by hand.
        """
        mock_db.first.return_value = _user("busy@example.com")
        with patch(_VERIFY_PATCH, return_value=True):
            for _ in range(10):
                assert _login(client, "busy@example.com").status_code == 200
            assert _login(client, "busy@example.com").status_code == 429

    def test_case_and_whitespace_do_not_buy_a_second_allowance(
        self, client, mock_db, fake_redis
    ):
        """`Alice@Example.com ` is the same account, so it is the same bucket.

        Matches `get_user_by_email`'s own `strip().lower()`; if the two ever
        diverge, the limiter is trivially bypassed by holding the shift key.
        """
        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, "alice@example.com")
        assert _login(client, "  ALICE@Example.com  ").status_code == 429

    def test_the_email_is_not_a_redis_key(self, fake_redis):
        """Keys reach MONITOR, slowlog and any keyspace dump.

        A per-account limiter whose keys spell out who tried to sign in
        would leak more than the limit protects.
        """
        from apps.api.middleware.rate_limit import (
            LOGIN_EMAIL_ACTION, login_email_bucket,
        )
        from apps.api.services.redis_service import (
            RATE_LIMIT_PREFIX, check_rate_limit,
        )

        check_rate_limit(
            login_email_bucket("secret@example.com"), LOGIN_EMAIL_ACTION, 10, 600
        )

        keys = list(fake_redis.values)
        assert keys
        assert all("secret@example.com" not in k and "secret" not in k for k in keys)
        assert all(
            k.startswith(f"{RATE_LIMIT_PREFIX}{LOGIN_EMAIL_ACTION}:") for k in keys
        )


# ── it must not become an existence oracle ───────────────────────────────────

class TestItRevealsNothingAboutWhoExists:
    def test_unknown_and_known_throttle_identically(self, client, mock_db, fake_redis):
        """Same status, same body, same headers — for both.

        The bucket is derived from the submitted string before any database
        lookup, so there is no branch here that could differ. This asserts
        the consequence rather than trusting the code shape.
        """
        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, "ghost@example.com")
        unknown = _login(client, "ghost@example.com")

        mock_db.first.return_value = _user("real@example.com")
        with patch(_VERIFY_PATCH, return_value=True):
            for _ in range(11):
                _login(client, "real@example.com")
            known = _login(client, "real@example.com")

        assert unknown.status_code == known.status_code == 429
        assert unknown.json() == known.json()
        assert unknown.headers["Retry-After"] == known.headers["Retry-After"]

    def test_an_unknown_email_is_metered_at_all(self, client, mock_db, fake_redis):
        """It has to be.

        If only addresses that exist were counted, "did this one get
        throttled?" would answer "does this account exist?" — a cleaner
        oracle than the 401 the endpoint carefully avoids being.
        """
        mock_db.first.return_value = None
        for _ in range(10):
            assert _login(client, "nobody@example.com").status_code == 401
        assert _login(client, "nobody@example.com").status_code == 429

    def test_a_wrong_password_and_an_unknown_email_still_look_the_same(
        self, client, mock_db, fake_redis
    ):
        """§191's existing guarantee, re-checked with the limiter in place."""
        mock_db.first.return_value = None
        unknown = _login(client, "ghost2@example.com")

        mock_db.first.return_value = _user("real2@example.com")
        with patch(_VERIFY_PATCH, return_value=False):
            wrong = _login(client, "real2@example.com")

        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json() == wrong.json()


# ── the window ───────────────────────────────────────────────────────────────

class TestTheWindow:
    def test_it_reopens_when_the_window_passes(self, client, mock_db, fake_redis, clock):
        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, "patient@example.com")
        assert _login(client, "patient@example.com").status_code == 429

        clock.advance(601)

        assert _login(client, "patient@example.com").status_code == 401

    def test_it_is_still_shut_just_before_the_window_passes(
        self, client, mock_db, fake_redis, clock
    ):
        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, "impatient@example.com")

        clock.advance(599)

        assert _login(client, "impatient@example.com").status_code == 429


# ── the per-IP brake ─────────────────────────────────────────────────────────

class TestThePerIpBrake:
    """Worth exactly as much as whatever writes X-Real-Ip — hence generous."""

    def test_it_triggers_at_its_budget(self, client, mock_db, fake_redis, monkeypatch):
        """Spread across many accounts, so only the IP bucket can stop it."""
        from apps.api.config import settings

        monkeypatch.setattr(settings, "login_rate_limit_per_ip", 5)
        mock_db.first.return_value = None

        for n in range(5):
            assert _login(client, f"spread{n}@example.com").status_code == 401

        resp = _login(client, "spread-last@example.com")
        assert resp.status_code == 429
        assert "Retry-After" in resp.headers

    def test_another_ip_is_unaffected(self, client, mock_db, fake_redis, monkeypatch):
        from apps.api.config import settings

        monkeypatch.setattr(settings, "login_rate_limit_per_ip", 5)
        mock_db.first.return_value = None

        for n in range(6):
            _login(client, f"a{n}@example.com", ip="198.51.100.1")
        assert _login(client, "a9@example.com", ip="198.51.100.1").status_code == 429
        assert _login(client, "b1@example.com", ip="198.51.100.2").status_code == 401

    def test_both_budgets_are_settings(self):
        """Not constants in the middleware: an operator can move them.

        Read at call time rather than captured at import, which is what
        makes the monkeypatching above work and what would let a config
        reload take effect without a code change.
        """
        from apps.api.config import settings

        for name, default in (
            ("login_rate_limit_per_email", 10),
            ("login_rate_limit_email_window_seconds", 600),
            ("login_rate_limit_per_ip", 60),
            ("login_rate_limit_ip_window_seconds", 600),
        ):
            assert getattr(settings, name) == default

        source = open("apps/api/middleware/rate_limit.py").read()
        assert "settings.login_rate_limit_per_email" in source
        assert "settings.login_rate_limit_per_ip" in source

    def test_the_ip_bucket_cannot_collide_with_the_account_bucket(self):
        from apps.api.middleware.rate_limit import LOGIN_EMAIL_ACTION, LOGIN_IP_ACTION
        import apps.api.routers.auth as auth_router

        assert LOGIN_EMAIL_ACTION != LOGIN_IP_ACTION
        source = open(auth_router.__file__).read()
        for existing in (
            "send_magic_code", "verify_magic_code", "verify_2fa",
            "send_2fa_email_fallback", "send_2fa_reauth_code",
            "set_backup_email", "resend_backup_email_code", "verify_backup_email",
        ):
            assert f'rate_limit("{existing}"' in source
            assert existing not in (LOGIN_EMAIL_ACTION, LOGIN_IP_ACTION)


# ── nothing else about the route moved ───────────────────────────────────────

class TestEverythingElseIsUnchanged:
    def test_a_login_under_budget_is_byte_identical(self, client, mock_db, fake_redis):
        """§191's success shape, with the limiter in the dependency list."""
        mock_db.first.return_value = _user("fine@example.com")
        with patch(_VERIFY_PATCH, return_value=True):
            resp = _login(client, "fine@example.com")

        assert resp.status_code == 200
        body = resp.json()
        assert set(body) == {
            "access_token", "refresh_token", "token_type",
            "needs_password", "requires_2fa",
        }
        assert body["requires_2fa"] is False
        assert body["token_type"] == "bearer"

    def test_the_2fa_gate_still_returns_a_pending_token(self, client, mock_db, fake_redis):
        user = _user("twofa@example.com")
        user.two_factor_enabled = True
        user.two_factor_method = "totp"
        mock_db.first.return_value = user

        with patch(_VERIFY_PATCH, return_value=True):
            resp = _login(client, "twofa@example.com")

        assert resp.status_code == 200
        body = resp.json()
        assert body["requires_2fa"] is True
        assert body["setup_required"] is False
        assert body["method"] == "totp"
        assert body["pending_token"]

    def test_a_malformed_body_still_gets_422_not_500(self, client, mock_db, fake_redis):
        """The limiter reads the body before FastAPI has validated it."""
        resp = client.post(
            "/auth/login",
            content=b"{not json at all",
            headers={"content-type": "application/json", "x-real-ip": "203.0.113.9"},
        )
        assert resp.status_code == 422

    def test_a_body_with_no_email_still_gets_422(self, client, mock_db, fake_redis):
        resp = client.post("/auth/login", json={"password": GOOD_PASSWORD})
        assert resp.status_code == 422

    def test_the_route_carries_the_dependency(self):
        """The mutation test's anchor: delete the dependency, this fails."""
        import apps.api.routers.auth as auth_router
        from apps.api.middleware.rate_limit import login_rate_limit

        route = next(
            r for r in auth_router.router.routes
            if getattr(r, "path", None) == "/auth/login"
        )
        assert any(
            d.call is login_rate_limit for d in route.dependant.dependencies
        ), "/auth/login lost its §233 login_rate_limit dependency"

    def test_the_other_auth_routes_keep_their_ip_limiter(self):
        """No behaviour change for the eight routes that already had one."""
        import apps.api.routers.auth as auth_router

        source = open(auth_router.__file__).read()
        assert source.count("Depends(rate_limit(") == 8


# ── the same thing, against a real Redis ─────────────────────────────────────

REDIS_URL = os.environ.get("TEST_REDIS_URL")

realredis = pytest.mark.skipif(
    not REDIS_URL,
    reason="needs TEST_REDIS_URL pointing at a reachable Redis; the fake "
           "above proves the arithmetic, this proves the storage",
)


@pytest.fixture
def live_redis():
    """A real client, and the keys it touches are deleted afterwards.

    The fake above is faithful to what `check_rate_limit` CALLS. What it
    cannot show is that a real Redis expires the counter on its own and
    that `ttl` on a live key answers what `Retry-After` promises, so these
    few run against the real thing.
    """
    import redis as redis_lib

    client = redis_lib.from_url(REDIS_URL, decode_responses=True)
    client.ping()
    before = set(client.keys("rl:login_*"))
    with patch("apps.api.services.redis_service.get_redis", return_value=client):
        yield client
    for key in set(client.keys("rl:login_*")) - before:
        client.delete(key)


@realredis
class TestAgainstARealRedis:
    def test_the_eleventh_attempt_is_429(self, client, mock_db, live_redis):
        mock_db.first.return_value = None
        email = f"live-{uuid.uuid4().hex[:8]}@example.com"

        for _ in range(10):
            assert _login(client, email).status_code == 401
        resp = _login(client, email)

        assert resp.status_code == 429
        assert 0 < int(resp.headers["Retry-After"]) <= 600

    def test_a_different_email_from_the_same_ip_still_works(
        self, client, mock_db, live_redis
    ):
        blocked = f"live-{uuid.uuid4().hex[:8]}@example.com"
        other = f"live-{uuid.uuid4().hex[:8]}@example.com"

        mock_db.first.return_value = None
        for _ in range(11):
            _login(client, blocked)
        assert _login(client, blocked).status_code == 429

        mock_db.first.return_value = _user(other)
        with patch(_VERIFY_PATCH, return_value=True):
            assert _login(client, other).status_code == 200

    def test_the_stored_key_is_a_hash(self, client, mock_db, live_redis):
        from apps.api.middleware.rate_limit import (
            LOGIN_EMAIL_ACTION, login_email_bucket,
        )

        mock_db.first.return_value = None
        email = f"live-{uuid.uuid4().hex[:8]}@example.com"
        _login(client, email)

        expected = f"rl:{LOGIN_EMAIL_ACTION}:{login_email_bucket(email)}"
        assert live_redis.get(expected) == "1"
        assert not live_redis.keys(f"*{email}*")

    def test_the_window_really_expires(self, client, mock_db, live_redis, monkeypatch):
        """Redis drops the counter by itself; nothing in the app resets it."""
        from apps.api.config import settings

        monkeypatch.setattr(settings, "login_rate_limit_per_email", 2)
        monkeypatch.setattr(settings, "login_rate_limit_email_window_seconds", 2)
        mock_db.first.return_value = None
        email = f"live-{uuid.uuid4().hex[:8]}@example.com"

        for _ in range(2):
            assert _login(client, email).status_code == 401
        assert _login(client, email).status_code == 429

        time.sleep(2.5)

        assert _login(client, email).status_code == 401
