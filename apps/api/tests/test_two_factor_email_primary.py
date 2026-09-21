"""Email as the PRIMARY second factor, not only a fallback (§194).

§191 shipped email as a way out for someone who had lost their
authenticator: you enrolled with TOTP, and mail was the escape hatch. This
adds email as a thing you can enrol WITH — no authenticator app anywhere in
the flow — which changes two things that are easy to get wrong and are
therefore what this file is mostly about.

First, the code has to be sent without being asked for. A TOTP user clicking
"email me a code instead" is making a claim; an email-primary user is not
claiming anything, email simply IS their factor, so login sends the code
itself. That automatic send is the part with an abuse profile: anyone
holding a password can reach the 2FA gate over and over, so the send is
idempotent per TTL window rather than once per attempt.

Second, enrolment has to prove the right thing. Confirm-setup exists to
check that the factor the user will be asked for at every future login
actually reaches them — which for email means the mailed code and nothing
else, the same way the TOTP branch refuses a backup code.
"""
import uuid
from unittest.mock import MagicMock, patch

import pyotp
import pytest

from apps.api.models.user import UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import create_2fa_pending_token

_VERIFY_PASSWORD = "apps.api.routers.auth.verify_password"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_HAS_LIVE_CODE = "apps.api.routers.auth.has_live_2fa_email_code"
_STORE_CODE = "apps.api.routers.auth.store_2fa_email_code"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_VERIFY_EMAIL_CODE = "apps.api.routers.auth.verify_2fa_email_code"
#: §204 — ENROLMENT codes live in their own pool, so `/auth/2fa/setup` and
#: `/auth/2fa/confirm-setup` touch these three, not the challenge pool above.
#: Patching the wrong pair leaves the real functions reaching a Redis that is
#: not there; patching only one leaves half the separation unexercised.
_HAS_LIVE_SETUP_CODE = "apps.api.routers.auth.has_live_2fa_setup_code"
_STORE_SETUP_CODE = "apps.api.routers.auth.store_2fa_setup_code"
_VERIFY_SETUP_CODE = "apps.api.routers.auth.verify_2fa_setup_code"


def _user(*, enabled=False, method=None, secret=None, backup=None):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "u@example.com"
    u.password_hash = "$2b$12$fake"
    u.status = UserStatus.active
    u.deleted_at = None
    u.two_factor_enabled = enabled
    u.two_factor_method = method
    u.totp_secret_encrypted = totp_service.encrypt_secret(secret) if secret else None
    u.backup_codes_hashed = backup
    # §199 — explicit for the same reason as the 2FA fields: every
    # MagicMock attribute is truthy, and a mock one here lands inside a
    # JWT payload, which cannot serialise it.
    u.token_version = 0
    return u


def _login(client, mock_db, user, *, live_code=False):
    mock_db.first.return_value = user
    with patch(_VERIFY_PASSWORD, return_value=True), \
         patch(_REQUIRE_2FA, return_value=False), \
         patch(_HAS_LIVE_CODE, return_value=live_code), \
         patch(_STORE_CODE) as store, \
         patch(_SEND_TASK) as send:
        resp = client.post(
            "/auth/login", json={"email": user.email, "password": "pw123456"}
        )
    return resp, store, send


def _setup(client, mock_db, user, body):
    """§204 — an email enrolment writes to the SETUP pool, so that is the one
    stubbed and the one `store` reports on."""
    mock_db.first.return_value = user
    with patch(_HAS_LIVE_SETUP_CODE, return_value=False), \
         patch(_STORE_SETUP_CODE) as store, \
         patch(_SEND_TASK) as send:
        resp = client.post("/auth/2fa/setup", json=body)
    return resp, store, send


def _stage(store, user, method, secret=None):
    """What /auth/2fa/setup would have staged (§194b).

    Confirm reads the method and the secret from the staging store rather
    than from the user row, so a test that confirms without running setup
    has to plant them here.
    """
    store[str(user.id)] = {
        "method": method,
        "secret": totp_service.encrypt_secret(secret) if secret else None,
    }


def _confirm(client, mock_db, user, code, *, email_code_ok=False):
    mock_db.first.return_value = user
    # §204 — confirm-setup verifies against the SETUP pool only, which is
    # exactly what stops a login-challenge code from completing an enrolment.
    with patch(_VERIFY_SETUP_CODE, return_value=(email_code_ok, "")):
        return client.post(
            "/auth/2fa/confirm-setup",
            json={"code": code, "pending_token": create_2fa_pending_token(str(user.id))},
        )


