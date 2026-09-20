"""A magic code is a primary credential, not a second factor (§193).

§191 gated /auth/login and left /auth/verify-magic-code alone, reasoning it
was "a separate feature". It is not — it is the other half of the same login
screen ("email + code" by default, "sign in with password instead" as the
fallback link), and it returned full tokens the moment the Redis code
checked out. An enrolled user was therefore fully authenticated by anyone
who could read one email, which defeats 2FA against precisely the threat it
is usually deployed for: a compromised inbox.

The first test in this file is the one that matters. The second-most
important is the one directly after it — every existing user is on the
unchanged path right now.
"""
import inspect
import uuid
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserStatus
from apps.api.services import totp_service

_REDIS_OK = "apps.api.routers.auth.redis_verify_magic_code"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"


def _user(*, two_factor_enabled=False, password_hash="$2b$12$fake", email="u@example.com"):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.status = UserStatus.active
    u.deleted_at = None
    u.password_hash = password_hash
    u.email_verified = False
    u.two_factor_enabled = two_factor_enabled
    u.totp_secret_encrypted = (
        totp_service.encrypt_secret(totp_service.generate_totp_secret())
        if two_factor_enabled
        else None
    )
    u.backup_codes_hashed = None
    # §199 — explicit for the same reason as the 2FA fields: every
    # MagicMock attribute is truthy, and a mock one here lands inside a
    # JWT payload, which cannot serialise it.
    u.token_version = 0
    # §194 — explicit for the same reason as the fields above: validated
    # against Literal["totp", "email"] on the way out, so a MagicMock
    # attribute would fail serialisation.
    u.two_factor_method = "totp" if two_factor_enabled else None
    return u


def _verify(client, mock_db, user, *, require_2fa=False):
    mock_db.first.return_value = user
    with patch(_REDIS_OK, return_value=(True, "")), \
         patch(_REQUIRE_2FA, return_value=require_2fa):
        return client.post(
            "/auth/verify-magic-code",
            json={"email": user.email, "code": "123456"},
        )


# ── the bypass, closed ──────────────────────────────────────────────────────

class TestTheBypass:
    def test_an_enrolled_user_does_NOT_get_tokens_from_a_magic_code(
        self, client, mock_db
    ):
        """The regression this whole change exists for. Anyone holding the
        email must still be stopped at the second factor."""
        resp = _verify(client, mock_db, _user(two_factor_enabled=True))

        body = resp.json()
        assert resp.status_code == 200
        assert body["requires_2fa"] is True
        assert body["setup_required"] is False
        assert body["pending_token"]
        # Absent, not null — same property /auth/login's union has.
        assert "access_token" not in body
        assert "refresh_token" not in body

    def test_reading_the_email_alone_no_longer_authenticates(self, client, mock_db):
        """Stated as the threat rather than the mechanism: a correct code,
        correctly verified, and still no session."""
        resp = _verify(client, mock_db, _user(two_factor_enabled=True))

        assert "access_token" not in resp.json()

    def test_enforcement_on_routes_an_unenrolled_user_into_setup(self, client, mock_db):
        resp = _verify(client, mock_db, _user(two_factor_enabled=False), require_2fa=True)

        body = resp.json()
        assert body["requires_2fa"] is True
        assert body["setup_required"] is True
        assert "access_token" not in body

    def test_an_enrolled_user_is_gated_even_when_the_site_setting_is_off(
        self, client, mock_db
    ):
        """Turning the instance-wide requirement off must not silently
        downgrade someone who chose 2FA for themselves."""
        resp = _verify(client, mock_db, _user(two_factor_enabled=True), require_2fa=False)

        assert resp.json()["requires_2fa"] is True


# ── the path every existing user is on ──────────────────────────────────────

class TestNothingElseChanged:
    def test_an_unenrolled_user_with_enforcement_off_still_gets_tokens(
        self, client, mock_db
    ):
        """Today's behaviour, unchanged. This is the path every existing
        user is on right now."""
        resp = _verify(client, mock_db, _user())

        body = resp.json()
        assert resp.status_code == 200
        assert body["access_token"] and body["refresh_token"]
        assert body["requires_2fa"] is False

    def test_a_wrong_code_is_still_a_401_before_any_2fa_question(self, client, mock_db):
        mock_db.first.return_value = _user(two_factor_enabled=True)
        with patch(_REDIS_OK, return_value=(False, "Invalid code")):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": "u@example.com", "code": "000000"},
            )

        assert resp.status_code == 401
        assert "pending_token" not in resp.json()

    def test_an_unknown_email_is_still_a_404(self, client, mock_db):
        mock_db.first.return_value = None
        resp = client.post(
            "/auth/verify-magic-code", json={"email": "no@example.com", "code": "1"}
        )
        assert resp.status_code == 404

    def test_a_deactivated_account_is_still_refused(self, client, mock_db):
        user = _user(two_factor_enabled=True)
        user.status = UserStatus.deactivated
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/verify-magic-code", json={"email": user.email, "code": "1"}
        )

        assert resp.status_code == 401

    def test_the_email_is_still_marked_verified_even_when_2fa_stops_the_login(
        self, client, mock_db
    ):
        """The code WAS correct, so the address is genuinely verified. That
        is a fact about the address, not a grant of access, and it must not
        be rolled back just because the login stops here."""
        user = _user(two_factor_enabled=True)

        _verify(client, mock_db, user)

        assert user.email_verified is True
        mock_db.commit.assert_called()

    def test_a_pending_verification_account_is_still_activated(self, client, mock_db):
        """Same reasoning. The activation side effect predates 2FA and is
        about the address being real."""
        user = _user(two_factor_enabled=True)
        user.status = UserStatus.pending_verification

        _verify(client, mock_db, user)

        assert user.status == UserStatus.active


