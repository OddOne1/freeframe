"""Changing what a session is entitled to actually ends that session (§199).

Access and refresh tokens carried only `sub`, `type` and `exp`, and
/auth/refresh re-minted a pair after checking nothing beyond "this user
exists and is not deactivated". Deactivation therefore worked — both
get_current_user and /auth/refresh re-read `status` on every call, and that
half is NOT what this change touches. Everything short of it did not:
turning 2FA off and on, having an admin reset it, regenerating backup codes
or changing a password all left every open session alive and renewing itself
for the whole refresh window. A stolen laptop survived all of them.

`token_version` is the missing primitive. Two properties matter most and are
tested first:

  * a token with NO `tv` claim counts as version 0, so the deploy that adds
    this column throws nobody out; and
  * the session that PERFORMS one of these actions keeps working, using the
    replacement pair handed back in the same response — otherwise "change my
    password" would sign you out of the device you changed it on, which is
    worse than the behaviour being fixed.
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pyotp
import pytest
from jose import jwt

from apps.api.config import settings
from apps.api.middleware.auth import get_current_user, get_optional_user
from apps.api.models.user import UserGlobalRole, UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import (
    create_access_token,
    create_refresh_token,
    decode_token,
)

_VERIFY_EMAIL_CODE = "apps.api.routers.auth.verify_2fa_email_code"


def _user(*, version=0, enrolled=False, secret=None, codes=None):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = "u@example.com"
    u.status = UserStatus.active
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.email_verified = True
    u.first_name = "Test"
    u.last_name = "User"
    u.avatar_url = None
    u.role = UserGlobalRole.superuser
    u.invite_token = None
    u.preferences = {}
    u.created_at = datetime.now(timezone.utc)
    u.storage_limit_bytes = None
    u.two_factor_enabled = enrolled
    u.two_factor_method = "totp" if enrolled else None
    u.totp_secret_encrypted = totp_service.encrypt_secret(secret) if secret else None
    u.backup_codes_hashed = totp_service.hash_backup_codes(codes) if codes else None
    u.token_version = version
    # `name` is MagicMock's OWN constructor kwarg, so plain assignment sets
    # the mock's repr rather than the attribute — which is why UserResponse
    # 500s on a mock user (test_auth.py::test_get_me, failing at HEAD for
    # this reason). configure_mock is the way to set it.
    u.configure_mock(name="Test User")
    return u


#: The probe for "is this token accepted". Deliberately NOT /auth/me: this
#: suite's users are MagicMocks, and serialising one through UserResponse
#: 500s regardless of auth (test_auth.py::test_get_me fails at HEAD for that
#: reason alone). GET /projects is gated on the same get_current_user and
#: returns [] against the mock session, so a 200 here means the token was
#: accepted and nothing else.
PROTECTED = "/projects"


def _bearer(user, *, version=None):
    v = user.token_version if version is None else version
    return {"Authorization": f"Bearer {create_access_token(str(user.id), v)}"}


def _legacy_token(user_id, kind="access"):
    """A token minted before the `tv` claim existed — the shape every live
    session holds at the moment this ships."""
    return jwt.encode(
        {
            "sub": str(user_id),
            "type": kind,
            "exp": datetime.now(timezone.utc) + timedelta(days=1),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


# ── the deploy property ─────────────────────────────────────────────────────


class TestNobodyIsLoggedOutByTheDeploy:
    def test_a_token_with_no_tv_claim_authenticates_at_version_zero(
        self, client, mock_db
    ):
        """Constructed directly rather than obtained from a login, because a
        fresh login cannot produce this shape any more — and this shape is
        exactly what every session alive at deploy time is holding."""
        user = _user(version=0)
        mock_db.first.return_value = user

        resp = client.get(
            PROTECTED,
            headers={"Authorization": f"Bearer {_legacy_token(user.id)}"},
        )

        assert resp.status_code == 200

    def test_a_legacy_refresh_token_still_refreshes(self, client, mock_db):
        user = _user(version=0)
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/refresh",
            json={"refresh_token": _legacy_token(user.id, "refresh")},
        )

        assert resp.status_code == 200

    def test_a_legacy_token_stops_working_once_the_version_moves(
        self, client, mock_db
    ):
        """The flip side, and the point of the whole change: "counts as 0"
        is a starting position, not an exemption."""
        user = _user(version=1)
        mock_db.first.return_value = user

        resp = client.get(
            PROTECTED,
            headers={"Authorization": f"Bearer {_legacy_token(user.id)}"},
        )

        assert resp.status_code == 401

    def test_a_fresh_token_carries_the_claim(self):
        assert decode_token(create_access_token("abc", 7))["tv"] == 7
        assert decode_token(create_refresh_token("abc", 7))["tv"] == 7


# ── the gate itself ─────────────────────────────────────────────────────────


class TestAStaleTokenIsRefused:
    def test_a_protected_route_rejects_it(self, client, mock_db):
        user = _user(version=3)
        mock_db.first.return_value = user

        resp = client.get(PROTECTED, headers=_bearer(user, version=2))

        assert resp.status_code == 401

    def test_refresh_rejects_it(self, client, mock_db):
        user = _user(version=3)
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/refresh",
            json={"refresh_token": create_refresh_token(str(user.id), 2)},
        )

        assert resp.status_code == 401

    def test_refresh_does_not_re_run_the_login_gate_on_a_mismatch(
        self, client, mock_db
    ):
        """A `tv` mismatch is a flat rejection and nothing else.

        Re-running _login_outcome here would put a second copy of the 2FA
        branch inside refresh — exactly the duplication §193 removed from the
        login paths and §196/§198 then had to remove again on the client.
        The bump ends the session; /auth/login re-establishes one, and stays
        the only place that decides what a login requires.
        """
        user = _user(version=3, enrolled=True)
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth._login_outcome") as outcome:
            resp = client.post(
                "/auth/refresh",
                json={"refresh_token": create_refresh_token(str(user.id), 2)},
            )

        assert resp.status_code == 401
        outcome.assert_not_called()

    def test_a_matching_token_is_accepted(self, client, mock_db):
        user = _user(version=3)
        mock_db.first.return_value = user

        assert client.get(PROTECTED, headers=_bearer(user)).status_code == 200

    def test_the_optional_user_dependency_reads_a_stale_token_as_no_session(
        self, client, mock_db
    ):
        """get_optional_user backs endpoints that work with or without a
        session, so a stale token means "anonymous", not an error. What it
        must NOT do is keep treating the holder as signed in."""
        user = _user(version=3)
        mock_db.first.return_value = user

        from apps.api.middleware.auth import get_optional_user as dep

        resolved = dep(
            credentials=MagicMock(credentials=create_access_token(str(user.id), 2)),
            db=mock_db,
        )
        assert resolved is None

    def test_deactivation_still_ends_a_session_on_its_own(self, client, mock_db):
        """Already correct before this change, and pinned so the new check
        cannot accidentally become the ONLY check."""
        user = _user(version=3)
        user.status = UserStatus.deactivated
        mock_db.first.return_value = user

        assert client.get(PROTECTED, headers=_bearer(user)).status_code == 401


# ── each bump point ─────────────────────────────────────────────────────────


@pytest.fixture
def as_user(client, mock_db):
    """Sign a mock user in through the dependency, the way the 2FA suites do,
    and yield a helper that asserts the round trip afterwards."""
    from apps.api.main import app

    def _install(user):
        mock_db.first.return_value = user
        app.dependency_overrides[get_current_user] = lambda: user
        app.dependency_overrides[get_optional_user] = lambda: user
        return user

    yield _install
    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)


def _drop_overrides():
    """The `as_user` fixture signs the caller in by OVERRIDING
    get_current_user, which is how the 2FA suites do it — but an override
    bypasses the very check these assertions are about. Removed before any
    token is actually probed."""
    from apps.api.main import app

    app.dependency_overrides.pop(get_current_user, None)
    app.dependency_overrides.pop(get_optional_user, None)


def _old_tokens_are_dead(client, mock_db, user, before):
    """The whole promise, asserted the same way at every bump point: the
    tokens that existed BEFORE the action no longer work anywhere."""
    _drop_overrides()
    mock_db.first.return_value = user
    assert client.get(
        PROTECTED, headers={"Authorization": f"Bearer {before['access']}"}
    ).status_code == 401
    assert client.post(
        "/auth/refresh", json={"refresh_token": before["refresh"]}
    ).status_code == 401


def _snapshot(user):
    v = user.token_version
    return {
        "access": create_access_token(str(user.id), v),
        "refresh": create_refresh_token(str(user.id), v),
    }


def _new_tokens_work(client, mock_db, user, tokens):
    """And the acting session's replacement pair does work — as an actual
    round trip, not merely a check that the field is present."""
    _drop_overrides()
    mock_db.first.return_value = user
    assert client.get(
        PROTECTED, headers={"Authorization": f"Bearer {tokens['access_token']}"}
    ).status_code == 200
    assert client.post(
        "/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    ).status_code == 200


class TestEnablingTwoFactorEndsOtherSessions:
    def test_confirm_setup_bumps_and_hands_back_a_working_pair(
        self, client, mock_db, as_user, staged_2fa_setup
    ):
        secret = totp_service.generate_totp_secret()
        user = as_user(_user(version=0))
        before = _snapshot(user)
        staged_2fa_setup[str(user.id)] = {
            "method": "totp",
            "secret": totp_service.encrypt_secret(secret),
        }

        resp = client.post(
            "/auth/2fa/confirm-setup", json={"code": pyotp.TOTP(secret).now()}
        )

        assert resp.status_code == 200
        assert user.token_version == 1
        _old_tokens_are_dead(client, mock_db, user, before)
        _new_tokens_work(client, mock_db, user, resp.json()["tokens"])

    def test_the_forced_first_login_branch_still_returns_tokens(
        self, client, mock_db, staged_2fa_setup
    ):
        """This branch always populated `tokens`; the bump must not have
        changed that, only made the other branch match it."""
        from apps.api.services.auth_service import create_2fa_pending_token

        secret = totp_service.generate_totp_secret()
        user = _user(version=0)
        mock_db.first.return_value = user
        staged_2fa_setup[str(user.id)] = {
            "method": "totp",
            "secret": totp_service.encrypt_secret(secret),
        }

        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": pyotp.TOTP(secret).now(),
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        assert resp.status_code == 200
        assert resp.json()["tokens"]["access_token"]
        assert decode_token(resp.json()["tokens"]["access_token"])["tv"] == 1


class TestDisablingTwoFactorEndsOtherSessions:
    def test_it_bumps_and_hands_back_a_working_pair(self, client, mock_db, as_user):
        secret = totp_service.generate_totp_secret()
        user = as_user(_user(version=0, enrolled=True, secret=secret))
        before = _snapshot(user)

        resp = client.post(
            "/auth/2fa/disable", json={"code": pyotp.TOTP(secret).now()}
        )

        assert resp.status_code == 200
        assert user.token_version == 1
        _old_tokens_are_dead(client, mock_db, user, before)
        _new_tokens_work(client, mock_db, user, resp.json()["tokens"])

    def test_the_idempotent_no_op_does_not_bump(self, client, mock_db, as_user):
        """Disable on an account with no 2FA returns early and changes
        nothing — so it must not throw out that user's sessions either."""
        user = as_user(_user(version=4, enrolled=False))

        resp = client.post("/auth/2fa/disable", json={"code": "000000"})

        assert resp.status_code == 200
        assert user.token_version == 4

    def test_a_wrong_code_does_not_bump(self, client, mock_db, as_user):
        user = as_user(_user(version=4, enrolled=True, secret=totp_service.generate_totp_secret()))

        with patch(_VERIFY_EMAIL_CODE, return_value=(False, "Invalid code")):
            resp = client.post("/auth/2fa/disable", json={"code": "000000"})

        assert resp.status_code == 401
        assert user.token_version == 4


