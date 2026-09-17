"""Disabling 2FA and replacing backup codes (§192).

Two self-service operations that WEAKEN an account, and one admin override
that bypasses their gate on purpose.

The re-auth on the self-service pair is the point of the whole file: 2FA
exists because sessions get stolen, so a valid access token alone must not
be enough to turn it off or to mint ten fresh permanent recovery codes.
Otherwise the feature protects everything except its own off switch.

The admin override deliberately has no such gate, because the situation it
exists for — authenticator gone, email inaccessible, backup codes lost — is
exactly the one where the user cannot produce any proof. A test that only
exercised it on someone who could have used self-service would miss why it
was built.
"""
import uuid
from unittest.mock import MagicMock, patch

import pyotp
import pytest

from apps.api.models.user import UserGlobalRole, UserStatus
from apps.api.services import totp_service

_NO_EMAIL_CODE = "apps.api.routers.auth.verify_2fa_email_code"


def _enrolled(secret=None, codes=None, email="u@example.com"):
    """A user with 2FA actually on.

    Every UserResponse field is filled in, not just the ones this feature
    touches: the admin endpoint returns `response_model=UserResponse`, and a
    MagicMock missing a required field fails serialisation as a 500 — which
    reads as a broken endpoint rather than a thin fixture.
    """
    from datetime import datetime, timezone

    secret = secret or totp_service.generate_totp_secret()
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.name = "Test User"
    u.first_name = "Test"
    u.last_name = "User"
    u.avatar_url = None
    u.status = UserStatus.active
    u.email_verified = True
    u.role = UserGlobalRole.superuser
    u.invite_token = None
    u.preferences = {}
    u.created_at = datetime.now(timezone.utc)
    u.storage_limit_bytes = None
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.totp_enabled = True
    u.totp_secret_encrypted = totp_service.encrypt_secret(secret)
    u.backup_codes_hashed = totp_service.hash_backup_codes(codes) if codes else None
    u._secret = secret
    return u


def _as(client, app, user):
    """Authenticate the TestClient as `user`.

    BOTH dependencies, because these endpoints do not all use the same one:
    disable and regenerate require a session (`get_current_user`), while
    send-email-fallback accepts one optionally (`get_optional_user`) so it
    can also serve the mid-login case. Overriding only the first leaves the
    fallback endpoint seeing an anonymous caller and answering 401.
    """
    from apps.api.middleware.auth import get_current_user, get_optional_user

    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_optional_user] = lambda: user


@pytest.fixture
def app():
    from apps.api.main import app as fastapi_app

    yield fastapi_app
    from apps.api.middleware.auth import get_current_user, get_optional_user

    fastapi_app.dependency_overrides.pop(get_current_user, None)
    fastapi_app.dependency_overrides.pop(get_optional_user, None)


# ── self-service disable ────────────────────────────────────────────────────

class TestSelfServiceDisable:
    def _post(self, client, app, user, code, mock_db):
        _as(client, app, user)
        mock_db.first.return_value = user
        return client.post("/auth/2fa/disable", json={"code": code})

    def test_a_correct_totp_code_disables_it(self, client, app, mock_db):
        user = _enrolled()

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, pyotp.TOTP(user._secret).now(), mock_db)

        assert resp.status_code == 200
        assert resp.json()["totp_enabled"] is False

    def test_it_clears_the_secret_and_the_codes_too_not_just_the_flag(
        self, client, app, mock_db
    ):
        """A secret left behind would be re-paired with the OLD authenticator
        by any later re-enable, and stale codes would outlive the enrolment
        they were issued for."""
        user = _enrolled(codes=totp_service.generate_backup_codes())

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            self._post(client, app, user, pyotp.TOTP(user._secret).now(), mock_db)

        assert user.totp_enabled is False
        assert user.totp_secret_encrypted is None
        assert user.backup_codes_hashed is None

    def test_a_wrong_code_is_401_and_changes_NOTHING(self, client, app, mock_db):
        """The gate, stated as an assertion: a stolen session alone cannot
        strip 2FA."""
        user = _enrolled()
        before = user.totp_secret_encrypted

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, "000000", mock_db)

        assert resp.status_code == 401
        assert user.totp_enabled is True
        assert user.totp_secret_encrypted == before

    def test_the_failure_does_not_say_which_factor_was_wrong(self, client, app, mock_db):
        user = _enrolled()

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, "000000", mock_db)

        assert resp.json()["detail"] == "Invalid code"

    def test_a_backup_code_is_accepted_as_the_proof(self, client, app, mock_db):
        codes = totp_service.generate_backup_codes()
        user = _enrolled(codes=codes)

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, codes[2], mock_db)

        assert resp.status_code == 200
        assert user.totp_enabled is False

    def test_an_emailed_fallback_code_is_accepted_as_the_proof(self, client, app, mock_db):
        user = _enrolled()

        with patch(_NO_EMAIL_CODE, return_value=(True, "")):
            resp = self._post(client, app, user, "123456", mock_db)

        assert resp.status_code == 200
        assert user.totp_enabled is False

    def test_disabling_when_already_off_is_idempotent_not_an_error(
        self, client, app, mock_db
    ):
        """A double-click should not look like a failure when the end state
        the caller asked for is already true."""
        user = _enrolled()
        user.totp_enabled = False

        resp = self._post(client, app, user, "whatever", mock_db)

        assert resp.status_code == 200
        assert resp.json()["totp_enabled"] is False

    def test_it_requires_a_session_at_all(self, client, mock_db):
        assert client.post("/auth/2fa/disable", json={"code": "123456"}).status_code in (401, 403)


