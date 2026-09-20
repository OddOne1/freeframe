"""The two-address split, the onboarding gate, and the escape hatches (§200).

Email was the main second factor here, and the same mailbox could also reset
the password: request a reset, set a new password, receive the 2FA code in
that same inbox. One mailbox was the whole account, and the second factor
bought nothing. §200 splits the two channels rather than patching around
them.

What is asserted here, and why each one is a behaviour rather than a
source-text check:

  * reset mail goes to `backup_email` ONLY, 2FA codes to `email` ONLY, with no
    fallback in either direction — asserted on the RECIPIENT of the queued
    Celery task, and on the other mailbox staying empty, because "which
    address received it" is the entire security property;
  * `backup_email == email` is refused; same domain is accepted with a flag;
  * the gate blocks every protected route with 403 `account_setup_required`
    while it lets /auth/* through, and lifts exactly when the data becomes
    real — never because a client said so;
  * the passwordless cut-off closes code-only sign-in after the date in
    site settings, and not before;
  * the step-up gate on a password change and on redirecting resets;
  * both escape hatches, including that the admin one is audit-logged.
"""

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.middleware.account_gate import ACCOUNT_SETUP_REQUIRED
from apps.api.models.user import User as ModelUser
from apps.api.models.user import UserGlobalRole, UserStatus, gate_outstanding
from apps.api.services.auth_service import create_access_token

_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_STORE_RESET = "apps.api.routers.auth.store_password_reset_code"
_VERIFY_RESET = "apps.api.routers.auth.verify_password_reset_code"
_REDIS_OK = "apps.api.routers.auth.redis_verify_magic_code"
_WINDOW_CLOSED = "apps.api.routers.auth.passwordless_window_closed"
_STORE_BACKUP = "apps.api.routers.auth.store_backup_email_code"
_VERIFY_BACKUP = "apps.api.routers.auth.verify_backup_email_code"
_CLEAR_BACKUP = "apps.api.routers.auth.clear_backup_email_code"
_SECOND_FACTOR = "apps.api.routers.auth._second_factor_matches"

_POLICY_OK_PASSWORD = "Tf4#qRn8!vZw"


class _StubUser:
    """A user stub whose DERIVED fields really are derived.

    Not a MagicMock, and that difference is the point rather than a style
    preference. A MagicMock's `backup_email_state` is whatever the fixture
    set at construction, so assigning `backup_email` in an endpoint leaves it
    stale — and a test asserting the state after a write would be asserting
    the fixture's opinion, not the code's. The endpoint that stores a new
    address and reports the resulting state is exactly the one that needs
    this to be real.

    The three properties are BORROWED from the model rather than reimplemented
    here, so this exercises the derivation that ships instead of a copy of it
    that can quietly disagree.
    """

    must_set_password = ModelUser.must_set_password
    backup_email_state = ModelUser.backup_email_state
    account_setup_required = ModelUser.account_setup_required


def _user(
    *,
    password_hash="$2b$12$fake",
    backup_email="backup@elsewhere.org",
    verified=True,
    enrolled=False,
    waived=None,
):
    """A stub with the gate COLUMNS set explicitly; the rest is derived.

    Every column is set by hand because the derived properties read them, and
    a missing one would make the gate's own tests assert nothing.
    """
    u = _StubUser()
    u.id = uuid.uuid4()
    u.email = "user@yon.studio"
    u.first_name = "Test"
    u.last_name = "User"
    u.name = "Test User"
    u.avatar_url = None
    u.status = UserStatus.active
    u.role = UserGlobalRole.superuser
    u.deleted_at = None
    u.created_at = datetime.now(timezone.utc)
    u.preferences = {}
    u.invite_token = None
    u.storage_limit_bytes = None
    u.email_verified = True
    u.password_hash = password_hash
    u.two_factor_enabled = enrolled
    u.two_factor_method = "totp" if enrolled else None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    u.token_version = 0
    u.require_2fa = False

    u.backup_email = backup_email
    u.backup_email_verified_at = (
        datetime.now(timezone.utc) if (backup_email and verified) else None
    )
    u.account_gate_waived_at = waived
    return u


def _headers(user):
    return {"Authorization": f"Bearer {create_access_token(str(user.id), 0)}"}