class TestRegeneratingBackupCodesEndsOtherSessions:
    def test_it_bumps_and_hands_back_a_working_pair(self, client, mock_db, as_user):
        secret = totp_service.generate_totp_secret()
        user = as_user(_user(version=0, enrolled=True, secret=secret))
        before = _snapshot(user)

        resp = client.post(
            "/auth/2fa/regenerate-backup-codes",
            json={"code": pyotp.TOTP(secret).now()},
        )

        assert resp.status_code == 200
        assert user.token_version == 1
        _old_tokens_are_dead(client, mock_db, user, before)
        _new_tokens_work(client, mock_db, user, resp.json()["tokens"])

    def test_a_wrong_code_does_not_bump(self, client, mock_db, as_user):
        user = as_user(
            _user(version=4, enrolled=True, secret=totp_service.generate_totp_secret())
        )

        with patch(_VERIFY_EMAIL_CODE, return_value=(False, "Invalid code")):
            resp = client.post(
                "/auth/2fa/regenerate-backup-codes", json={"code": "000000"}
            )

        assert resp.status_code == 401
        assert user.token_version == 4


class TestSettingAPasswordEndsOtherSessions:
    def test_it_bumps_and_returns_tokens_at_the_top_level(
        self, client, mock_db, as_user
    ):
        user = as_user(_user(version=0))
        before = _snapshot(user)

        resp = client.post("/auth/set-password", json={"password": "hunter2hunter2"})

        assert resp.status_code == 200
        assert user.token_version == 1
        body = resp.json()
        # Where login-form.tsx's set-password step has always looked for
        # them — see SetPasswordResponse.
        assert body["access_token"] and body["refresh_token"]
        # And it is still a UserResponse in every other respect.
        assert body["email"] == user.email
        _old_tokens_are_dead(client, mock_db, user, before)
        _new_tokens_work(client, mock_db, user, body)

    def test_accept_invite_returns_tokens_that_match_the_row(self, client, mock_db):
        """No prior session exists here, so the bump is consistency rather
        than necessity — but the pair it hands back still has to be valid."""
        user = _user(version=0)
        user.status = UserStatus.pending_invite
        user.invite_token = "tok"
        user.invite_token_expires_at = None
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/accept-invite", json={"token": "tok", "password": "hunter2hunter2"}
        )

        assert resp.status_code == 200
        assert user.token_version == 1
        assert decode_token(resp.json()["access_token"])["tv"] == 1


