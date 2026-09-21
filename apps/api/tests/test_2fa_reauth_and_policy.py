"""Re-auth codes that arrive, and an off switch that respects policy (§205).

Three of the four defects §205 fixes live on the server:

**Nothing ever sent a re-auth code.** `/auth/2fa/disable`,
`/auth/2fa/regenerate-backup-codes` and a replacement enrolment all verify
through `_second_factor_matches`, and no path to any of them mailed anything.
A TOTP user opens their authenticator; an email-factor user — the default
arrangement after §200 — had no source for a code at all. All three actions
were dead for every one of them.

**The re-auth mail needed its own words.** The challenge copy says "Enter this
code to finish signing in", which is wrong here for exactly the reason the
login copy was wrong for enrolment in §203: nobody is signing in.

**`require_2fa` did not remove the off switch.** A user could turn their own
2FA off and be force-enrolled again at their NEXT login — leaving the current,
live session running with no second factor for as long as they stayed signed
in.

The fourth defect — backup codes being untypeable — is in the browser, and is
covered by `apps/web/components/auth/__tests__`.

Everything below asserts on behaviour: the queued task's arguments, the pool a
code lands in, the rendered mail, and the endpoint's status.
"""

import re
import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserGlobalRole, UserStatus
from apps.api.services import totp_service
from apps.api.tasks import email_tasks

_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_REQUIRED_FOR = "apps.api.routers.auth.two_factor_required_for"
_SECOND_FACTOR = "apps.api.routers.auth._second_factor_matches"
_LIVE_CHALLENGE = "apps.api.routers.auth.has_live_2fa_email_code"
_STORE_CHALLENGE = "apps.api.routers.auth.store_2fa_email_code"
_LIVE_ENROL = "apps.api.routers.auth.has_live_2fa_setup_code"
_STORE_ENROL = "apps.api.routers.auth.store_2fa_setup_code"
_SEND_EMAIL = "apps.api.tasks.email_tasks._send_email"

EMAIL = "u@example.com"
CODE = "525169"


def _user(*, method="email", enabled=True, role=UserGlobalRole.superuser):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = EMAIL
    u.first_name = "Test"
    u.last_name = "User"
    u.name = "Test User"
    u.avatar_url = None
    u.status = UserStatus.active
    u.role = role
    u.deleted_at = None
    # A real datetime: UserResponse requires it, and the admin endpoint
    # serialises the target user on the way out.
    u.created_at = datetime.now(timezone.utc)
    u.preferences = {}
    u.invite_token = None
    u.storage_limit_bytes = None
    u.email_verified = True
    u.password_hash = "$2b$12$fake"
    u.token_version = 0
    u.two_factor_enabled = enabled
    u.two_factor_method = method if enabled else None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    u.require_2fa = False
    u.backup_email = "backup@elsewhere.org"
    u.must_set_password = False
    u.backup_email_state = "verified"
    u.account_setup_required = False
    u.account_gate_waived_at = None
    return u


def _as(user):
    from apps.api.main import app
    from apps.api.middleware.auth import get_current_user

    app.dependency_overrides[get_current_user] = lambda: user
    return app


def _unset():
    from apps.api.main import app
    from apps.api.middleware.auth import get_current_user

    app.dependency_overrides.pop(get_current_user, None)


def _queued(send_mock):
    """(recipient, purpose) of the queued code mail, or None."""
    for call in send_mock.call_args_list:
        if call.args and getattr(call.args[0], "name", "").endswith("send_magic_code_email"):
            return call.args[1], call.args[4]
    return None


# ── 1. a re-auth code is actually sent, to the right pool ───────────────────