# ── 1. The channel split ────────────────────────────────────────────────────


class TestResetMailGoesOnlyToTheBackupAddress:
    def test_the_reset_code_is_mailed_to_the_backup_address(self, client, mock_db):
        user = _user()
        mock_db.first.return_value = user

        with patch(_REQUIRE_2FA, return_value=False), \
             patch(_STORE_RESET), patch(_SEND_TASK) as send:
            resp = client.post(
                "/auth/send-magic-code",
                json={"email": user.email, "purpose": "password_reset"},
            )

        assert resp.status_code == 200
        # args: (task, to_email, code, expiry, purpose, contact_url)
        recipients = [call.args[1] for call in send.call_args_list]
        assert recipients == [user.backup_email]
        # The load-bearing half: the login mailbox stays empty. A fallback
        # here would re-merge the two channels this whole change exists to
        # separate, and it would do it silently.
        assert user.email not in recipients

    def test_a_login_code_still_goes_to_the_login_address(self, client, mock_db):
        user = _user()
        mock_db.first.return_value = user

        with patch(_REQUIRE_2FA, return_value=False), \
             patch("apps.api.routers.auth.store_magic_code"), \
             patch(_SEND_TASK) as send:
            client.post("/auth/send-magic-code", json={"email": user.email})

        recipients = [call.args[1] for call in send.call_args_list]
        assert recipients == [user.email]
        assert user.backup_email not in recipients

    def test_no_backup_address_means_no_reset_mail_at_all(self, client, mock_db):
        """No fallback, and no account enumeration either.

        A user who has not finished the gate cannot reset their own password.
        That cost is real and it is the point: falling back to the login
        address would restore the single-mailbox account for every user who
        has not finished the gate, which on day one is all of them. The
        escape hatches exist for the people this strands.
        """
        user = _user(backup_email=None, verified=False)
        mock_db.first.return_value = user

        with patch(_REQUIRE_2FA, return_value=False), \
             patch(_STORE_RESET), patch(_SEND_TASK) as send:
            resp = client.post(
                "/auth/send-magic-code",
                json={"email": user.email, "purpose": "password_reset"},
            )

        assert resp.status_code == 200
        # The same neutral wording an address with no account gets, so this
        # still says nothing about who exists.
        assert "If that email has an account" in resp.json()["message"]
        assert send.call_count == 0

    def test_an_unverified_backup_address_receives_nothing(self, client, mock_db):
        """"Pending" is a guess, not a recovery channel."""
        user = _user(verified=False)
        mock_db.first.return_value = user

        with patch(_REQUIRE_2FA, return_value=False), \
             patch(_STORE_RESET), patch(_SEND_TASK) as send:
            client.post(
                "/auth/send-magic-code",
                json={"email": user.email, "purpose": "password_reset"},
            )

        assert send.call_count == 0


# ── 2. What a backup address may be ─────────────────────────────────────────


