"""Magic-code sign-in and self-registration close once 2FA is required (§195).

§193 established what a magic code actually is: a COMPLETE primary
credential, not a second factor — anyone who can read the email is holding
the whole of it. An instance that has decided every sign-in needs two
factors therefore cannot also offer a one-step sign-in that begins with
reading an email, and this closes that door at the only place codes are
issued.

The self-registration half goes with it, and it is the less obvious of the
two: POST /auth/send-magic-code creates a `pending_verification` user for
ANY address that asks, with no invite and no admin approval, reachable by
anyone who can load the login page. That is current behaviour today and
stays current behaviour while `require_2fa` is off — this is not a general
lockdown, it is tied to that one setting.

`password_reset` stays open on purpose. Magic-code login has always worked
without a password, so there are existing users whose `password_hash` is
NULL; closing reset as well would lock them out permanently with no way
back. The last test here walks that whole recovery path rather than
asserting it — a claim about a lockout is worth only as much as the walk
that proves it.
"""
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pyotp
import pytest

from apps.api.models.user import User, UserGlobalRole, UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import create_2fa_pending_token

_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_STORE_CODE = "apps.api.routers.auth.store_magic_code"
#: §197 — password-reset codes live in their own Redis pool, so the reset
#: path stores through a different function than the login path. Patching
#: only the login one would make a reset test pass while reaching a Redis
#: that is not there.
_STORE_RESET = "apps.api.routers.auth.store_password_reset_code"
_VERIFY_RESET = "apps.api.routers.auth.verify_password_reset_code"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_VERIFY_CODE = "apps.api.routers.auth.redis_verify_magic_code"

_REFUSAL = (
    "Magic-code sign-in is disabled on this instance. "
    "Sign in with your email and password."
)


def _user(*, email="u@example.com", password_hash="$2b$12$fake", enrolled=False):
    """A full user row: these tests reach endpoints that serialise one."""
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
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
    u.password_hash = password_hash
    u.two_factor_enabled = enrolled
    u.two_factor_method = "totp" if enrolled else None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    # §199 — explicit for the same reason as the 2FA fields: every
    # MagicMock attribute is truthy, and a mock one here lands inside a
    # JWT payload, which cannot serialise it.
    u.token_version = 0
    return u


def _send(client, mock_db, *, user, require_2fa, purpose=None, email="u@example.com"):
    mock_db.first.return_value = user
    body = {"email": email}
    if purpose is not None:
        body["purpose"] = purpose
    reset = purpose == "password_reset"
    with patch(_REQUIRE_2FA, return_value=require_2fa), \
         patch(_STORE_RESET if reset else _STORE_CODE) as store, \
         patch(_STORE_CODE if reset else _STORE_RESET) as other_pool, \
         patch(_SEND_TASK) as send:
        resp = client.post("/auth/send-magic-code", json=body)
    # The pool this purpose does NOT belong to is never written (§197).
    other_pool.assert_not_called()
    return resp, store, send


def _users_added(mock_db):
    """Every User the endpoint tried to persist — the account-creation half."""
    return [c.args[0] for c in mock_db.add.call_args_list if isinstance(c.args[0], User)]


# ── the state every install is in right now ─────────────────────────────────

class TestNothingChangesWhile2faIsOff:
    def test_an_existing_user_still_gets_a_login_code(self, client, mock_db):
        resp, store, send = _send(client, mock_db, user=_user(), require_2fa=False)

        assert resp.status_code == 200
        assert resp.json()["message"] == "Magic code sent to your email"
        store.assert_called_once()
        send.assert_called_once()

    def test_an_unknown_email_still_self_registers(self, client, mock_db):
        """Not an endorsement of this behaviour — a regression test for it.
        §195 changes it only when `require_2fa` is on."""
        resp, store, _ = _send(client, mock_db, user=None, require_2fa=False)

        added = _users_added(mock_db)
        assert resp.status_code == 200
        assert len(added) == 1
        assert added[0].email == "u@example.com"
        assert added[0].status == UserStatus.pending_verification
        store.assert_called_once()

    def test_password_reset_still_works(self, client, mock_db):
        resp, store, _ = _send(
            client, mock_db, user=_user(), require_2fa=False, purpose="password_reset"
        )

        assert resp.status_code == 200
        store.assert_called_once()

    def test_a_reset_for_an_unknown_email_still_says_nothing(self, client, mock_db):
        resp, store, _ = _send(
            client, mock_db, user=None, require_2fa=False, purpose="password_reset"
        )

        assert resp.status_code == 200
        assert resp.json()["message"] == "If that email has an account, a code has been sent"
        assert _users_added(mock_db) == []
        store.assert_not_called()


# ── with the requirement on ─────────────────────────────────────────────────