class TestTheReauthCodeIsSent:
    def test_an_email_factor_user_gets_one(self, client, mock_db):
        user = _user(method="email")
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=False), patch(_STORE_CHALLENGE), \
                 patch(_SEND_TASK) as send:
                resp = client.post("/auth/2fa/send-reauth-code")
        finally:
            _unset()

        assert resp.status_code == 200
        assert _queued(send) == (EMAIL, "two_factor_reauth")

    def test_a_totp_user_gets_nothing(self, client, mock_db):
        """No mail, because they have an authenticator. Sending anyway would
        train people to wait for something their own configuration says
        should not arrive."""
        user = _user(method="totp")
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=False), patch(_STORE_CHALLENGE), \
                 patch(_SEND_TASK) as send:
                resp = client.post("/auth/2fa/send-reauth-code")
        finally:
            _unset()

        assert resp.status_code == 200
        assert _queued(send) is None

    def test_an_unenrolled_user_gets_nothing(self, client, mock_db):
        user = _user(enabled=False)
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=False), patch(_STORE_CHALLENGE), \
                 patch(_SEND_TASK) as send:
                resp = client.post("/auth/2fa/send-reauth-code")
        finally:
            _unset()

        assert resp.status_code == 200
        assert _queued(send) is None

    def test_the_code_lands_in_the_CHALLENGE_pool(self, client, mock_db):
        """The one that would break silently.

        `_second_factor_matches` is what redeems a re-auth code, and since
        §204 it reads the challenge pool and cannot see the enrolment pool at
        all. Routing this to the enrolment pool reads like the tidy thing to
        do — it is about two-factor settings, after all — and every re-auth
        would stop working with a correct code.
        """
        user = _user(method="email")
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=False), \
                 patch(_STORE_CHALLENGE) as challenge_store, \
                 patch(_STORE_ENROL) as enrol_store, \
                 patch(_SEND_TASK):
                client.post("/auth/2fa/send-reauth-code")
        finally:
            _unset()

        challenge_store.assert_called_once()
        assert challenge_store.call_args.args[0] == EMAIL
        assert enrol_store.call_count == 0

    def test_opening_a_dialog_does_not_invalidate_a_live_code(self, client, mock_db):
        """`force=false` by default (§194's rule): a code already in the
        person's inbox must not be replaced by the act of looking at the
        screen."""
        user = _user(method="email")
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=True), \
                 patch(_STORE_CHALLENGE) as store, patch(_SEND_TASK) as send:
                client.post("/auth/2fa/send-reauth-code")
        finally:
            _unset()

        assert store.call_count == 0
        assert _queued(send) is None

    def test_send_it_again_forces_a_new_code(self, client, mock_db):
        """There the user is telling us the first one did not arrive."""
        user = _user(method="email")
        _as(user)
        try:
            with patch(_LIVE_CHALLENGE, return_value=True), \
                 patch(_STORE_CHALLENGE) as store, patch(_SEND_TASK) as send:
                client.post("/auth/2fa/send-reauth-code?force=true")
        finally:
            _unset()

        store.assert_called_once()
        assert _queued(send) == (EMAIL, "two_factor_reauth")

    def test_it_needs_a_session(self, client, mock_db):
        assert client.post("/auth/2fa/send-reauth-code").status_code in (401, 403)


# ── 2. the re-auth mail says the right thing ────────────────────────────────


def _render(purpose: str) -> tuple[str, str, str]:
    captured = {}

    def _capture(to_email, subject, html_body, text_body=None):
        captured.update(subject=subject, html=html_body, text=text_body or "")
        return True

    with patch(_SEND_EMAIL, side_effect=_capture):
        email_tasks.send_magic_code_email.run(EMAIL, CODE, 10, purpose)
    return captured["subject"], captured["html"], captured["text"]