# ── regenerating backup codes ───────────────────────────────────────────────

class TestRegenerateBackupCodes:
    def _post(self, client, app, user, code, mock_db):
        _as(client, app, user)
        mock_db.first.return_value = user
        return client.post("/auth/2fa/regenerate-backup-codes", json={"code": code})

    def test_it_returns_ten_fresh_codes(self, client, app, mock_db):
        user = _enrolled(codes=totp_service.generate_backup_codes())

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, pyotp.TOTP(user._secret).now(), mock_db)

        assert resp.status_code == 200
        assert len(resp.json()["backup_codes"]) == 10
        assert len(set(resp.json()["backup_codes"])) == 10

    def test_the_OLD_codes_stop_working_immediately(self, client, app, mock_db):
        """Replacement, not addition. A set that may have been seen by
        someone else is not made safer by being extended."""
        old_codes = totp_service.generate_backup_codes()
        user = _enrolled(codes=old_codes)

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            self._post(client, app, user, pyotp.TOTP(user._secret).now(), mock_db)

        matched, _ = totp_service.consume_backup_code(user.backup_codes_hashed, old_codes[0])
        assert matched is False

    def test_the_NEW_codes_work(self, client, app, mock_db):
        user = _enrolled(codes=totp_service.generate_backup_codes())

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            new_codes = self._post(
                client, app, user, pyotp.TOTP(user._secret).now(), mock_db
            ).json()["backup_codes"]

        matched, _ = totp_service.consume_backup_code(user.backup_codes_hashed, new_codes[0])
        assert matched is True

    def test_they_are_stored_hashed(self, client, app, mock_db):
        user = _enrolled(codes=totp_service.generate_backup_codes())

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            returned = self._post(
                client, app, user, pyotp.TOTP(user._secret).now(), mock_db
            ).json()["backup_codes"]

        stored = str(user.backup_codes_hashed)
        assert all(c not in stored for c in returned)

    def test_a_wrong_code_leaves_the_EXISTING_set_untouched(self, client, app, mock_db):
        """A bad guess must not be a denial of service against the codes the
        user still has written down."""
        old_codes = totp_service.generate_backup_codes()
        user = _enrolled(codes=old_codes)
        before = list(user.backup_codes_hashed)

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._post(client, app, user, "000000", mock_db)

        assert resp.status_code == 401
        assert user.backup_codes_hashed == before
        assert totp_service.consume_backup_code(user.backup_codes_hashed, old_codes[0])[0]

    def test_regenerating_without_2fa_enabled_is_a_400(self, client, app, mock_db):
        user = _enrolled()
        user.totp_enabled = False

        resp = self._post(client, app, user, "123456", mock_db)

        assert resp.status_code == 400

    def test_it_requires_a_session(self, client, mock_db):
        resp = client.post("/auth/2fa/regenerate-backup-codes", json={"code": "1"})
        assert resp.status_code in (401, 403)


# ── the admin override ──────────────────────────────────────────────────────

