"""Password-reset codes live in their own Redis pool (§197).

Both purposes used to write `magic_code:{email}` through an unconditional
`setex`, so asking for a password-reset code destroyed a pending login code
for the same address, and vice versa — whichever was requested second simply
won, silently. §191 had already refused that arrangement between login codes
and 2FA codes ("different operations that should not be able to collide or
overwrite each other's pending code"); since §195 the case for separating
these two is stronger still, because they no longer even obey the same
policy: login codes are refused instance-wide once 2FA is required, reset
codes are deliberately still issued.

The assertions here are about Redis state, not HTTP status, because the
collision was invisible at the HTTP layer: both requests answered 200 while
one quietly overwrote the other.

The property this must NOT change is also pinned below: verification still
runs `_login_outcome` for both purposes, so a reset code alone still does
not hand an enrolled user a session. /auth/verify-magic-code returns a real,
fully-privileged token — bypassing 2FA on the reset door would reopen
exactly the compromised-inbox takeover §193 closed on the login door.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserGlobalRole, UserStatus
from apps.api.services import redis_service as rs
from apps.api.services import totp_service


class FakeRedis:
    """Enough Redis to hold codes and attempt counters.

    A fake rather than a mock: these tests are about which KEY holds what,
    so the thing under test has to actually store by key. TTLs are recorded
    but not enforced — nothing here tests expiry, and a sleeping test would
    be a worse way to assert it.
    """

    def __init__(self):
        self.values: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    def setex(self, key, ttl, value):
        self.values[key] = str(value)
        self.ttls[key] = ttl

    def get(self, key):
        return self.values.get(key)

    def delete(self, *keys):
        for k in keys:
            self.values.pop(k, None)
            self.ttls.pop(k, None)

    def incr(self, key):
        self.values[key] = str(int(self.values.get(key, 0)) + 1)
        return int(self.values[key])

    def expire(self, key, ttl):
        self.ttls[key] = ttl

    def ttl(self, key):
        return self.ttls.get(key, -2)


@pytest.fixture
def fake_redis():
    r = FakeRedis()
    with patch("apps.api.services.redis_service.get_redis", return_value=r):
        yield r


EMAIL = "u@example.com"
LOGIN_KEY = f"{rs.MAGIC_CODE_PREFIX}{EMAIL}"
RESET_KEY = f"{rs.PASSWORD_RESET_CODE_PREFIX}{EMAIL}"


# ── the collision ───────────────────────────────────────────────────────────

class TestTheTwoPoolsDoNotOverwriteEachOther:
    def test_a_reset_code_does_not_evict_a_pending_login_code(self, fake_redis):
        rs.store_magic_code(EMAIL, "111111")
        rs.store_password_reset_code(EMAIL, "222222")

        assert fake_redis.get(LOGIN_KEY) == "111111"
        assert fake_redis.get(RESET_KEY) == "222222"

    def test_a_login_code_does_not_evict_a_pending_reset_code(self, fake_redis):
        rs.store_password_reset_code(EMAIL, "222222")
        rs.store_magic_code(EMAIL, "111111")

        assert fake_redis.get(RESET_KEY) == "222222"
        assert fake_redis.get(LOGIN_KEY) == "111111"

    def test_they_are_different_keys_at_all(self, fake_redis):
        rs.store_magic_code(EMAIL, "111111")

        assert LOGIN_KEY != RESET_KEY
        assert fake_redis.get(RESET_KEY) is None

    def test_one_pool_does_not_accept_the_other_pools_code(self, fake_redis):
        rs.store_magic_code(EMAIL, "111111")
        rs.store_password_reset_code(EMAIL, "222222")

        assert rs.verify_magic_code(EMAIL, "222222")[0] is False
        assert rs.verify_password_reset_code(EMAIL, "111111")[0] is False
        # And neither wrong attempt spent the code it was aimed at.
        assert rs.verify_magic_code(EMAIL, "111111")[0] is True
        assert rs.verify_password_reset_code(EMAIL, "222222")[0] is True

    def test_spending_one_leaves_the_other_alone(self, fake_redis):
        rs.store_magic_code(EMAIL, "111111")
        rs.store_password_reset_code(EMAIL, "222222")

        assert rs.verify_magic_code(EMAIL, "111111")[0] is True

        assert fake_redis.get(LOGIN_KEY) is None
        assert fake_redis.get(RESET_KEY) == "222222"

    def test_the_attempt_ceilings_are_separate_too(self, fake_redis):
        """A shared counter would let wrong guesses against one purpose lock
        the user out of the other."""
        rs.store_magic_code(EMAIL, "111111")
        rs.store_password_reset_code(EMAIL, "222222")

        for _ in range(rs.MAX_PASSWORD_RESET_ATTEMPTS):
            rs.verify_password_reset_code(EMAIL, "000000")

        assert rs.verify_password_reset_code(EMAIL, "222222")[0] is False  # locked
        assert rs.verify_magic_code(EMAIL, "111111")[0] is True  # untouched

    def test_a_reset_code_is_consumed_on_use(self, fake_redis):
        rs.store_password_reset_code(EMAIL, "222222")

        assert rs.verify_password_reset_code(EMAIL, "222222")[0] is True
        assert rs.verify_password_reset_code(EMAIL, "222222")[0] is False

    def test_every_prefix_in_this_file_is_distinct(self):
        """Three pools now key off an email address — login, password reset,
        and §191's 2FA code. A prefix accidentally reused would recreate the
        collision this section exists to remove, in a way no behavioural
        test would catch until it happened to a user."""
        prefixes = {
            rs.MAGIC_CODE_PREFIX,
            rs.PASSWORD_RESET_CODE_PREFIX,
            rs.TWOFA_EMAIL_CODE_PREFIX,
            rs.MAGIC_CODE_ATTEMPTS_PREFIX,
            rs.PASSWORD_RESET_ATTEMPTS_PREFIX,
            rs.TWOFA_EMAIL_ATTEMPTS_PREFIX,
        }
        assert len(prefixes) == 6


class TestAUsersOwnTwoFactorStateIsReadable:
    """§197 — the settings screen needs "is it on, and which method" and had
    no way to ask. Asserted on the schema rather than through /auth/me,
    because that endpoint's own test has been failing on an unrelated,
    pre-existing MagicMock serialisation issue since before this change."""

    def test_the_fields_are_carried(self):
        from apps.api.schemas.auth import UserResponse

        body = UserResponse.model_validate(_user(enrolled=True)).model_dump()

        assert body["two_factor_enabled"] is True
        assert body["two_factor_method"] == "totp"

    def test_a_user_created_a_moment_ago_reads_as_not_enrolled(self):
        """A User that has never been flushed has None here — the column's
        server default has not been applied yet. /auth/register serialises
        exactly such an object."""
        from apps.api.schemas.auth import UserResponse

        fresh = _user()
        fresh.two_factor_enabled = None
        fresh.two_factor_method = None

        body = UserResponse.model_validate(fresh).model_dump()

        assert body["two_factor_enabled"] is False


# ── through the endpoints ───────────────────────────────────────────────────

def _user(*, enrolled=False, secret=None):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = EMAIL
    u.name = "Test User"
    u.first_name = "Test"
    u.last_name = "User"
    u.avatar_url = None
    u.status = UserStatus.active
    u.email_verified = True
    u.role = UserGlobalRole.user
    u.invite_token = None
    u.preferences = {}
    u.created_at = datetime.now(timezone.utc)
    u.storage_limit_bytes = None
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.two_factor_enabled = enrolled
    u.two_factor_method = "totp" if enrolled else None
    u.totp_secret_encrypted = totp_service.encrypt_secret(secret) if secret else None
    u.backup_codes_hashed = None
    # §199 — explicit for the same reason as the 2FA fields: every
    # MagicMock attribute is truthy, and a mock one here lands inside a
    # JWT payload, which cannot serialise it.
    u.token_version = 0
    return u


class TestTheEndpointsUseTheRightPool:
    def test_a_reset_request_writes_only_the_reset_key(self, client, mock_db, fake_redis):
        mock_db.first.return_value = _user()

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False), \
             patch("apps.api.routers.auth.send_task_safe"):
            resp = client.post(
                "/auth/send-magic-code",
                json={"email": EMAIL, "purpose": "password_reset"},
            )

        assert resp.status_code == 200
        assert fake_redis.get(RESET_KEY) is not None
        assert fake_redis.get(LOGIN_KEY) is None

    def test_a_login_request_writes_only_the_login_key(self, client, mock_db, fake_redis):
        mock_db.first.return_value = _user()

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False), \
             patch("apps.api.routers.auth.send_task_safe"):
            resp = client.post("/auth/send-magic-code", json={"email": EMAIL})

        assert resp.status_code == 200
        assert fake_redis.get(LOGIN_KEY) is not None
        assert fake_redis.get(RESET_KEY) is None

    def test_verification_checks_the_pool_the_caller_names(self, client, mock_db, fake_redis):
        mock_db.first.return_value = _user()
        rs.store_password_reset_code(EMAIL, "222222")

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False):
            wrong_pool = client.post(
                "/auth/verify-magic-code",
                json={"email": EMAIL, "code": "222222"},
            )
            right_pool = client.post(
                "/auth/verify-magic-code",
                json={"email": EMAIL, "code": "222222", "purpose": "password_reset"},
            )

        assert wrong_pool.status_code == 401
        assert right_pool.status_code == 200
        assert right_pool.json()["access_token"]

    def test_omitting_the_purpose_still_means_login(self, client, mock_db, fake_redis):
        """Every caller written before this field existed keeps working."""
        mock_db.first.return_value = _user()
        rs.store_magic_code(EMAIL, "111111")

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False):
            resp = client.post(
                "/auth/verify-magic-code", json={"email": EMAIL, "code": "111111"}
            )

        assert resp.status_code == 200


class TestTheTwoFactorGateIsUnchangedForBOTHPurposes:
    """The property §197 is careful NOT to touch.

    /auth/verify-magic-code hands back a real session, not something scoped
    to "reset a password" — so an enrolled user must still be stopped at the
    second factor whichever door they came through.
    """

    @pytest.mark.parametrize("purpose", ["login", "password_reset"])
    def test_an_enrolled_user_is_still_stopped_at_the_second_factor(
        self, client, mock_db, fake_redis, purpose
    ):
        user = _user(enrolled=True, secret=totp_service.generate_totp_secret())
        mock_db.first.return_value = user
        if purpose == "password_reset":
            rs.store_password_reset_code(EMAIL, "222222")
            code = "222222"
        else:
            rs.store_magic_code(EMAIL, "111111")
            code = "111111"

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": EMAIL, "code": code, "purpose": purpose},
            )

        body = resp.json()
        assert resp.status_code == 200
        assert body["requires_2fa"] is True
        assert "access_token" not in body

    def test_the_code_is_still_spent_even_though_no_session_was_issued(
        self, client, mock_db, fake_redis
    ):
        """The code was genuinely correct: it is consumed, and the email is
        verified. Those are facts about the address, not grants of access."""
        user = _user(enrolled=True, secret=totp_service.generate_totp_secret())
        mock_db.first.return_value = user
        rs.store_password_reset_code(EMAIL, "222222")

        with patch("apps.api.routers.auth.require_2fa_enabled", return_value=False):
            client.post(
                "/auth/verify-magic-code",
                json={"email": EMAIL, "code": "222222", "purpose": "password_reset"},
            )

        assert fake_redis.get(RESET_KEY) is None