def _visible(html: str) -> str:
    html = re.sub(r"<style.*?</style>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


class TestTheReauthMailCopy:
    """§203's test shape, extended to the new purpose."""

    def test_html_and_text_carry_the_same_lead_and_warning(self):
        _subject, html, text = _render("two_factor_reauth")
        copy = email_tasks.MAIL_CODE_COPY["two_factor_reauth"]

        assert copy["lead"] in _visible(html)
        assert copy["lead"] in text
        assert copy["warning"] in _visible(html)
        assert copy["warning"] in text

    def test_it_does_not_tell_the_reader_to_sign_in(self):
        """The §203 mistake, one purpose further on: nobody is signing in
        here either."""
        _subject, html, text = _render("two_factor_reauth")
        body = _visible(html)

        assert "finish signing in" not in body
        assert "finish signing in" not in text
        assert "someone has your password" not in body
        assert "someone has your password" not in text

    def test_it_warns_about_a_settings_change_instead(self):
        _subject, html, text = _render("two_factor_reauth")

        assert "change to your two-factor settings" in _visible(html)
        assert "someone is signed in as you" in text

    def test_the_subject_keeps_the_code_off_the_lock_screen(self):
        """Matching two_factor_setup: this user is sitting in Settings with
        the app open, so the convenience buys nothing."""
        subject, _html, _text = _render("two_factor_reauth")

        assert CODE not in subject

    def test_it_is_distinct_from_every_other_purpose(self):
        mine = email_tasks.MAIL_CODE_COPY["two_factor_reauth"]
        for name, copy in email_tasks.MAIL_CODE_COPY.items():
            if name == "two_factor_reauth":
                continue
            assert copy["warning"] != mine["warning"], name
            assert copy["lead"] != mine["lead"], name


# ── 3. the policy removes the off switch ────────────────────────────────────


class TestRequireTwoFactorRemovesTheOffSwitch:
    def test_disable_is_refused_even_with_a_valid_code(self, client, mock_db):
        """A correct code must not buy an exemption from a policy.

        Checked before the code, so the answer to "may I" cannot depend on
        whether the caller happens to hold one.
        """
        user = _user(method="totp")
        _as(user)
        try:
            with patch(_REQUIRED_FOR, return_value=True), \
                 patch(_SECOND_FACTOR, return_value=True) as factor:
                resp = client.post("/auth/2fa/disable", json={"code": "424242"})
        finally:
            _unset()

        assert resp.status_code == 403
        assert "required on this instance" in resp.json()["detail"]
        assert user.two_factor_enabled is True
        # Refused before the code was even looked at.
        assert factor.call_count == 0

    def test_disable_works_when_the_policy_is_off(self, client, mock_db):
        user = _user(method="totp")
        _as(user)
        try:
            with patch(_REQUIRED_FOR, return_value=False), \
                 patch(_SECOND_FACTOR, return_value=True), patch(_SEND_TASK):
                resp = client.post("/auth/2fa/disable", json={"code": "424242"})
        finally:
            _unset()

        assert resp.status_code == 200
        assert user.two_factor_enabled is False

    def test_regenerating_backup_codes_stays_allowed(self, client, mock_db):
        """It removes no protection. Blocking it would only strand people on
        a set of codes they have lost."""
        user = _user(method="totp")
        _as(user)
        try:
            with patch(_REQUIRED_FOR, return_value=True), \
                 patch(_SECOND_FACTOR, return_value=True), patch(_SEND_TASK):
                resp = client.post(
                    "/auth/2fa/regenerate-backup-codes", json={"code": "424242"}
                )
        finally:
            _unset()

        assert resp.status_code == 200
        assert len(resp.json()["backup_codes"]) > 0

    def test_changing_method_stays_allowed(self, client, mock_db, staged_2fa_setup):
        """Same reasoning: a different second factor is still a second
        factor."""
        from apps.api.main import app
        from apps.api.middleware.auth import get_optional_user

        user = _user(method="totp")
        app.dependency_overrides[get_optional_user] = lambda: user
        try:
            with patch(_REQUIRED_FOR, return_value=True), \
                 patch(_SECOND_FACTOR, return_value=True), \
                 patch(_LIVE_ENROL, return_value=False), patch(_STORE_ENROL), \
                 patch(_SEND_TASK):
                resp = client.post(
                    "/auth/2fa/setup",
                    json={"method": "email", "reauth_code": "424242"},
                )
        finally:
            app.dependency_overrides.pop(get_optional_user, None)

        assert resp.status_code == 200

    def test_the_admin_escape_hatch_is_not_subject_to_the_policy(
        self, client, mock_db
    ):
        """It exists for the user who has lost every factor — precisely the
        situation a policy must not make unrecoverable."""
        admin = _user(method="totp", role=UserGlobalRole.superadmin)
        target = _user(method="email")
        mock_db.first.return_value = target

        _as(admin)
        try:
            with patch(_REQUIRED_FOR, return_value=True):
                resp = client.patch(f"/admin/users/{target.id}/disable-2fa")
        finally:
            _unset()

        assert resp.status_code == 200
        assert target.two_factor_enabled is False

    def test_the_policy_is_read_through_one_helper(self):
        """`two_factor_required_for(db, user)` takes the user it is deciding
        about, even though nothing reads it yet — FilmBill's port extends this
        to per-role requirements, and a signature that already carries the
        subject makes that a one-line change rather than a hunt through
        callers."""
        import inspect

        from apps.api.services.site_settings_service import two_factor_required_for

        params = list(inspect.signature(two_factor_required_for).parameters)
        assert params == ["db", "user"]


# ── 4. backup codes still work end to end on the server ─────────────────────


class TestBackupCodesRemainRedeemable:
    """The browser half of §205 is what was broken; this pins that the server
    half it depends on is intact, in the forms the new field can produce."""

    @pytest.mark.parametrize(
        "typed", ["A7K2-9QXM", "a7k2-9qxm", "A7K29QXM", "a7k2 9qxm", " A7K2-9QXM "]
    )
    def test_every_shape_a_person_might_type_is_accepted(self, typed):
        hashed = totp_service.hash_backup_codes(["A7K2-9QXM"])

        matched, remaining = totp_service.consume_backup_code(hashed, typed)

        assert matched is True
        assert remaining == []

    def test_a_spent_code_does_not_work_twice(self):
        hashed = totp_service.hash_backup_codes(["A7K2-9QXM", "B8L3-0RYN"])

        matched, remaining = totp_service.consume_backup_code(hashed, "a7k2 9qxm")
        assert matched is True
        assert len(remaining) == 1

        again, _ = totp_service.consume_backup_code(remaining, "A7K2-9QXM")
        assert again is False
