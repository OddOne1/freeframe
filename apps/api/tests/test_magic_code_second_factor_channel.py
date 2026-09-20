"""A magic-code login may not be completed by an emailed second factor (§199).

The two primary credentials this login screen offers are not interchangeable
once the second factor is also a channel. A password proves something the
user KNOWS; a magic code proves control of their MAILBOX. Mail the second
factor to that same mailbox and the account is protected by one channel
wearing two hats — whoever can read the inbox holds both halves.

The pending token carried no record of which credential produced it, so
§194's automatic send and §192's /auth/2fa/send-email-fallback both mailed a
second code to the address that had just been used as the first factor.
Found by FilmBill running the flow end to end against a mail catcher during
its port of this code, not by reading it: every unit test on both sides
passed, because each half is correct on its own.

The rule, in four places:
  * a magic-code login does not AUTO-SEND an email code to an
    email-enrolled user (routers/auth.py::_login_outcome)
  * it refuses to send one ON REQUEST (/auth/2fa/send-email-fallback)
  * it refuses to ENROL email as the second factor mid-login (/auth/2fa/setup)
  * and an already-live emailed code does not VERIFY on that path
    (/auth/2fa/verify-login, via _second_factor_matches)

A password login is unaffected in all four.
"""

import uuid
from unittest.mock import MagicMock, patch

from apps.api.models.user import UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import (
    VIA_MAGIC_CODE,
    VIA_PASSWORD,
    create_2fa_pending_token,
    pending_token_via,
)

_REDIS_OK = "apps.api.routers.auth.redis_verify_magic_code"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_SEND_CODE = "apps.api.routers.auth._send_2fa_email_code"
_VERIFY_EMAIL_CODE = "apps.api.routers.auth.verify_2fa_email_code"


def _user(*, method="email"):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "u@example.com"
    u.status = UserStatus.active
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.email_verified = True
    u.two_factor_enabled = True
    u.two_factor_method = method
    u.totp_secret_encrypted = (
        totp_service.encrypt_secret(totp_service.generate_totp_secret())
        if method == "totp"
        else None
    )
    u.backup_codes_hashed = None
    # §199 — explicit for the same reason as the 2FA fields: every
    # MagicMock attribute is truthy, and a mock one here lands inside a
    # JWT payload, which cannot serialise it.
    u.token_version = 0
    return u


class TestThePendingTokenRecordsItsOrigin:
    def test_a_password_login_is_marked_as_such(self, client, mock_db):
        user = _user(method="totp")
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch(_REQUIRE_2FA, return_value=False):
            resp = client.post(
                "/auth/login",
                json={"email": user.email, "password": "hunter2hunter2"},
            )

        assert pending_token_via(resp.json()["pending_token"]) == VIA_PASSWORD

    def test_a_magic_code_login_is_marked_as_such(self, client, mock_db):
        user = _user(method="totp")
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert pending_token_via(resp.json()["pending_token"]) == VIA_MAGIC_CODE

    def test_a_forced_enrolment_token_carries_the_origin_too(self, client, mock_db):
        """The other arm of _login_outcome. A user forced into enrolment by
        the instance-wide setting reaches /2fa/setup with this token, and
        that is where the email-enrolment refusal reads it."""
        user = _user(method="totp")
        user.two_factor_enabled = False
        user.two_factor_method = None
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert resp.json()["setup_required"] is True
        assert pending_token_via(resp.json()["pending_token"]) == VIA_MAGIC_CODE

    def test_a_token_with_no_claim_reads_as_password(self):
        """The permissive default, and the right one: only the magic-code
        path mints the restricted kind, and it always sets the claim. A
        token from before this change is an old PASSWORD login."""
        from datetime import datetime, timedelta, timezone

        from jose import jwt

        from apps.api.config import settings
        from apps.api.services.auth_service import TWOFA_PENDING_TOKEN_TYPE

        legacy = jwt.encode(
            {
                "sub": str(uuid.uuid4()),
                "type": TWOFA_PENDING_TOKEN_TYPE,
                "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
            },
            settings.jwt_secret,
            algorithm=settings.jwt_algorithm,
        )
        assert pending_token_via(legacy) == VIA_PASSWORD

    def test_a_garbage_token_still_reads_as_password_rather_than_raising(self):
        """pending_token_via is called on tokens the caller has not yet
        proved anything about. It must answer, not explode — the real
        rejection happens in _user_from_pending a line later."""
        assert pending_token_via("") == VIA_PASSWORD
        assert pending_token_via("not-a-jwt") == VIA_PASSWORD