class TestAnAdminResetEndsTheTargetsSessions:
    def test_the_targets_tokens_die_and_the_admins_do_not(self, client, mock_db):
        from apps.api.main import app

        admin = _user(version=0)
        admin.role = UserGlobalRole.superadmin
        target = _user(version=0, enrolled=True)
        target.id = uuid.uuid4()
        target_before = _snapshot(target)
        admin_before = _snapshot(admin)

        mock_db.first.return_value = target
        app.dependency_overrides[get_current_user] = lambda: admin
        try:
            resp = client.patch(f"/admin/users/{target.id}/disable-2fa")
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert target.token_version == 1
        # The admin never touched their own version — an admin who resets
        # someone else's 2FA should not be signed out for it.
        assert admin.token_version == 0

        mock_db.first.return_value = target
        assert client.get(
            PROTECTED,
            headers={"Authorization": f"Bearer {target_before['access']}"},
        ).status_code == 401

        mock_db.first.return_value = admin
        assert client.get(
            PROTECTED,
            headers={"Authorization": f"Bearer {admin_before['access']}"},
        ).status_code == 200


class TestALoginStillWorksEndToEnd:
    def test_a_plain_login_mints_tokens_at_the_rows_version(self, client, mock_db):
        """The bumps are worthless if the next login hands out a stale pair.
        A user whose version has moved signs in and gets tokens at the NEW
        version, not at 0."""
        user = _user(version=5)
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch("apps.api.routers.auth.require_2fa_enabled", return_value=False):
            resp = client.post(
                "/auth/login",
                json={"email": user.email, "password": "hunter2hunter2"},
            )

        assert decode_token(resp.json()["access_token"])["tv"] == 5
        assert client.get(PROTECTED, headers=_bearer(user)).status_code == 200

    def test_completing_a_2fa_login_does_the_same(self, client, mock_db):
        from apps.api.services.auth_service import create_2fa_pending_token

        secret = totp_service.generate_totp_secret()
        user = _user(version=5, enrolled=True, secret=secret)
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/verify-login",
            json={
                "pending_token": create_2fa_pending_token(str(user.id)),
                "code": pyotp.TOTP(secret).now(),
            },
        )

        assert decode_token(resp.json()["access_token"])["tv"] == 5

    def test_a_refresh_rotates_the_pair_at_the_same_version(self, client, mock_db):
        user = _user(version=5)
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/refresh",
            json={"refresh_token": create_refresh_token(str(user.id), 5)},
        )

        assert resp.status_code == 200
        assert decode_token(resp.json()["access_token"])["tv"] == 5