# ── login sends the code by itself ──────────────────────────────────────────

class TestLoginMailsTheCodeForAnEmailPrimaryUser:
    def test_the_code_is_sent_without_being_asked_for(self, client, mock_db):
        """The whole difference from §191's fallback: no "send me one" click
        stands between the password and the code."""
        resp, store, send = _login(client, mock_db, _user(enabled=True, method="email"))

        assert resp.status_code == 200
        store.assert_called_once()
        send.assert_called_once()
        assert resp.json()["email_code_sent"] is True

    def test_the_response_says_which_code_to_ask_for(self, client, mock_db):
        """So the client can draw "check your email" rather than "open your
        authenticator" without a second round-trip to find out which."""
        resp, _, _ = _login(client, mock_db, _user(enabled=True, method="email"))

        assert resp.json()["method"] == "email"

    def test_a_totp_user_is_mailed_nothing(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        resp, store, send = _login(
            client, mock_db, _user(enabled=True, method="totp", secret=secret)
        )

        body = resp.json()
        assert body["method"] == "totp"
        assert body["email_code_sent"] is False
        store.assert_not_called()
        send.assert_not_called()

    def test_a_row_predating_the_column_is_treated_as_totp(self, client, mock_db):
        """NULL means an enrolment from before a method could be chosen, and
        TOTP was the only thing enrolment could produce then. Mailing that
        user a code would be wrong twice: unasked-for mail, and a login
        screen pointed at the wrong factor."""
        resp, store, _ = _login(client, mock_db, _user(enabled=True, method=None))

        assert resp.json()["method"] == "totp"
        store.assert_not_called()

    def test_an_outstanding_code_is_not_replaced(self, client, mock_db):
        """Two page loads must not mail two codes — the second would
        invalidate the one already in the person's inbox — and a password
        holder hammering the gate must not be able to mail a code per
        attempt."""
        resp, store, send = _login(
            client, mock_db, _user(enabled=True, method="email"), live_code=True
        )

        assert resp.json()["email_code_sent"] is False
        store.assert_not_called()
        send.assert_not_called()

    def test_the_gate_itself_is_unchanged(self, client, mock_db):
        """Sending the code is not the same as passing the factor: still a
        pending token, still no session."""
        resp, _, _ = _login(client, mock_db, _user(enabled=True, method="email"))

        body = resp.json()
        assert body["requires_2fa"] is True
        assert body["pending_token"]
        assert "access_token" not in body

    def test_forced_enrolment_names_no_method_and_mails_nothing(self, client, mock_db):
        """A user being pushed into enrolment has not chosen a method yet —
        choosing one is what the enrolment screen is for."""
        user = _user(enabled=False)
        mock_db.first.return_value = user
        with patch(_VERIFY_PASSWORD, return_value=True), \
             patch(_REQUIRE_2FA, return_value=True), \
             patch(_STORE_CODE) as store:
            resp = client.post(
                "/auth/login", json={"email": user.email, "password": "pw123456"}
            )

        body = resp.json()
        assert body["setup_required"] is True
        assert body["method"] is None
        assert body["email_code_sent"] is False
        store.assert_not_called()


# ── enrolling with email ────────────────────────────────────────────────────

class TestEnrolByEmail:
    def _body(self, user, **extra):
        return {"pending_token": create_2fa_pending_token(str(user.id)), **extra}

    def test_setup_mails_a_code_and_generates_no_secret(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user()

        resp, store, send = _setup(client, mock_db, user, self._body(user, method="email"))

        assert resp.status_code == 200
        assert staged_2fa_setup[str(user.id)]["secret"] is None
        assert user.totp_secret_encrypted is None
        store.assert_called_once()
        send.assert_called_once()
        assert resp.json()["email_code_sent"] is True

    def test_setup_stages_the_choice_and_leaves_the_row_alone(
        self, client, mock_db, staged_2fa_setup
    ):
        """§194b — the choice is staged, not written. An abandoned setup
        must leave the account exactly as it found it."""
        user = _user()

        _setup(client, mock_db, user, self._body(user, method="email"))

        assert staged_2fa_setup[str(user.id)]["method"] == "email"
        assert user.two_factor_method is None
        assert user.two_factor_enabled is False

    def test_setup_returns_no_totp_fields_to_draw(
        self, client, mock_db, staged_2fa_setup
    ):
        """There is nothing to scan, and a null provisioning_uri the client
        has to test for is why `method` is in the response at all."""
        user = _user()

        body = _setup(client, mock_db, user, self._body(user, method="email"))[0].json()

        assert body["method"] == "email"
        assert body["provisioning_uri"] is None
        assert body["qr_code_data_uri"] is None
        assert body["secret"] is None

    def test_omitting_the_method_still_enrols_TOTP(
        self, client, mock_db, staged_2fa_setup
    ):
        """Every caller written before this field existed keeps working."""
        user = _user()

        body = _setup(client, mock_db, user, self._body(user))[0].json()

        assert body["method"] == "totp"
        assert body["provisioning_uri"].startswith("otpauth://")
        assert staged_2fa_setup[str(user.id)]["method"] == "totp"

    def test_the_mailed_code_completes_enrolment(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user()
        _stage(staged_2fa_setup, user, "email")

        resp = _confirm(client, mock_db, user, "123456", email_code_ok=True)

        body = resp.json()
        assert resp.status_code == 200
        assert user.two_factor_enabled is True
        assert user.two_factor_method == "email"
        assert body["method"] == "email"
        assert len(body["backup_codes"]) == 10

    def test_a_wrong_mailed_code_enables_nothing(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user()
        _stage(staged_2fa_setup, user, "email")

        resp = _confirm(client, mock_db, user, "000000", email_code_ok=False)

        assert resp.status_code == 401
        assert user.two_factor_enabled is False

    def test_confirm_accepts_ONLY_the_mailed_code(
        self, client, mock_db, staged_2fa_setup
    ):
        """A backup code proves nothing about whether mail reaches this
        address, which is the one thing this step checks — the same rule the
        TOTP branch applies to its own factor."""
        codes = totp_service.generate_backup_codes()
        user = _user(backup=totp_service.hash_backup_codes(codes))
        _stage(staged_2fa_setup, user, "email")

        resp = _confirm(client, mock_db, user, codes[0], email_code_ok=False)

        assert resp.status_code == 401
        assert user.two_factor_enabled is False

    def test_confirming_email_clears_a_leftover_authenticator(
        self, client, mock_db, staged_2fa_setup
    ):
        """A previous TOTP enrolment leaves a secret on the row, and
        `_second_factor_matches` tries TOTP first — so without this, a user
        whose second factor is now email would keep a way in nobody
        remembers agreeing to."""
        user = _user(secret=totp_service.generate_totp_secret())
        _stage(staged_2fa_setup, user, "email")

        _confirm(client, mock_db, user, "123456", email_code_ok=True)

        assert user.totp_secret_encrypted is None

    def test_a_totp_enrolment_still_demands_the_authenticator(
        self, client, mock_db, staged_2fa_setup
    ):
        """The regression that matters: the email branch must not become a
        second way to satisfy a TOTP enrolment. A valid emailed code is
        offered here and must be refused."""
        secret = totp_service.generate_totp_secret()
        user = _user()
        _stage(staged_2fa_setup, user, "totp", secret)

        resp = _confirm(client, mock_db, user, "000000", email_code_ok=True)

        assert resp.status_code == 401
        assert user.two_factor_enabled is False

        ok = _confirm(client, mock_db, user, pyotp.TOTP(secret).now(), email_code_ok=False)
        assert ok.status_code == 200
        assert user.two_factor_method == "totp"


# ── the explicit "send me a code" endpoint keeps its old behaviour ──────────

class TestTheFallbackEndpointStillForces:
    def test_it_replaces_an_outstanding_code(self, client, mock_db):
        """Login's send is idempotent; this one is not, and the difference
        is the point. Reaching this endpoint IS the user saying the code
        they have did not arrive."""
        user = _user(enabled=True, method="email")
        mock_db.first.return_value = user

        with patch(_HAS_LIVE_CODE, return_value=True) as live, \
             patch(_STORE_CODE) as store, \
             patch(_SEND_TASK) as send:
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(user.id))},
            )

        assert resp.status_code == 200
        store.assert_called_once()
        send.assert_called_once()
        live.assert_not_called()