class TestLoginCodesAreRefusedWhen2faIsRequired:
    def test_an_existing_user_is_refused_and_no_code_is_stored(self, client, mock_db):
        """The response is only half of it: the property is that nothing
        reached Redis, so there is nothing for /auth/verify-magic-code to
        accept afterwards."""
        resp, store, send = _send(client, mock_db, user=_user(), require_2fa=True)

        assert resp.status_code == 403
        assert resp.json()["detail"] == _REFUSAL
        store.assert_not_called()
        send.assert_not_called()

    def test_an_explicit_login_purpose_is_refused_too(self, client, mock_db):
        resp, store, _ = _send(
            client, mock_db, user=_user(), require_2fa=True, purpose="login"
        )

        assert resp.status_code == 403
        store.assert_not_called()

    def test_an_unrecognised_purpose_is_refused_rather_than_waved_through(
        self, client, mock_db
    ):
        """The gate is written as "anything but password_reset", not as a
        list of known purposes — a purpose invented later must not open a
        way back in by default."""
        resp, store, _ = _send(
            client, mock_db, user=_user(), require_2fa=True, purpose="signup"
        )

        assert resp.status_code == 403
        store.assert_not_called()

    def test_no_account_is_created_for_an_unknown_email(self, client, mock_db):
        """The actual security property. Self-registration by anyone who can
        reach the login page is what closes here."""
        resp, store, _ = _send(client, mock_db, user=None, require_2fa=True)

        assert resp.status_code == 403
        assert _users_added(mock_db) == []
        mock_db.commit.assert_not_called()
        store.assert_not_called()

    def test_the_refusal_says_nothing_about_the_address(self, client, mock_db):
        """Identical for an account that exists and one that does not, so it
        is not an enumeration oracle. What it does reveal — that this
        instance requires 2FA — GET /site-settings already publishes to
        anonymous callers in `require_2fa`."""
        known, _, _ = _send(client, mock_db, user=_user(), require_2fa=True)
        unknown, _, _ = _send(
            client, mock_db, user=None, require_2fa=True, email="nobody@example.com"
        )

        assert known.status_code == unknown.status_code == 403
        assert known.json() == unknown.json()


class TestPasswordResetStaysOpen:
    def test_an_existing_user_can_still_request_one(self, client, mock_db):
        resp, store, send = _send(
            client, mock_db, user=_user(), require_2fa=True, purpose="password_reset"
        )

        assert resp.status_code == 200
        assert resp.json()["message"] == "Magic code sent to your email"
        store.assert_called_once()
        send.assert_called_once()

    def test_an_unknown_email_gets_the_same_silence_as_before(self, client, mock_db):
        resp, store, _ = _send(
            client, mock_db, user=None, require_2fa=True, purpose="password_reset"
        )

        assert resp.status_code == 200
        assert resp.json()["message"] == "If that email has an account, a code has been sent"
        assert _users_added(mock_db) == []
        store.assert_not_called()


class TestVerifyMagicCodeNeedsNoGateOfItsOwn:
    def test_a_code_issued_before_the_switch_still_verifies_into_the_2fa_gate(
        self, client, mock_db
    ):
        """Deliberately NOT touched. A code can only exist because
        send-magic-code minted it — that endpoint is the single caller of
        `store_magic_code` — so refusing to issue is enough, and the only
        codes that outlive the switch expire on their own within the TTL.
        They grant nothing meanwhile: §193 already stops every magic code at
        the second factor."""
        user = _user(enrolled=True)
        user.totp_secret_encrypted = totp_service.encrypt_secret(
            totp_service.generate_totp_secret()
        )
        mock_db.first.return_value = user

        with patch(_VERIFY_CODE, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        body = resp.json()
        assert resp.status_code == 200
        assert body["requires_2fa"] is True
        assert "access_token" not in body


# ── the recovery path, walked rather than asserted ──────────────────────────

class TestAPasswordlessUserCanStillGetBackIn:
    def test_reset_to_password_to_login_end_to_end(
        self, client, mock_db, staged_2fa_setup
    ):
        """The lockout this exemption exists to prevent, proven start to
        finish: a user with no password at all, on an instance that requires
        2FA, reaching a working email+password login without ever using a
        magic code to sign in."""
        user = _user(password_hash=None)
        mock_db.first.return_value = user

        # 1. The reset code is still issued.
        with patch(_REQUIRE_2FA, return_value=True), \
             patch(_STORE_RESET) as store, \
             patch(_SEND_TASK):
            sent = client.post(
                "/auth/send-magic-code",
                json={"email": user.email, "purpose": "password_reset"},
            )
        assert sent.status_code == 200
        store.assert_called_once()

        # 2. Redeeming it does NOT sign them in — it lands in §193's gate,
        #    which for an unenrolled user on a require_2fa instance means
        #    forced enrolment.
        with patch(_VERIFY_RESET, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=True):
            verified = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456", "purpose": "password_reset"},
            ).json()
        assert verified["requires_2fa"] is True
        assert verified["setup_required"] is True
        pending = verified["pending_token"]

        # 3. Enrol, using the pending token the gate handed back.
        secret = client.post(
            "/auth/2fa/setup", json={"pending_token": pending}
        ).json()["secret"]
        tokens = client.post(
            "/auth/2fa/confirm-setup",
            json={"code": pyotp.TOTP(secret).now(), "pending_token": pending},
        ).json()["tokens"]
        assert tokens["access_token"]

        # 4. Now they can set the password they never had.
        resp = client.post(
            "/auth/set-password",
            json={"password": "a-real-password-1"},
            headers={"Authorization": f"Bearer {tokens['access_token']}"},
        )
        assert resp.status_code == 200
        assert user.password_hash is not None

        # 5. And that password logs in — through the 2FA gate, as it should.
        with patch(_REQUIRE_2FA, return_value=True):
            login = client.post(
                "/auth/login",
                json={"email": user.email, "password": "a-real-password-1"},
            ).json()
        assert login["requires_2fa"] is True
        assert login["setup_required"] is False

        done = client.post(
            "/auth/2fa/verify-login",
            json={"pending_token": login["pending_token"], "code": pyotp.TOTP(secret).now()},
        )
        assert done.status_code == 200
        assert done.json()["access_token"]

    def test_the_login_screen_alone_cannot_reach_this_path(self, client, mock_db):
        """The exemption is narrow: it is the reset purpose that stays open,
        not the endpoint. An anonymous caller who simply omits `purpose`
        gets nothing, which is what stops the recovery path from being a
        rename away from the thing that just closed."""
        resp, store, _ = _send(client, mock_db, user=_user(password_hash=None), require_2fa=True)

        assert resp.status_code == 403
        store.assert_not_called()