# ── needs_password: the ordering question ───────────────────────────────────

class TestNeedsPasswordIsDeferred:
    """Traced, not assumed. The concern: could someone with only email
    access be asked to CREATE a password before proving a second factor?

    It resolves correctly, but for two specific reasons rather than by
    accident, and both are pinned here:

      1. `needs_password` is a field of TokenResponse only, and
         _login_outcome produces one only once the factor is settled. The
         pending arm has no such field to carry the instruction.
      2. /auth/set-password is gated on get_current_user, which rejects any
         token whose type is not "access" — so a pending token cannot reach
         it even if a client invented the step itself.
    """

    def test_a_passwordless_ENROLLED_user_is_not_told_to_set_a_password(
        self, client, mock_db
    ):
        user = _user(two_factor_enabled=True, password_hash=None)

        body = _verify(client, mock_db, user).json()

        assert body["requires_2fa"] is True
        assert "needs_password" not in body

    def test_a_passwordless_unenrolled_user_is_told_immediately_as_before(
        self, client, mock_db
    ):
        user = _user(two_factor_enabled=False, password_hash=None)

        body = _verify(client, mock_db, user).json()

        assert body["needs_password"] is True
        assert body["access_token"]

    def test_the_answer_survives_to_the_far_side_of_the_2fa_gate(self, client, mock_db):
        """Deferred, not dropped: once the factor clears, the user is still
        correctly told to set a password."""
        import pyotp

        secret = totp_service.generate_totp_secret()
        user = _user(two_factor_enabled=True, password_hash=None)
        user.totp_secret_encrypted = totp_service.encrypt_secret(secret)
        pending = _verify(client, mock_db, user).json()["pending_token"]

        mock_db.first.return_value = user
        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(False, "")):
            done = client.post(
                "/auth/2fa/verify-login",
                json={"pending_token": pending, "code": pyotp.TOTP(secret).now()},
            ).json()

        assert done["needs_password"] is True
        assert done["access_token"]

    def test_set_password_cannot_be_reached_with_a_pending_token(self, client, mock_db):
        """Reason 2, asserted directly rather than reasoned about."""
        from apps.api.services.auth_service import create_2fa_pending_token

        resp = client.post(
            "/auth/set-password",
            json={"password": "hunter2hunter2"},
            headers={"Authorization": f"Bearer {create_2fa_pending_token(str(uuid.uuid4()))}"},
        )

        assert resp.status_code == 401


# ── one implementation, not two that agree today ────────────────────────────

class TestTheBranchIsActuallyShared:
    def test_both_login_paths_call_the_same_helper(self):
        """§190 found the same rule written four separate times, each wrong
        the same way. A second copy HERE would be worse than wrong output:
        it would be a login path that silently stops asking for a factor."""
        from apps.api.routers import auth as auth_router

        for fn in (auth_router.login, auth_router.verify_magic_code):
            body = inspect.getsource(fn)
            code = "\n".join(
                l for l in body.split("\n") if not l.strip().startswith("#")
            )
            # Prefix match, not the exact call: §199 gave _login_outcome a
            # keyword-only `via`, and verify_magic_code passes it. What this
            # asserts is unchanged — both paths delegate to the one helper.
            assert "_login_outcome(db, user" in code, fn.__name__

    def test_neither_builds_the_branch_itself(self):
        """The check above would still pass if one of them ALSO had its own
        copy sitting beside the call."""
        from apps.api.routers import auth as auth_router

        for fn in (auth_router.login, auth_router.verify_magic_code):
            code = "\n".join(
                l for l in inspect.getsource(fn).split("\n")
                if not l.strip().startswith("#")
            )
            assert "TwoFactorRequiredResponse(" not in code, fn.__name__
            assert "create_2fa_pending_token(" not in code, fn.__name__

    def test_the_helper_is_the_only_place_the_branch_lives(self):
        from apps.api.routers import auth as auth_router

        src = inspect.getsource(auth_router._login_outcome)
        assert "user.two_factor_enabled" in src
        assert "require_2fa_enabled(db)" in src

    def test_both_endpoints_declare_the_same_response_model(self):
        """§194 is written against one union, not two shapes that happen to
        look alike."""
        from apps.api.main import app

        models = {
            r.path: r.response_model
            for r in app.routes
            if getattr(r, "path", None) in ("/auth/login", "/auth/verify-magic-code")
        }
        assert models["/auth/login"] == models["/auth/verify-magic-code"]
