"""An enrolment code is not a sign-in code (§204).

§203 put a sentence in the enrolment mail:

    "Enter this code in Settings → Profile to turn on two-factor
     authentication. This code cannot be used to sign in."

It was not true. Every emailed 2FA code went into one Redis key,
`2fa_email_code:<email>`, and `_second_factor_matches` redeems from that key
for any password login — so an enrolment code satisfied a login challenge for
its whole ten-minute life. The `purpose` argument §203 added changed the
wording of the mail and nothing about where the code lived.

**The severity was low and is recorded as low.** The code is mailed to the
LOGIN address, so anyone able to redeem it already reads the mailbox a
challenge code would arrive in, and could have had one sent to themselves. It
was never a new way in. What it was is a security mail making an absolute
claim the system did not keep — which is worth fixing rather than rewording.

Two user-visible symptoms shared the root cause, and §203's copy split is what
surfaced them: a live challenge code suppressed the enrolment send (the
idempotency window is per key), so the enrolment screen said "a code was
already sent" and the mail the user opened read "Enter this code to finish
signing in" — right code, wrong instructions, wrong screen. And the reverse,
for the rest of the window.

Every test here drives the real endpoints against an in-memory stand-in for
the two pools, so what is asserted is which pool a code lands in and which
pool each endpoint reads — the actual subject of the change.
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import create_2fa_pending_token

_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_VERIFY_PASSWORD = "apps.api.routers.auth.verify_password"


class FakePool:
    """One code pool: store / has-live / verify / clear, with attempts.

    A hand-rolled double rather than fakeredis, because the property under
    test is that there are TWO of these and that nothing reads across them.
    Two independent instances make that visible in the test itself; a shared
    fake keyed by string prefix would reproduce the very coupling §204
    removes.
    """

    def __init__(self, max_attempts: int = 5):
        self.codes: dict[str, str] = {}
        self.attempts: dict[str, int] = {}
        self.max_attempts = max_attempts

    def store(self, email: str, code: str) -> None:
        self.codes[email.lower()] = code
        self.attempts.pop(email.lower(), None)

    def has_live(self, email: str) -> bool:
        return email.lower() in self.codes

    def verify(self, email: str, code: str) -> tuple[bool, str]:
        key = email.lower()
        if self.attempts.get(key, 0) >= self.max_attempts:
            return False, "Too many attempts. Request a new code."
        stored = self.codes.get(key)
        if not stored:
            return False, "Code expired or not found"
        if stored != code:
            self.attempts[key] = self.attempts.get(key, 0) + 1
            return False, "Invalid code"
        del self.codes[key]
        self.attempts.pop(key, None)
        return True, ""

    def clear(self, email: str) -> None:
        self.codes.pop(email.lower(), None)
        self.attempts.pop(email.lower(), None)


#: ORDER MATTERS where a test also uses `staged_2fa_setup`: both fixtures
#: patch `apps.api.routers.auth.clear_2fa_setup_code`, and the one set up
#: LAST wins. conftest's copy is a bare no-op — it exists so confirm-setup
#: does not reach a Redis that is not there — whereas this one routes the
#: call into the fake pool so a test can observe the cleanup actually
#: happening. So every test below requests `staged_2fa_setup` first and
#: `pools` second. Written down because the failure it causes is silent: the
#: cleanup simply never reaches the pool and the assertion reads as a missing
#: feature rather than a fixture-ordering problem.
@pytest.fixture
def pools():
    """Both pools, wired into the router in place of the real Redis calls.

    Yields `(challenge, setup)`. A test reads `.codes[email]` to learn the
    code that was actually issued — which is what lets these assertions be
    about behaviour rather than about which function was called.
    """
    challenge = FakePool()
    setup = FakePool()

    with patch("apps.api.routers.auth.store_2fa_email_code", side_effect=challenge.store), \
         patch("apps.api.routers.auth.has_live_2fa_email_code", side_effect=challenge.has_live), \
         patch("apps.api.routers.auth.verify_2fa_email_code", side_effect=challenge.verify), \
         patch("apps.api.routers.auth.store_2fa_setup_code", side_effect=setup.store), \
         patch("apps.api.routers.auth.has_live_2fa_setup_code", side_effect=setup.has_live), \
         patch("apps.api.routers.auth.verify_2fa_setup_code", side_effect=setup.verify), \
         patch("apps.api.routers.auth.clear_2fa_setup_code", side_effect=setup.clear), \
         patch(_SEND_TASK):
        yield challenge, setup


EMAIL = "u@example.com"


def _user(*, two_factor_enabled=False, method=None, secret=None):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = EMAIL
    u.status = UserStatus.active
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.email_verified = True
    u.token_version = 0
    u.two_factor_enabled = two_factor_enabled
    u.two_factor_method = method
    u.totp_secret_encrypted = (
        totp_service.encrypt_secret(secret) if secret else None
    )
    u.backup_codes_hashed = None
    u.require_2fa = False
    return u


def _as_signed_in(user):
    """Override the OPTIONAL dependency: /auth/2fa/setup and /confirm-setup
    both serve a signed-in user AND a mid-login one, so they take
    `get_optional_user`."""
    from apps.api.main import app
    from apps.api.middleware.auth import get_optional_user

    app.dependency_overrides[get_optional_user] = lambda: user
    return app


def _clear_override():
    from apps.api.main import app
    from apps.api.middleware.auth import get_optional_user

    app.dependency_overrides.pop(get_optional_user, None)


def _start_email_enrolment(client, user):
    app = _as_signed_in(user)
    try:
        return client.post("/auth/2fa/setup", json={"method": "email"})
    finally:
        _clear_override()


def _login_challenge(client, mock_db, user):
    mock_db.first.return_value = user
    with patch(_VERIFY_PASSWORD, return_value=True), patch(_REQUIRE_2FA, return_value=False):
        return client.post("/auth/login", json={"email": user.email, "password": "pw"})


# ── 1. §203's sentence, as an assertion ─────────────────────────────────────


class TestASetupCodeCannotSignYouIn:
    def test_the_login_challenge_rejects_an_enrolment_code(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """The headline. Fails before §204."""
        challenge, setup = pools
        user = _user()

        assert _start_email_enrolment(client, user).status_code == 200
        enrolment_code = setup.codes[EMAIL]

        # Now that same person is enrolled and at a login challenge.
        enrolled = _user(two_factor_enabled=True, method="email")
        enrolled.id = user.id
        mock_db.first.return_value = enrolled
        resp = client.post(
            "/auth/2fa/verify-login",
            json={
                "pending_token": create_2fa_pending_token(str(enrolled.id)),
                "code": enrolment_code,
            },
        )

        assert resp.status_code == 401
        # And it is still sitting in its own pool, unspent — the challenge
        # path could not even see it.
        assert setup.codes[EMAIL] == enrolment_code

    def test_the_challenge_pool_never_receives_the_enrolment_code(
        self, client, staged_2fa_setup, pools
    ):
        """Where the code lands is the whole mechanism."""
        challenge, setup = pools
        user = _user()

        _start_email_enrolment(client, user)

        assert setup.has_live(EMAIL) is True
        assert challenge.has_live(EMAIL) is False


# ── 2. the mirror ───────────────────────────────────────────────────────────


class TestAChallengeCodeCannotConfirmEnrolment:
    def test_confirm_setup_rejects_a_login_challenge_code(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        challenge, setup = pools
        enrolled = _user(two_factor_enabled=True, method="email")

        _login_challenge(client, mock_db, enrolled)
        challenge_code = challenge.codes[EMAIL]

        # Meanwhile the same person starts an email enrolment.
        candidate = _user()
        candidate.id = enrolled.id
        _start_email_enrolment(client, candidate)

        app = _as_signed_in(candidate)
        try:
            resp = client.post(
                "/auth/2fa/confirm-setup", json={"code": challenge_code}
            )
        finally:
            _clear_override()

        assert resp.status_code == 401
        assert candidate.two_factor_enabled is not True

    def test_the_enrolment_code_itself_still_confirms(
        self, client, staged_2fa_setup, pools
    ):
        """Separation must not break the thing it separates."""
        challenge, setup = pools
        user = _user()

        _start_email_enrolment(client, user)
        code = setup.codes[EMAIL]

        app = _as_signed_in(user)
        try:
            resp = client.post("/auth/2fa/confirm-setup", json={"code": code})
        finally:
            _clear_override()

        assert resp.status_code == 200, resp.json()
        assert user.two_factor_enabled is True
        assert user.two_factor_method == "email"
        assert len(resp.json()["backup_codes"]) > 0


# ── 3. the two windows are independent ──────────────────────────────────────


class TestTheIdempotencyWindowsDoNotCross:
    def test_a_live_challenge_code_no_longer_suppresses_an_enrolment_send(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """The symptom that made this visible.

        Before §204 the enrolment call found a live code in the shared pool,
        skipped the send, and the screen said "a code was already sent" —
        while the mail waiting in the inbox read "Enter this code to finish
        signing in".
        """
        challenge, setup = pools
        enrolled = _user(two_factor_enabled=True, method="email")

        _login_challenge(client, mock_db, enrolled)
        assert challenge.has_live(EMAIL) is True

        candidate = _user()
        candidate.id = enrolled.id
        resp = _start_email_enrolment(client, candidate)

        assert resp.json()["email_code_sent"] is True
        assert setup.has_live(EMAIL) is True
        # Two live codes, two pools, and they are not the same code.
        assert setup.codes[EMAIL] != challenge.codes[EMAIL]

    def test_the_enrolment_mail_is_the_setup_copy(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """And it is sent with the enrolment wording, not the challenge's."""
        challenge, setup = pools
        enrolled = _user(two_factor_enabled=True, method="email")
        _login_challenge(client, mock_db, enrolled)

        candidate = _user()
        candidate.id = enrolled.id
        with patch(_SEND_TASK) as send:
            _start_email_enrolment(client, candidate)

        purposes = [c.args[4] for c in send.call_args_list if len(c.args) > 4]
        assert purposes == ["two_factor_setup"]

    def test_a_live_setup_code_no_longer_suppresses_a_challenge_send(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """The reverse, which would have locked a user out of signing in for
        the rest of the window."""
        challenge, setup = pools
        candidate = _user()

        _start_email_enrolment(client, candidate)
        assert setup.has_live(EMAIL) is True

        enrolled = _user(two_factor_enabled=True, method="email")
        enrolled.id = candidate.id
        resp = _login_challenge(client, mock_db, enrolled)

        assert resp.json()["email_code_sent"] is True
        assert challenge.has_live(EMAIL) is True

    def test_each_pool_keeps_its_own_idempotency(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """Separating them must not lose the §194 rule that made them quiet:
        two enrolment starts still mail one code."""
        challenge, setup = pools
        user = _user()

        first = _start_email_enrolment(client, user)
        second = _start_email_enrolment(client, user)

        assert first.json()["email_code_sent"] is True
        assert second.json()["email_code_sent"] is False


# ── 4. separate attempts buckets ────────────────────────────────────────────


class TestTheAttemptsBucketsAreSeparate:
    """Modelled on §197's separated-pools test.

    Burning one allowance must not lock the other: somebody fumbling an
    enrolment code should still be able to sign in, and somebody fumbling a
    sign-in code should still be able to finish enrolling.
    """

    def test_burning_the_setup_allowance_leaves_the_challenge_pool_usable(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        challenge, setup = pools
        user = _user()
        _start_email_enrolment(client, user)

        app = _as_signed_in(user)
        try:
            for _ in range(6):
                client.post("/auth/2fa/confirm-setup", json={"code": "000000"})
        finally:
            _clear_override()

        assert setup.verify(EMAIL, "000000")[1].startswith("Too many attempts")

        enrolled = _user(two_factor_enabled=True, method="email")
        enrolled.id = user.id
        _login_challenge(client, mock_db, enrolled)
        real = challenge.codes[EMAIL]
        mock_db.first.return_value = enrolled
        resp = client.post(
            "/auth/2fa/verify-login",
            json={
                "pending_token": create_2fa_pending_token(str(enrolled.id)),
                "code": real,
            },
        )

        assert resp.status_code == 200

    def test_burning_the_challenge_allowance_leaves_enrolment_usable(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        challenge, setup = pools
        enrolled = _user(two_factor_enabled=True, method="email")
        _login_challenge(client, mock_db, enrolled)

        mock_db.first.return_value = enrolled
        for _ in range(6):
            client.post(
                "/auth/2fa/verify-login",
                json={
                    "pending_token": create_2fa_pending_token(str(enrolled.id)),
                    "code": "000000",
                },
            )
        assert challenge.verify(EMAIL, "000000")[1].startswith("Too many attempts")

        candidate = _user()
        candidate.id = enrolled.id
        _start_email_enrolment(client, candidate)
        code = setup.codes[EMAIL]

        app = _as_signed_in(candidate)
        try:
            resp = client.post("/auth/2fa/confirm-setup", json={"code": code})
        finally:
            _clear_override()

        assert resp.status_code == 200, resp.json()


# ── 5. single use, and cleared once enrolment is done ───────────────────────


class TestSingleUseAndCleanup:
    def test_a_setup_code_cannot_be_redeemed_twice(
        self, client, staged_2fa_setup, pools
    ):
        challenge, setup = pools
        user = _user()
        _start_email_enrolment(client, user)
        code = setup.codes[EMAIL]

        app = _as_signed_in(user)
        try:
            first = client.post("/auth/2fa/confirm-setup", json={"code": code})
            # A second confirm has nothing staged AND nothing in the pool;
            # either way it must not succeed.
            second = client.post("/auth/2fa/confirm-setup", json={"code": code})
        finally:
            _clear_override()

        assert first.status_code == 200
        assert second.status_code in (400, 401)

    def test_confirming_clears_any_outstanding_setup_code(
        self, client, staged_2fa_setup, pools
    ):
        """Including for a TOTP enrolment, where a code from an earlier
        abandoned email attempt can still be live."""
        challenge, setup = pools
        secret = totp_service.generate_totp_secret()
        user = _user()

        # An email attempt that is started and abandoned...
        _start_email_enrolment(client, user)
        assert setup.has_live(EMAIL) is True

        # ...then the user enrols with an authenticator instead.
        staged_2fa_setup[str(user.id)] = {
            "method": "totp",
            "secret": totp_service.encrypt_secret(secret),
        }
        app = _as_signed_in(user)
        try:
            resp = client.post(
                "/auth/2fa/confirm-setup",
                json={"code": __import__("pyotp").TOTP(secret).now()},
            )
        finally:
            _clear_override()

        assert resp.status_code == 200, resp.json()
        assert setup.has_live(EMAIL) is False

    def test_a_login_verify_leaves_the_setup_pool_alone(
        self, client, mock_db, staged_2fa_setup, pools
    ):
        """Completing a sign-in is not this endpoint's licence to spend a
        code belonging to an enrolment in progress."""
        challenge, setup = pools
        candidate = _user()
        _start_email_enrolment(client, candidate)
        enrolment_code = setup.codes[EMAIL]

        enrolled = _user(two_factor_enabled=True, method="email")
        enrolled.id = candidate.id
        _login_challenge(client, mock_db, enrolled)
        mock_db.first.return_value = enrolled
        resp = client.post(
            "/auth/2fa/verify-login",
            json={
                "pending_token": create_2fa_pending_token(str(enrolled.id)),
                "code": challenge.codes[EMAIL],
            },
        )

        assert resp.status_code == 200
        assert setup.codes[EMAIL] == enrolment_code


# ── 5b. the REAL redis_service functions, against a fake Redis ──────────────


class FakeRedis:
    """Just enough Redis for the four code-pool functions.

    The FakePool doubles above stand in for those functions, which is right
    for testing the ROUTER — but it means the real key names never come into
    play, so a mutation that pointed both pools at one attempts key passed
    every one of them. Caught while mutation-checking §204, and this class is
    the answer: exercise `redis_service` itself, where the prefixes decide
    which bucket a counter lands in.
    """

    def __init__(self):
        self.store: dict[str, str] = {}

    def setex(self, key, _ttl, value):
        self.store[key] = str(value)

    def get(self, key):
        return self.store.get(key)

    def delete(self, *keys):
        for key in keys:
            self.store.pop(key, None)

    def incr(self, key):
        self.store[key] = str(int(self.store.get(key, 0)) + 1)

    def expire(self, key, _ttl):
        return True


@pytest.fixture
def fake_redis():
    from apps.api.services import redis_service as rs

    fake = FakeRedis()
    with patch.object(rs, "get_redis", return_value=fake):
        yield fake


class TestTheRealPoolsDoNotShareBuckets:
    def test_burning_the_setup_attempts_does_not_lock_the_challenge_pool(
        self, fake_redis
    ):
        """The behavioural form of "separate attempts buckets", run against
        the real key names rather than a double."""
        from apps.api.services import redis_service as rs

        rs.store_2fa_setup_code(EMAIL, "111111")
        rs.store_2fa_email_code(EMAIL, "222222")

        for _ in range(rs.MAX_TWOFA_SETUP_ATTEMPTS):
            assert rs.verify_2fa_setup_code(EMAIL, "000000")[0] is False
        assert rs.verify_2fa_setup_code(EMAIL, "111111") == (
            False,
            "Too many attempts. Request a new code.",
        )

        # The challenge pool is untouched and its correct code still works.
        assert rs.verify_2fa_email_code(EMAIL, "222222") == (True, "")

    def test_burning_the_challenge_attempts_does_not_lock_the_setup_pool(
        self, fake_redis
    ):
        from apps.api.services import redis_service as rs

        rs.store_2fa_setup_code(EMAIL, "111111")
        rs.store_2fa_email_code(EMAIL, "222222")

        for _ in range(rs.MAX_TWOFA_EMAIL_ATTEMPTS):
            assert rs.verify_2fa_email_code(EMAIL, "000000")[0] is False
        assert rs.verify_2fa_email_code(EMAIL, "222222")[0] is False

        assert rs.verify_2fa_setup_code(EMAIL, "111111") == (True, "")

    def test_storing_one_does_not_overwrite_the_other(self, fake_redis):
        """Two live codes for one address, at the same time — which is the
        state §204's idempotency fix deliberately allows."""
        from apps.api.services import redis_service as rs

        rs.store_2fa_email_code(EMAIL, "222222")
        rs.store_2fa_setup_code(EMAIL, "111111")

        assert rs.has_live_2fa_email_code(EMAIL) is True
        assert rs.has_live_2fa_setup_code(EMAIL) is True
        assert rs.verify_2fa_email_code(EMAIL, "222222")[0] is True
        assert rs.verify_2fa_setup_code(EMAIL, "111111")[0] is True

    def test_a_setup_code_does_not_verify_against_the_challenge_pool(
        self, fake_redis
    ):
        """The §204 property at the storage layer, with no router involved."""
        from apps.api.services import redis_service as rs

        rs.store_2fa_setup_code(EMAIL, "111111")

        assert rs.verify_2fa_email_code(EMAIL, "111111")[0] is False
        # And it survives the attempt, still redeemable where it belongs.
        assert rs.verify_2fa_setup_code(EMAIL, "111111")[0] is True

    def test_clearing_the_setup_code_leaves_the_challenge_code(self, fake_redis):
        from apps.api.services import redis_service as rs

        rs.store_2fa_email_code(EMAIL, "222222")
        rs.store_2fa_setup_code(EMAIL, "111111")

        rs.clear_2fa_setup_code(EMAIL)

        assert rs.has_live_2fa_setup_code(EMAIL) is False
        assert rs.has_live_2fa_email_code(EMAIL) is True


# ── 6. the pools really are distinct at the key level ───────────────────────


class TestTheKeysThemselvesDiffer:
    def test_every_code_pool_has_its_own_prefixes(self):
        """The §197/§200 invariant, extended.

        Five pools now, and no two may share a key or an attempts bucket —
        sharing either lets one overwrite the other's pending code, or lets
        one be redeemed for the other, which is what §204 is about.
        """
        from apps.api.services import redis_service as rs

        code_prefixes = [
            rs.MAGIC_CODE_PREFIX,
            rs.PASSWORD_RESET_CODE_PREFIX,
            rs.BACKUP_EMAIL_CODE_PREFIX,
            rs.TWOFA_EMAIL_CODE_PREFIX,
            rs.TWOFA_SETUP_CODE_PREFIX,
        ]
        attempt_prefixes = [
            rs.MAGIC_CODE_ATTEMPTS_PREFIX,
            rs.PASSWORD_RESET_ATTEMPTS_PREFIX,
            rs.BACKUP_EMAIL_ATTEMPTS_PREFIX,
            rs.TWOFA_EMAIL_ATTEMPTS_PREFIX,
            rs.TWOFA_SETUP_ATTEMPTS_PREFIX,
        ]

        assert len(set(code_prefixes)) == len(code_prefixes)
        assert len(set(attempt_prefixes)) == len(attempt_prefixes)
        assert not set(code_prefixes) & set(attempt_prefixes)

    def test_the_enrolment_code_key_is_not_the_staging_key(self):
        """`TWOFA_SETUP_CODE_PREFIX` and `TWOFA_SETUP_PREFIX` are one word
        apart and hold completely different things — the six-digit code
        keyed by email, and the staged secret keyed by user id."""
        from apps.api.services import redis_service as rs

        assert rs.TWOFA_SETUP_CODE_PREFIX != rs.TWOFA_SETUP_PREFIX
        assert not rs.TWOFA_SETUP_CODE_PREFIX.startswith(rs.TWOFA_SETUP_PREFIX)
        assert not rs.TWOFA_SETUP_PREFIX.startswith(rs.TWOFA_SETUP_CODE_PREFIX)
