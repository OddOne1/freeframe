"""Starting a NEW enrolment cannot destroy the live one (§194b).

Two properties, and the second is the one that bites.

First, re-enrolling is a weakening action. It decides what "a valid second
factor" means for the account from here on, which is the same class of
change as turning 2FA off — and §192 already refuses that on a bearer token
alone, because a stolen session must not be able to strip the protection
that exists because sessions get stolen. /auth/2fa/setup was the one path
still doing it for free, and it is the worse of the two: it locks the owner
out rather than merely letting an attacker in.

Second, and independent of who is calling: nothing about a setup may touch
the user row until confirm-setup succeeds. It used to write the new secret
and method immediately, so one call — mistaken, stray, or hostile — replaced
a working authenticator with one nobody had ever used, while
`two_factor_enabled` stayed True and the account stayed gated on it. The
lockout needed no attacker and no abandonment; a closed tab was enough.

The tests that matter most here assert the STATE of the user row, not the
HTTP status. A refusal that still corrupted the row would pass a status
check and fail the account.
"""
import uuid
from unittest.mock import MagicMock, patch

import pyotp
import pytest

from apps.api.models.user import UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import create_2fa_pending_token

_NO_EMAIL_CODE = "apps.api.routers.auth.verify_2fa_email_code"
_HAS_LIVE_CODE = "apps.api.routers.auth.has_live_2fa_email_code"
_STORE_CODE = "apps.api.routers.auth.store_2fa_email_code"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_VERIFY_PASSWORD = "apps.api.routers.auth.verify_password"


def _enrolled(*, method="totp", secret=None, codes=None):
    """A user whose 2FA is actually on — the row this change protects."""
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "u@example.com"
    u.password_hash = "$2b$12$fake"
    u.status = UserStatus.active
    u.deleted_at = None
    u.two_factor_enabled = True
    u.two_factor_method = method
    u._secret = secret or (totp_service.generate_totp_secret() if method == "totp" else None)
    u.totp_secret_encrypted = (
        totp_service.encrypt_secret(u._secret) if u._secret else None
    )
    u.backup_codes_hashed = totp_service.hash_backup_codes(codes) if codes else None
    return u


def _unenrolled():
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "new@example.com"
    u.password_hash = "$2b$12$fake"
    u.status = UserStatus.active
    u.deleted_at = None
    u.two_factor_enabled = False
    u.two_factor_method = None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    return u


@pytest.fixture
def app():
    from apps.api.main import app as fastapi_app

    yield fastapi_app
    from apps.api.middleware.auth import get_current_user, get_optional_user

    fastapi_app.dependency_overrides.pop(get_current_user, None)
    fastapi_app.dependency_overrides.pop(get_optional_user, None)


def _as(app, user):
    """Sign the TestClient in as `user`.

    `get_optional_user` is the one /auth/2fa/setup actually depends on;
    `get_current_user` is overridden too so the same helper serves any
    session-authenticated endpoint a test here reaches for.
    """
    from apps.api.middleware.auth import get_current_user, get_optional_user

    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


def _setup(client, mock_db, user, body, *, session=None):
    mock_db.first.return_value = user
    if session is not None:
        _as(session, user)
    with patch(_NO_EMAIL_CODE, return_value=(False, "")), \
         patch(_HAS_LIVE_CODE, return_value=False), \
         patch(_STORE_CODE) as store_code, \
         patch(_SEND_TASK) as send:
        resp = client.post("/auth/2fa/setup", json=body)
    return resp, store_code, send


def _row_state(user):
    """What must not change behind a refused or unconfirmed setup."""
    return (user.totp_secret_encrypted, user.two_factor_method, user.two_factor_enabled)


# ── the gate ────────────────────────────────────────────────────────────────