class TestNoAutoSendAfterAMagicCode:
    def test_an_email_enrolled_user_is_not_mailed_a_second_code(self, client, mock_db):
        """THE regression. Two codes in one inbox is one factor, twice."""
        user = _user(method="email")
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_SEND_CODE) as send:
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        body = resp.json()
        assert body["requires_2fa"] is True
        assert body["email_code_sent"] is False
        send.assert_not_called()

    def test_a_password_login_still_mails_one(self, client, mock_db):
        """The restriction is about the CHANNEL, not about 2FA in general.
        An email-enrolled user signing in with their password is the case
        the automatic send exists for, and it must be untouched."""
        user = _user(method="email")
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_SEND_CODE, return_value=True) as send:
            resp = client.post(
                "/auth/login",
                json={"email": user.email, "password": "hunter2hunter2"},
            )

        assert resp.json()["email_code_sent"] is True
        send.assert_called_once()


class TestTheFallbackIsRefusedOnThatPath:
    def test_requesting_one_after_a_magic_code_is_refused(self, client, mock_db):
        user = _user(method="totp")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        with patch(_SEND_CODE) as send:
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": pending},
            )

        assert resp.status_code == 403
        send.assert_not_called()

    def test_the_refusal_says_what_to_do_instead(self, client, mock_db):
        """A dead end the user cannot get out of is worse than the risk it
        avoids, so the message names both ways forward."""
        user = _user(method="totp")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        with patch(_SEND_CODE):
            detail = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": pending},
            ).json()["detail"].lower()

        assert "backup code" in detail
        assert "password" in detail

    def test_requesting_one_after_a_password_login_still_works(self, client, mock_db):
        """The lost-authenticator path, which is what this endpoint is for."""
        user = _user(method="totp")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_PASSWORD)

        with patch(_SEND_CODE, return_value=True) as send:
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": pending},
            )

        assert resp.status_code == 200
        send.assert_called_once()

    def test_an_authenticated_caller_is_unaffected(self, client, mock_db, test_user):
        """§192's authenticated branch has no pending token at all, so there
        is no origin to restrict. It must not be caught by this rule."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_optional_user

        test_user.two_factor_enabled = True
        app.dependency_overrides[get_optional_user] = lambda: test_user
        try:
            with patch(_SEND_CODE, return_value=True) as send:
                resp = client.post("/auth/2fa/send-email-fallback", json={})
        finally:
            app.dependency_overrides.pop(get_optional_user, None)

        assert resp.status_code == 200
        send.assert_called_once()


class TestEnrolmentCannotChooseTheSameChannel:
    def test_enrolling_email_mid_magic_code_login_is_refused(
        self, client, mock_db, staged_2fa_setup
    ):
        """Otherwise the very next step reads the confirmation code out of
        the mailbox that was already the first factor."""
        user = _user(method="totp")
        user.two_factor_enabled = False
        user.two_factor_method = None
        user.totp_secret_encrypted = None
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        with patch(_SEND_CODE) as send:
            resp = client.post(
                "/auth/2fa/setup",
                json={"pending_token": pending, "method": "email"},
            )

        assert resp.status_code == 400
        send.assert_not_called()
        assert staged_2fa_setup == {}

    def test_enrolling_totp_mid_magic_code_login_is_fine(
        self, client, mock_db, staged_2fa_setup
    ):
        """An authenticator is a different channel, which is the whole
        point — this path must stay open, or a forced enrolment after a
        magic-code login would have nowhere to go."""
        user = _user(method="totp")
        user.two_factor_enabled = False
        user.two_factor_method = None
        user.totp_secret_encrypted = None
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        resp = client.post(
            "/auth/2fa/setup",
            json={"pending_token": pending, "method": "totp"},
        )

        assert resp.status_code == 200
        assert resp.json()["method"] == "totp"
        assert staged_2fa_setup

    def test_enrolling_email_from_a_password_login_is_fine(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user(method="totp")
        user.two_factor_enabled = False
        user.two_factor_method = None
        user.totp_secret_encrypted = None
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_PASSWORD)

        with patch(_SEND_CODE, return_value=True):
            resp = client.post(
                "/auth/2fa/setup",
                json={"pending_token": pending, "method": "email"},
            )

        assert resp.status_code == 200
        assert resp.json()["method"] == "email"


class TestAnAlreadyLiveEmailedCodeDoesNotVerifyOnThatPath:
    """Refusing to SEND is most of the fix, but not all of it.

    An emailed 2FA code from a recent password login stays valid for its
    whole TTL window. Without this last gate, an attacker holding only the
    mailbox could sign in with a magic code and redeem that still-live code
    as the second factor — no new mail required, so nothing above would have
    stopped them.
    """

    def test_an_emailed_code_is_refused_after_a_magic_code_login(
        self, client, mock_db
    ):
        user = _user(method="email")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        with patch(_VERIFY_EMAIL_CODE, return_value=(True, "")) as verify:
            resp = client.post(
                "/auth/2fa/verify-login",
                json={"pending_token": pending, "code": "123456"},
            )

        assert resp.status_code == 401
        # Not merely rejected after the fact — the emailed form is never
        # consulted, so a live code is not spent by the attempt either.
        verify.assert_not_called()

    def test_the_same_code_completes_a_password_login(self, client, mock_db):
        user = _user(method="email")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_PASSWORD)

        with patch(_VERIFY_EMAIL_CODE, return_value=(True, "")):
            resp = client.post(
                "/auth/2fa/verify-login",
                json={"pending_token": pending, "code": "123456"},
            )

        assert resp.status_code == 200
        assert resp.json()["access_token"]

    def test_a_backup_code_still_completes_a_magic_code_login(self, client, mock_db):
        """The way out that the refusal message promises. If this broke, an
        email-enrolled user signing in with a magic code would be locked out
        of their own account rather than merely redirected."""
        user = _user(method="email")
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        with patch(_VERIFY_EMAIL_CODE, return_value=(False, "Invalid code")), \
             patch(
                 "apps.api.services.totp_service.consume_backup_code",
                 return_value=(True, []),
             ):
            resp = client.post(
                "/auth/2fa/verify-login",
                json={"pending_token": pending, "code": "AAAA-BBBB"},
            )

        assert resp.status_code == 200
        assert resp.json()["access_token"]

    def test_an_authenticator_code_still_completes_a_magic_code_login(
        self, client, mock_db
    ):
        import pyotp

        secret = totp_service.generate_totp_secret()
        user = _user(method="totp")
        user.totp_secret_encrypted = totp_service.encrypt_secret(secret)
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id), via=VIA_MAGIC_CODE)

        resp = client.post(
            "/auth/2fa/verify-login",
            json={"pending_token": pending, "code": pyotp.TOTP(secret).now()},
        )

        assert resp.status_code == 200
        assert resp.json()["access_token"]

    def test_the_authenticated_reauth_paths_keep_the_emailed_factor(
        self, client, mock_db, test_user
    ):
        """§192 lists the emailed fallback as acceptable re-auth proof for
        self-service disable. Those callers hold a session, not a pending
        token, so there is no primary credential in question and the
        restriction must not reach them."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        test_user.two_factor_enabled = True
        test_user.totp_secret_encrypted = None
        test_user.backup_codes_hashed = None
        app.dependency_overrides[get_current_user] = lambda: test_user
        try:
            with patch(_VERIFY_EMAIL_CODE, return_value=(True, "")):
                resp = client.post("/auth/2fa/disable", json={"code": "123456"})
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert resp.json()["two_factor_enabled"] is False