class TestAdminOverride:
    def _admin(self):
        a = MagicMock()
        a.id = uuid.uuid4()
        a.email = "admin@example.com"
        a.role = UserGlobalRole.superadmin
        a.status = UserStatus.active
        a.deleted_at = None
        return a

    def _patch(self, client, app, actor, target, mock_db):
        _as(client, app, actor)
        mock_db.query.return_value.filter.return_value.first.return_value = target
        return client.patch(f"/admin/users/{target.id}/disable-2fa")

    def test_it_works_on_a_user_with_NO_working_factors_left(self, client, app, mock_db):
        """The scenario this endpoint exists for, and the only one that
        proves it. Authenticator gone, email inaccessible, backup codes
        lost — self-service is impossible by definition, so no code is
        asked for and none could be given."""
        target = _enrolled()
        target.backup_codes_hashed = None  # all spent or lost

        with patch(_NO_EMAIL_CODE, return_value=(False, "")):
            resp = self._patch(client, app, self._admin(), target, mock_db)

        assert resp.status_code == 200
        assert target.totp_enabled is False
        assert target.totp_secret_encrypted is None

    def test_no_code_is_required_from_the_target(self, client, app, mock_db):
        target = _enrolled()

        resp = self._patch(client, app, self._admin(), target, mock_db)

        # No body at all was sent.
        assert resp.status_code == 200

    def test_it_clears_all_three_fields(self, client, app, mock_db):
        target = _enrolled(codes=totp_service.generate_backup_codes())

        self._patch(client, app, self._admin(), target, mock_db)

        assert target.totp_enabled is False
        assert target.totp_secret_encrypted is None
        assert target.backup_codes_hashed is None

    def test_a_non_superadmin_gets_403(self, client, app, mock_db):
        actor = self._admin()
        actor.role = UserGlobalRole.superuser

        resp = self._patch(client, app, actor, _enrolled(), mock_db)

        assert resp.status_code == 403

    def test_a_superadmin_cannot_use_it_on_THEMSELVES(self, client, app, mock_db):
        """Without this, a stolen superadmin session could strip that
        superadmin's own 2FA with no code, and the re-auth on the
        self-service path would be a formality the highest-privileged
        accounts could always walk around."""
        admin = self._admin()
        admin.totp_enabled = True
        _as(client, app, admin)
        mock_db.query.return_value.filter.return_value.first.return_value = admin

        resp = client.patch(f"/admin/users/{admin.id}/disable-2fa")

        assert resp.status_code == 400
        assert admin.totp_enabled is True

    def test_an_unknown_user_is_a_404(self, client, app, mock_db):
        _as(client, app, self._admin())
        mock_db.query.return_value.filter.return_value.first.return_value = None

        resp = client.patch(f"/admin/users/{uuid.uuid4()}/disable-2fa")

        assert resp.status_code == 404

    def test_it_is_written_to_the_activity_log(self, client, app, mock_db):
        """An unlogged way to remove someone else's second factor is
        indistinguishable, after the fact, from an attacker having done it."""
        from apps.api.models.activity import ActivityLog

        added = []
        mock_db.add.side_effect = added.append
        target = _enrolled(email="victim@example.com")
        admin = self._admin()

        self._patch(client, app, admin, target, mock_db)

        logs = [a for a in added if isinstance(a, ActivityLog)]
        assert len(logs) == 1
        entry = logs[0]
        assert entry.action == "admin_disabled_2fa"
        # The ACTOR, per the column's own comment — who did it, not who it
        # was done to. The target is in the payload.
        assert entry.user_id == admin.id
        assert entry.payload["target_user_id"] == str(target.id)
        assert entry.payload["target_email"] == "victim@example.com"
        assert entry.payload["was_enabled"] is True

    def test_the_log_records_when_there_was_nothing_to_disable(self, client, app, mock_db):
        """Distinguishes 'an admin removed a live second factor' from 'an
        admin clicked it on an account that had none'."""
        from apps.api.models.activity import ActivityLog

        added = []
        mock_db.add.side_effect = added.append
        target = _enrolled()
        target.totp_enabled = False

        self._patch(client, app, self._admin(), target, mock_db)

        entry = [a for a in added if isinstance(a, ActivityLog)][0]
        assert entry.payload["was_enabled"] is False


# ── the email fallback is obtainable in BOTH contexts ───────────────────────

class TestEmailFallbackReachableWhenAuthenticated:
    def test_an_authenticated_user_can_request_one_without_a_pending_token(
        self, client, app, mock_db
    ):
        """§192's self-service paths accept an emailed code as proof, and an
        authenticated user has no pending token. Without this the proof
        would be listed as acceptable and impossible to obtain."""
        user = _enrolled()
        _as(client, app, user)
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.store_2fa_email_code") as store, \
             patch("apps.api.routers.auth.send_task_safe"):
            resp = client.post("/auth/2fa/send-email-fallback", json={})

        assert resp.status_code == 200
        store.assert_called_once()

    def test_the_pending_token_path_still_works_unchanged(self, client, mock_db):
        """§191's mid-login case must not have been traded away for the new
        one."""
        from apps.api.services.auth_service import create_2fa_pending_token

        user = _enrolled()
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.store_2fa_email_code") as store, \
             patch("apps.api.routers.auth.send_task_safe"):
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(user.id))},
            )

        assert resp.status_code == 200
        store.assert_called_once()

    def test_neither_a_session_nor_a_token_is_still_a_401(self, client, mock_db):
        resp = client.post("/auth/2fa/send-email-fallback", json={})
        assert resp.status_code == 401

    def test_verification_was_ALREADY_keyed_by_email_not_by_token(self):
        """The asymmetry that made this worth tracing: the verify half
        needed no change because it looks the code up by address, while the
        send half was gated behind a token an authenticated caller does not
        have."""
        import inspect

        from apps.api.services import redis_service as rs

        src = inspect.getsource(rs.verify_2fa_email_code)
        assert "email.lower()" in src
        assert "token" not in src