class TestThePendingTokenIsDeliberatelyLeftAlone:
    """No `tv` on the 2fa_pending token, and that is a decision, not an
    omission.

    It lives ten minutes, is minted only by a primary-credential check that
    just succeeded, and `get_current_user` refuses any token whose type is
    not exactly "access" — so it cannot reach a single authenticated
    endpoint. The only things it can do are complete or enrol the very login
    that created it. For it to outlive a bump at all, that bump would have
    to happen inside those ten minutes, from another session, mid-login; and
    the login it then completes ends with _issue_tokens reading the CURRENT
    row, so the pair it produces is correct regardless.
    """

    def test_it_carries_no_version_claim(self):
        from apps.api.services.auth_service import create_2fa_pending_token

        assert "tv" not in decode_token(create_2fa_pending_token(str(uuid.uuid4())))

    def test_it_still_cannot_reach_an_authenticated_endpoint(self, client, mock_db):
        from apps.api.services.auth_service import create_2fa_pending_token

        user = _user(version=0)
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id))

        resp = client.get(PROTECTED, headers={"Authorization": f"Bearer {pending}"})

        assert resp.status_code == 401

    def test_a_login_completed_with_it_gets_the_rows_current_version(
        self, client, mock_db
    ):
        """The case the reasoning above turns on: the bump happened after
        the pending token was minted, and the resulting session is still
        correct because _issue_tokens reads the row, not the token."""
        from apps.api.services.auth_service import create_2fa_pending_token

        secret = totp_service.generate_totp_secret()
        user = _user(version=0, enrolled=True, secret=secret)
        mock_db.first.return_value = user
        pending = create_2fa_pending_token(str(user.id))

        user.token_version = 9  # something else bumped it mid-login

        resp = client.post(
            "/auth/2fa/verify-login",
            json={"pending_token": pending, "code": pyotp.TOTP(secret).now()},
        )

        assert resp.status_code == 200
        assert decode_token(resp.json()["access_token"])["tv"] == 9
        assert client.get(PROTECTED, headers=_bearer(user)).status_code == 200