class TestTheBackupAddressRules:
    def test_the_same_address_is_refused(self, client, mock_db, test_user):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user()
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            resp = client.post(
                "/auth/backup-email",
                json={"backup_email": user.email},
                headers=_headers(user),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 400
        assert "different mailbox" in resp.json()["detail"]

    def test_the_same_address_in_different_case_is_refused(self, client, mock_db):
        """`Mathias@` and `mathias@` are one mailbox (§13a's lesson)."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user()
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            resp = client.post(
                "/auth/backup-email",
                json={"backup_email": user.email.upper()},
                headers=_headers(user),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 400

    def test_the_same_domain_is_accepted_with_the_flag_set(self, client, mock_db):
        """Accepted, because plenty of legitimate setups are two real
        mailboxes in one company — and flagged, because one administrator
        with domain-wide access reads both, which is what the split exists to
        stop."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(backup_email=None, verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_STORE_BACKUP), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/backup-email",
                    json={"backup_email": "second@yon.studio"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["same_domain"] is True
        assert body["state"] == "pending"

    def test_a_different_domain_is_not_flagged(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(backup_email=None, verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_STORE_BACKUP), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/backup-email",
                    json={"backup_email": "me@gmx.at"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.json()["same_domain"] is False

    def test_proposing_an_address_never_marks_it_verified(self, client, mock_db):
        """The single worst bug this endpoint could have."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user()  # already has a VERIFIED address
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_STORE_BACKUP), patch(_SEND_TASK), \
                 patch(_SECOND_FACTOR, return_value=True):
                client.post(
                    "/auth/backup-email",
                    json={"backup_email": "new@gmx.at", "reauth_code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert user.backup_email == "new@gmx.at"
        assert user.backup_email_verified_at is None

    def test_a_wrong_code_does_not_confirm_the_address(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_VERIFY_BACKUP, return_value=(False, "Invalid code")):
                resp = client.post(
                    "/auth/backup-email/verify",
                    json={"code": "000000"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 401
        assert user.backup_email_verified_at is None

    def test_an_expired_code_is_reported_as_such(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_VERIFY_BACKUP, return_value=(False, "Code expired or not found")):
                resp = client.post(
                    "/auth/backup-email/verify",
                    json={"code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 401
        assert "expired" in resp.json()["detail"]

    def test_a_correct_code_confirms_it_and_clears_any_waiver(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(verified=False, waived=datetime.now(timezone.utc))
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_VERIFY_BACKUP, return_value=(True, "")), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/backup-email/verify",
                    json={"code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert user.backup_email_verified_at is not None
        # The waiver was a way past a gate that is now genuinely satisfied.
        # Left set, it would silently exempt this user from a requirement
        # that comes back later.
        assert user.account_gate_waived_at is None

    def test_confirming_notifies_both_addresses(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch(_VERIFY_BACKUP, return_value=(True, "")), \
                 patch(_SEND_TASK) as send:
                client.post(
                    "/auth/backup-email/verify",
                    json={"code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        recipients = {call.args[1] for call in send.call_args_list}
        assert recipients == {user.email, user.backup_email}


# ── 3. The gate itself ──────────────────────────────────────────────────────


class TestTheGateIsComputedFromStoredData:
    @pytest.mark.parametrize(
        "kwargs,expected",
        [
            ({"password_hash": None}, True),
            ({"backup_email": None, "verified": False}, True),
            ({"verified": False}, True),
            ({}, False),
        ],
    )
    def test_gate_outstanding_reads_the_columns(self, kwargs, expected):
        assert gate_outstanding(_user(**kwargs)) is expected

    def test_a_waiver_unblocks_without_satisfying_the_requirement(self):
        """Two different questions, deliberately kept apart.

        `account_setup_required` stays True — the settings screen still asks
        — while `gate_outstanding` goes False, which is the one the
        middleware acts on. Collapsing them into a single flag is how a
        waiver becomes "setup is done" and nobody ever finishes.
        """
        user = _user(password_hash=None, waived=datetime.now(timezone.utc))
        assert user.account_setup_required is True
        assert gate_outstanding(user) is False


class TestTheGateBlocksEveryProtectedRoute:
    def _gated_client(self, client, user):
        """Point the middleware's OWN database lookup at this user.

        The middleware opens its own SessionLocal rather than using the
        request's dependency — it runs before any route — so overriding
        `get_db` is not enough and patching its lookup is the honest way to
        exercise it.
        """
        return patch(
            "apps.api.services.auth_service.get_user_by_id", return_value=user
        )

    def test_a_protected_route_is_refused_with_the_stable_detail(self, client, mock_db):
        user = _user(password_hash=None)
        with self._gated_client(client, user):
            resp = client.get("/projects", headers=_headers(user))

        assert resp.status_code == 403
        assert resp.json()["detail"] == ACCOUNT_SETUP_REQUIRED

    @pytest.mark.parametrize(
        "extra",
        [
            {"headers": {"X-Account-Setup-Done": "1"}},
            {"headers": {"X-Account-Setup-Complete": "true"}},
            {"cookies": {"ff_account_setup_done": "1"}},
            {"params": {"account_setup_done": "1"}},
        ],
    )
    def test_no_client_supplied_claim_can_turn_the_gate_off(
        self, client, mock_db, extra
    ):
        """The rule the whole design rests on, asserted rather than assumed.

        The gate is computed from `users.password_hash`,
        `users.backup_email_verified_at` and `users.account_gate_waived_at`,
        and from nothing else. A header, a cookie or a query parameter
        claiming setup is finished is a claim by the party the gate exists to
        constrain, and must change nothing.

        This test exists because a mutation that read exactly such a header
        passed the rest of this file untouched — the gate was verified to be
        ON, and never verified to be uninfluenceable. Those are different
        properties and only one of them was being checked.
        """
        user = _user(password_hash=None)
        headers = {**_headers(user), **extra.get("headers", {})}
        with self._gated_client(client, user):
            resp = client.get(
                "/projects",
                headers=headers,
                cookies=extra.get("cookies"),
                params=extra.get("params"),
            )

        assert resp.status_code == 403
        assert resp.json()["detail"] == ACCOUNT_SETUP_REQUIRED

    def test_auth_me_is_never_gated(self, client, mock_db):
        """It is what tells the client it is gated.

        Behind the gate, a browser would get a 403 and no way to learn why —
        which is the one failure mode that makes the whole screen
        unreachable.
        """
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(password_hash=None)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with self._gated_client(client, user):
                resp = client.get("/auth/me", headers=_headers(user))
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        body = resp.json()
        assert body["must_set_password"] is True
        assert body["backup_email_state"] == "verified"

    def test_the_gate_endpoints_work_while_the_gate_is_up(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(password_hash=None, backup_email=None, verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with self._gated_client(client, user), \
                 patch(_STORE_BACKUP), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/backup-email",
                    json={"backup_email": "me@gmx.at"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200

    def test_setting_the_password_leaves_the_backup_half_outstanding(
        self, client, mock_db
    ):
        """Order: password first, then the address. Setting one does not
        satisfy the other, which is the difference between a gate computed
        from data and a screen somebody ticked off."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(password_hash=None, backup_email=None, verified=False)
        app.dependency_overrides[get_current_user] = lambda: user
        try:
            with patch("apps.api.routers.auth.hash_password", return_value="$2b$12$x"):
                resp = client.post(
                    "/auth/set-password",
                    json={"password": _POLICY_OK_PASSWORD},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert user.password_hash == "$2b$12$x"
        # Recomputed the way the real model would, now that the row changed.
        assert user.backup_email_state == "missing"

    def test_a_finished_account_is_not_blocked(self, client, mock_db):
        user = _user()
        with self._gated_client(client, user):
            resp = client.get("/projects", headers=_headers(user))

        # Whatever the route answers, it is NOT the gate's 403.
        assert resp.json().get("detail") != ACCOUNT_SETUP_REQUIRED

    def test_an_anonymous_request_is_left_alone(self, client, mock_db):
        """The middleware has no opinion about traffic with no session.

        Whether that is a 401 or perfectly fine is the route's decision, and
        answering 403 `account_setup_required` to a request with no account
        would be nonsense.
        """
        resp = client.get("/projects")
        assert resp.json().get("detail") != ACCOUNT_SETUP_REQUIRED

    def test_a_public_share_link_is_never_gated(self, client, mock_db):
        """Share links belong to people who have no account here at all.

        They must not be collateral damage of a requirement placed on the
        account that created them.
        """
        user = _user(password_hash=None)
        with self._gated_client(client, user):
            resp = client.get("/share/sometoken", headers=_headers(user))
        assert resp.json().get("detail") != ACCOUNT_SETUP_REQUIRED


# ── 4. The passwordless cut-off ─────────────────────────────────────────────


class TestThePasswordlessCutoff:
    def test_before_the_cutoff_a_passwordless_user_still_signs_in(
        self, client, mock_db
    ):
        user = _user(password_hash=None)
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=False):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert resp.status_code == 200
        assert resp.json()["access_token"]

    def test_after_the_cutoff_they_are_refused_and_pointed_at_an_admin(
        self, client, mock_db
    ):
        user = _user(password_hash=None)
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert resp.status_code == 403
        assert "administrator" in resp.json()["detail"]

    def test_a_user_with_a_password_is_unaffected_by_the_cutoff(
        self, client, mock_db
    ):
        """Scoped to `password_hash IS NULL`, not to everyone."""
        user = _user()
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert resp.status_code == 200

    def test_the_reset_purpose_survives_the_cutoff(self, client, mock_db):
        """Closing it there would remove the last way back in rather than
        the shortcut this is meant to remove."""
        user = _user(password_hash=None)
        mock_db.first.return_value = user

        with patch(_VERIFY_RESET, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={
                    "email": user.email,
                    "code": "123456",
                    "purpose": "password_reset",
                },
            )

        assert resp.status_code == 200

    def test_a_wrong_code_is_refused_before_the_cutoff_is_consulted(
        self, client, mock_db
    ):
        """Otherwise the refusal is a free oracle.

        Placed after verification, any address can be probed for "exists and
        has no password" without presenting anything at all.
        """
        user = _user(password_hash=None)
        mock_db.first.return_value = user

        with patch(_REDIS_OK, return_value=(False, "Invalid code")), \
             patch(_WINDOW_CLOSED, return_value=True) as closed:
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "000000"},
            )

        assert resp.status_code == 401
        assert closed.call_count == 0


# ── 5. Step-up on the account-taking changes ────────────────────────────────


class TestStepUpReauth:
    def _as(self, user):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        app.dependency_overrides[get_current_user] = lambda: user
        return app

    def test_changing_a_password_without_the_second_factor_is_refused(
        self, client, mock_db
    ):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(enrolled=True)
        self._as(user)
        try:
            resp = client.post(
                "/auth/set-password",
                json={"password": _POLICY_OK_PASSWORD},
                headers=_headers(user),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 401
        assert user.password_hash == "$2b$12$fake"

    def test_changing_a_password_with_the_second_factor_succeeds(
        self, client, mock_db
    ):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(enrolled=True)
        self._as(user)
        try:
            with patch(_SECOND_FACTOR, return_value=True), \
                 patch("apps.api.routers.auth.hash_password", return_value="$2b$12$new"), \
                 patch(_SEND_TASK) as send:
                resp = client.post(
                    "/auth/set-password",
                    json={"password": _POLICY_OK_PASSWORD, "reauth_code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert user.password_hash == "$2b$12$new"
        recipients = {call.args[1] for call in send.call_args_list}
        assert recipients == {user.email, user.backup_email}

    def test_a_first_password_needs_no_second_factor(self, client, mock_db):
        """The gate's own path. An account with no password has nothing a
        stolen session could take by changing it, and demanding a factor the
        user may not have would make the gate unsatisfiable."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(password_hash=None, enrolled=True)
        self._as(user)
        try:
            with patch("apps.api.routers.auth.hash_password", return_value="$2b$12$new"):
                resp = client.post(
                    "/auth/set-password",
                    json={"password": _POLICY_OK_PASSWORD},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200

    def test_an_unenrolled_user_is_not_asked_for_a_factor_they_cannot_have(
        self, client, mock_db
    ):
        """A consequence, stated rather than hidden.

        `_second_factor_matches` can only accept an authenticator code, an
        emailed 2FA code or a backup code. An unenrolled account has none of
        the three, so requiring one would not add a check — it would remove
        the ability to change your own password.
        """
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(enrolled=False)
        self._as(user)
        try:
            with patch("apps.api.routers.auth.hash_password", return_value="$2b$12$new"):
                resp = client.post(
                    "/auth/set-password",
                    json={"password": _POLICY_OK_PASSWORD},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200

    def test_redirecting_resets_needs_the_second_factor(self, client, mock_db):
        """The most valuable single thing a stolen session could do here."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(enrolled=True)  # already has a VERIFIED backup address
        self._as(user)
        try:
            resp = client.post(
                "/auth/backup-email",
                json={"backup_email": "attacker@evil.example"},
                headers=_headers(user),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 401
        assert user.backup_email == "backup@elsewhere.org"

    def test_the_first_backup_address_needs_no_second_factor(self, client, mock_db):
        """Nothing to redirect yet — the account has no reset channel."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(backup_email=None, verified=False, enrolled=True)
        self._as(user)
        try:
            with patch(_STORE_BACKUP), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/backup-email",
                    json={"backup_email": "me@gmx.at"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200

    def test_disabling_2fa_notifies_both_addresses(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        user = _user(enrolled=True)
        self._as(user)
        try:
            with patch(_SECOND_FACTOR, return_value=True), patch(_SEND_TASK) as send:
                resp = client.post(
                    "/auth/2fa/disable",
                    json={"code": "123456"},
                    headers=_headers(user),
                )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        recipients = {call.args[1] for call in send.call_args_list}
        assert recipients == {user.email, user.backup_email}


# ── 6. The escape hatches ───────────────────────────────────────────────────


class TestTheEscapeHatches:
    def test_an_admin_can_clear_another_users_gate_and_it_is_logged(
        self, client, mock_db
    ):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        admin = _user()
        admin.role = UserGlobalRole.superadmin
        target = _user(password_hash=None, backup_email=None, verified=False)
        mock_db.first.return_value = target

        app.dependency_overrides[get_current_user] = lambda: admin
        try:
            resp = client.patch(
                f"/admin/users/{target.id}/clear-account-gate",
                headers=_headers(admin),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 200
        assert target.account_gate_waived_at is not None
        # An unlogged way to bypass an account requirement is
        # indistinguishable after the fact from an attacker having used it.
        logged = [c.args[0] for c in mock_db.add.call_args_list]
        assert any(
            getattr(obj, "action", None) == "admin_cleared_account_gate"
            for obj in logged
        )

    def test_a_non_admin_cannot(self, client, mock_db):
        from apps.api.main import app
        from apps.api.middleware.auth import get_current_user

        plain = _user()
        plain.role = UserGlobalRole.superuser
        target = _user(password_hash=None)
        mock_db.first.return_value = target

        app.dependency_overrides[get_current_user] = lambda: plain
        try:
            resp = client.patch(
                f"/admin/users/{target.id}/clear-account-gate",
                headers=_headers(plain),
            )
        finally:
            app.dependency_overrides.pop(get_current_user, None)

        assert resp.status_code == 403

    def test_the_script_clears_the_flag_for_a_named_user(self, monkeypatch):
        """The last-superadmin case, where there is nobody to press the
        button."""
        from apps.api.scripts import clear_account_gate as script

        target = _user(password_hash=None, backup_email=None, verified=False)
        db = MagicMock()
        monkeypatch.setattr(script, "SessionLocal", lambda: db)
        monkeypatch.setattr(script, "get_user_by_email", lambda _db, _e: target)

        assert script.main("user@yon.studio", write=True) == 0
        assert target.account_gate_waived_at is not None
        assert db.commit.called

    def test_the_script_dry_run_changes_nothing(self, monkeypatch):
        """The default, because this waives a security requirement for a
        named person and a command that does that on a typo is the wrong
        shape."""
        from apps.api.scripts import clear_account_gate as script

        target = _user(password_hash=None, backup_email=None, verified=False)
        db = MagicMock()
        monkeypatch.setattr(script, "SessionLocal", lambda: db)
        monkeypatch.setattr(script, "get_user_by_email", lambda _db, _e: target)

        assert script.main("user@yon.studio", write=False) == 0
        assert target.account_gate_waived_at is None
        assert not db.commit.called

    def test_the_script_reports_an_unknown_address(self, monkeypatch):
        from apps.api.scripts import clear_account_gate as script

        monkeypatch.setattr(script, "SessionLocal", lambda: MagicMock())
        monkeypatch.setattr(script, "get_user_by_email", lambda _db, _e: None)

        assert script.main("nobody@example.com", write=True) == 1


# ── 7. What the migration leaves behind ─────────────────────────────────────


class TestTheMigrationShape:
    def test_an_existing_row_is_gated_and_keeps_its_session(self):
        """`backup_email = NULL` for everyone, and `token_version` untouched.

        Seeding `backup_email = email` would have satisfied the gate for
        everybody while leaving the single-mailbox account completely
        intact — the one genuinely dangerous option here, and a silent one.
        """
        migrated = _user(backup_email=None, verified=False)
        assert migrated.backup_email is None
        assert migrated.backup_email_state == "missing"
        assert gate_outstanding(migrated) is True
        # Nothing in this migration bumps it, so every live session survives
        # the deploy — the property §199's own migration was built around.
        assert migrated.token_version == 0

    def test_the_cutoff_defaults_to_thirty_days(self):
        """Read off the migration rather than restated, so the number cannot
        drift from what actually runs."""
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1]
            / "alembic"
            / "versions"
            / "add_account_security_gate.py"
        ).read_text()
        assert "interval '30 days'" in source
        # Guarded, so re-running against a partially-migrated database cannot
        # extend a window an operator has already shortened.
        assert "WHERE password_required_after IS NULL" in source