class TestReEnrolmentNeedsTheCurrentFactor:
    def test_no_code_is_refused_and_the_row_is_untouched(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """The lockout, stated as an assertion. A bearer token alone used to
        be enough to replace this user's authenticator."""
        user = _enrolled()
        before = _row_state(user)

        resp, _, _ = _setup(client, mock_db, user, {}, session=app)

        assert resp.status_code == 401
        assert _row_state(user) == before
        assert staged_2fa_setup == {}
        mock_db.commit.assert_not_called()

    def test_a_wrong_code_is_refused_and_the_row_is_untouched(
        self, client, app, mock_db, staged_2fa_setup
    ):
        user = _enrolled()
        before = _row_state(user)

        resp, _, _ = _setup(
            client, mock_db, user, {"reauth_code": "000000"}, session=app
        )

        assert resp.status_code == 401
        assert _row_state(user) == before
        assert staged_2fa_setup == {}

    def test_an_email_primary_user_is_gated_the_same_way(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """Nothing about the gate depends on which factor is live — only on
        whether one is."""
        user = _enrolled(method="email")
        before = _row_state(user)

        resp, _, _ = _setup(
            client, mock_db, user, {"reauth_code": "000000"}, session=app
        )

        assert resp.status_code == 401
        assert user.two_factor_method == "email"
        assert _row_state(user) == before

    def test_a_refused_setup_mails_nothing(self, client, app, mock_db, staged_2fa_setup):
        """A refusal that still sent the code would make the endpoint an
        unauthenticated way to mail somebody."""
        user = _enrolled(method="email")

        _, store_code, send = _setup(
            client, mock_db, user, {"method": "email"}, session=app
        )

        store_code.assert_not_called()
        send.assert_not_called()

    def test_the_failure_does_not_say_which_factor_was_wrong(
        self, client, app, mock_db, staged_2fa_setup
    ):
        user = _enrolled()

        resp, _, _ = _setup(
            client, mock_db, user, {"reauth_code": "000000"}, session=app
        )

        assert resp.json()["detail"] == "Invalid code"

    def test_a_pending_token_is_not_a_way_around_it(
        self, client, mock_db, staged_2fa_setup
    ):
        """An enrolled user mid-login holds a pending token. The gate is on
        the account's state, not on how the endpoint was reached, so that
        token buys nothing here — and they can satisfy it anyway, being
        mid-login on that very factor."""
        user = _enrolled()
        before = _row_state(user)

        resp, _, _ = _setup(
            client,
            mock_db,
            user,
            {"pending_token": create_2fa_pending_token(str(user.id))},
        )

        assert resp.status_code == 401
        assert _row_state(user) == before

    def test_a_backup_code_is_accepted_as_the_proof(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """The same three forms the login path accepts, for the same reason:
        the user does not reliably know which kind they are holding."""
        codes = totp_service.generate_backup_codes()
        user = _enrolled(codes=codes)

        resp, _, _ = _setup(
            client, mock_db, user, {"reauth_code": codes[0]}, session=app
        )

        assert resp.status_code == 200

    def test_the_current_authenticator_unlocks_it(
        self, client, app, mock_db, staged_2fa_setup
    ):
        user = _enrolled()

        resp, _, _ = _setup(
            client,
            mock_db,
            user,
            {"reauth_code": pyotp.TOTP(user._secret).now()},
            session=app,
        )

        assert resp.status_code == 200
        assert resp.json()["secret"]


# ── nothing lands before confirm ────────────────────────────────────────────

class TestTheLiveRowSurvivesAnUnconfirmedSetup:
    def _start(self, client, app, mock_db, user):
        return _setup(
            client,
            mock_db,
            user,
            {"reauth_code": pyotp.TOTP(user._secret).now()},
            session=app,
        )[0]

    def test_an_accepted_setup_still_writes_nothing(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """Passing the gate earns a candidate, not a replacement."""
        user = _enrolled()
        before = _row_state(user)

        resp = self._start(client, app, mock_db, user)

        assert resp.status_code == 200
        assert _row_state(user) == before
        # The new secret exists, but only in staging.
        assert staged_2fa_setup[str(user.id)]["secret"] != user.totp_secret_encrypted

    def test_switching_method_does_not_flip_the_live_one(
        self, client, app, mock_db, staged_2fa_setup
    ):
        user = _enrolled()

        _setup(
            client,
            mock_db,
            user,
            {"method": "email", "reauth_code": pyotp.TOTP(user._secret).now()},
            session=app,
        )

        assert user.two_factor_method == "totp"
        assert staged_2fa_setup[str(user.id)]["method"] == "email"

    def test_the_OLD_authenticator_still_logs_in_after_an_abandoned_setup(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """The lockout scenario end to end: start a replacement, never
        confirm it, and the factor the user actually has must still work.
        This is the test the whole change exists for."""
        user = _enrolled()
        old_secret = user._secret

        self._start(client, app, mock_db, user)  # abandoned here

        mock_db.first.return_value = user
        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = client.post(
                "/auth/2fa/verify-login",
                json={
                    "pending_token": create_2fa_pending_token(str(user.id)),
                    "code": pyotp.TOTP(old_secret).now(),
                },
            )

        assert resp.status_code == 200
        assert resp.json()["access_token"]

    def test_the_NEW_authenticator_does_not_work_until_confirmed(
        self, client, app, mock_db, staged_2fa_setup
    ):
        """The other half of the same property: a staged secret is not a
        second live factor, it is a candidate."""
        user = _enrolled()

        new_secret = self._start(client, app, mock_db, user).json()["secret"]

        mock_db.first.return_value = user
        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = client.post(
                "/auth/2fa/verify-login",
                json={
                    "pending_token": create_2fa_pending_token(str(user.id)),
                    "code": pyotp.TOTP(new_secret).now(),
                },
            )

        assert resp.status_code == 401

    def test_confirming_DOES_promote_it(self, client, app, mock_db, staged_2fa_setup):
        """And the fix must not have broken re-enrolment itself: once the
        new authenticator proves it works, it becomes the live one."""
        user = _enrolled()
        old_encrypted = user.totp_secret_encrypted

        new_secret = self._start(client, app, mock_db, user).json()["secret"]

        mock_db.first.return_value = user
        resp = client.post(
            "/auth/2fa/confirm-setup", json={"code": pyotp.TOTP(new_secret).now()}
        )

        assert resp.status_code == 200
        assert user.totp_secret_encrypted != old_encrypted
        assert totp_service.decrypt_secret(user.totp_secret_encrypted) == new_secret
        assert user.two_factor_enabled is True
        # Spent: the candidate has been promoted and must not be confirmable
        # a second time.
        assert staged_2fa_setup == {}


# ── the common case is unchanged ────────────────────────────────────────────

class TestFirstEnrolmentIsUnaffected:
    def test_a_forced_first_login_needs_no_reauth_code(
        self, client, mock_db, staged_2fa_setup
    ):
        """Every new enrolment goes through this path, and there is no
        current factor to prove — asking for one would make the gate
        unsatisfiable rather than safe."""
        user = _unenrolled()

        resp, _, _ = _setup(
            client,
            mock_db,
            user,
            {"pending_token": create_2fa_pending_token(str(user.id))},
        )

        assert resp.status_code == 200
        assert resp.json()["provisioning_uri"].startswith("otpauth://")
        assert staged_2fa_setup[str(user.id)]["secret"] is not None

    def test_a_signed_in_user_turning_2fa_on_needs_no_reauth_code(
        self, client, app, mock_db, staged_2fa_setup
    ):
        user = _unenrolled()

        resp, _, _ = _setup(client, mock_db, user, {}, session=app)

        assert resp.status_code == 200

    def test_it_still_confirms_into_a_clean_enrolment(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _unenrolled()
        secret = _setup(
            client,
            mock_db,
            user,
            {"pending_token": create_2fa_pending_token(str(user.id))},
        )[0].json()["secret"]

        mock_db.first.return_value = user
        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": pyotp.TOTP(secret).now(),
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        assert resp.status_code == 200
        assert user.two_factor_enabled is True
        assert user.two_factor_method == "totp"
        assert totp_service.decrypt_secret(user.totp_secret_encrypted) == secret
