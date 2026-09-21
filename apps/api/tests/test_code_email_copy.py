"""What each code mail actually says, and which purpose each caller sends (§203).

Mathias turned two-factor ON from Settings, already signed in, and got a mail
headed **"Your login code — Use this code to sign in to FreeFrame."** The
`two_factor` branch gave itself its own subject and its own plain-text body but
rendered `magic_code.html`, the login template. Two failures at once: the HTML
and the text of the same message said different things, so which instruction
the reader got depended on their mail client; and both were wrong for
enrolment, where the warning "if you did not try to sign in, someone has your
password" is simply false — nobody tried to sign in.

**Why the old test could not catch it.** `test_the_email_says_something_
different` read the function's source and asserted the string
`'purpose == "two_factor"'` appeared in it. That proves a branch exists. It
never looked at what the branch renders, so the branch could render the login
template forever and the test would stay green. Same family as §202: the check
was kinder than production.

So every assertion in this file reads the RENDERED mail — subject, HTML body,
text body — captured at the point the task hands them to the transport. Nothing
here inspects source.
"""

import re
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import UserStatus
from apps.api.services.auth_service import create_2fa_pending_token
from apps.api.tasks import email_tasks

_SEND_EMAIL = "apps.api.tasks.email_tasks._send_email"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_LIVE_CODE = "apps.api.routers.auth.has_live_2fa_email_code"
_STORE_CODE = "apps.api.routers.auth.store_2fa_email_code"
#: §204 — enrolment codes live in their OWN pool now, so the enrolment path
#: touches these instead of the two above. Patching the wrong pair leaves the
#: real functions reaching a Redis that is not there.
_LIVE_SETUP_CODE = "apps.api.routers.auth.has_live_2fa_setup_code"
_STORE_SETUP_CODE = "apps.api.routers.auth.store_2fa_setup_code"

CODE = "525169"

#: The three the product actually sends, plus the fallback. `password_reset`
#: is deliberately absent: §203 does not touch it, and a test that swept it in
#: here would start failing the moment someone edits copy this change has no
#: opinion about.
REAL_PURPOSES = ["login", "two_factor_challenge", "two_factor_setup"]


def render(purpose: str) -> tuple[str, str, str]:
    """Run the real task and return (subject, html_body, text_body).

    `.run()` rather than `.delay()`: this is about what the task produces, and
    a broker would add nothing but a dependency.
    """
    captured = {}

    def _capture(to_email, subject, html_body, text_body=None):
        captured.update(
            subject=subject, html=html_body, text=text_body or "", to=to_email
        )
        return True

    with patch(_SEND_EMAIL, side_effect=_capture):
        email_tasks.send_magic_code_email.run("u@example.com", CODE, 10, purpose)

    return captured["subject"], captured["html"], captured["text"]


def visible_text(html: str) -> str:
    """The words a reader sees, with markup and the stylesheet removed.

    `<style>` has to go first: base.html carries ~90 lines of CSS, and a naive
    tag strip leaves all of it in the "text", which would make almost any
    `in` assertion below pass by accident.
    """
    html = re.sub(r"<style.*?</style>", " ", html, flags=re.S)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()


def _user(email="u@example.com", **kwargs):
    u = MagicMock()
    u.id = __import__("uuid").uuid4()
    u.email = email
    u.status = UserStatus.active
    u.deleted_at = None
    u.password_hash = "$2b$12$fake"
    u.token_version = 0
    u.two_factor_enabled = kwargs.get("two_factor_enabled", False)
    u.two_factor_method = kwargs.get("method")
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    u.require_2fa = False
    return u


# ── 1. each purpose says its own thing ──────────────────────────────────────


class TestEachPurposeRendersItsOwnCopy:
    @pytest.mark.parametrize("purpose", REAL_PURPOSES)
    def test_the_heading_is_the_purposes_own(self, purpose):
        _subject, html, _text = render(purpose)
        expected = email_tasks.MAIL_CODE_COPY[purpose]["heading"]

        assert expected in visible_text(html)

    @pytest.mark.parametrize("purpose", REAL_PURPOSES)
    def test_the_code_is_in_the_body(self, purpose):
        # Whatever else changes, the mail has to carry the thing it exists for.
        _subject, html, text = render(purpose)

        assert CODE in visible_text(html)
        assert CODE in text

    def test_enrolment_does_not_tell_the_reader_to_sign_in(self):
        """The reported bug, as a direct assertion.

        The mail Mathias received said "Use this code to sign in to FreeFrame"
        while he was already signed in and switching the feature on.
        """
        _subject, html, text = render("two_factor_setup")
        body = visible_text(html)

        assert "Use this code to sign in to FreeFrame" not in body
        assert "Use this code to sign in to FreeFrame" not in text
        assert "Your login code" not in body

    def test_enrolment_says_the_code_cannot_sign_you_in(self):
        """The load-bearing sentence: somebody receiving this unexpectedly
        needs to know that reading it grants nothing."""
        _subject, html, text = render("two_factor_setup")

        assert "cannot be used to sign in" in visible_text(html)
        assert "cannot be used to sign in" in text

    def test_enrolment_warns_about_the_right_danger(self):
        """"Someone has your password" is FALSE here — nobody tried to sign
        in. The real danger is the opposite one."""
        _subject, html, text = render("two_factor_setup")
        body = visible_text(html)

        assert "someone is signed in as you" in body
        assert "someone is signed in as you" in text
        assert "someone has your password" not in body
        assert "someone has your password" not in text

    def test_the_login_challenge_keeps_the_password_warning(self):
        """And the challenge mail keeps it, because there it is true."""
        _subject, html, text = render("two_factor_challenge")

        assert "someone has your password" in visible_text(html)
        assert "someone has your password" in text

    def test_the_login_mail_is_unchanged_in_substance(self):
        """§203 does not restyle the highest-volume mail this app sends."""
        subject, html, _text = render("login")
        body = visible_text(html)

        assert subject == f"Your FreeFrame login code: {CODE}"
        assert "Your login code" in body
        assert "Use this code to sign in to FreeFrame" in body

    def test_the_enrolment_subject_keeps_the_code_off_the_lock_screen(self):
        """A code in the subject is readable without unlocking the phone and
        is indexed by every mail server that logs subjects. Enrolment does not
        need it — the user is sitting in front of Settings."""
        subject, _html, _text = render("two_factor_setup")

        assert CODE not in subject


# ── 2. the two parts of one message agree ───────────────────────────────────


class TestHtmlAndTextCannotDisagree:
    """The test that would have caught the bug.

    A multipart mail has two bodies and the client picks one. The old code
    built them from different strings, so the two halves of a single message
    gave contradictory instructions and nothing noticed.
    """

    @pytest.mark.parametrize("purpose", REAL_PURPOSES)
    def test_the_lead_sentence_appears_in_both(self, purpose):
        _subject, html, text = render(purpose)
        lead = email_tasks.MAIL_CODE_COPY[purpose]["lead"]

        assert lead in visible_text(html)
        assert lead in text

    @pytest.mark.parametrize("purpose", REAL_PURPOSES)
    def test_the_warning_appears_in_both(self, purpose):
        _subject, html, text = render(purpose)
        warning = email_tasks.MAIL_CODE_COPY[purpose]["warning"]

        assert warning in visible_text(html)
        assert warning in text

    @pytest.mark.parametrize("purpose", REAL_PURPOSES)
    def test_neither_part_carries_another_purposes_warning(self, purpose):
        """Agreeing with each other is not enough if both agree on the wrong
        message — which is exactly what "your own subject, someone else's
        template" produced."""
        _subject, html, text = render(purpose)
        body = visible_text(html)
        mine = email_tasks.MAIL_CODE_COPY[purpose]["warning"]

        for other, copy in email_tasks.MAIL_CODE_COPY.items():
            if copy["warning"] == mine:
                continue  # the `two_factor` alias shares the challenge copy
            assert copy["warning"] not in body, f"{purpose} carries {other}'s warning"
            assert copy["warning"] not in text, f"{purpose} carries {other}'s warning"


# ── 3. each call site sends the right purpose ───────────────────────────────


class TestTheCallSitesChooseTheRightPurpose:
    """Three situations share one sender, so which label each passes is the
    whole of what decides the wording. Asserted on the QUEUED TASK ARGUMENTS,
    not on the source of the call site."""

    def _queued_purpose(self, send_task_mock) -> str:
        # send_task_safe(task, to_email, code, expiry_minutes, purpose)
        call = next(
            c for c in send_task_mock.call_args_list
            if c.args and getattr(c.args[0], "name", "").endswith("send_magic_code_email")
        )
        return call.args[4]

    def test_enrolment_from_settings_sends_the_setup_purpose(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user()
        from apps.api.main import app
        from apps.api.middleware.auth import get_optional_user

        # `get_optional_user`, not `get_current_user`: /auth/2fa/setup serves
        # BOTH an already-signed-in user and a mid-login one holding a pending
        # token, so it takes the optional dependency. Overriding the wrong one
        # leaves the endpoint seeing no session and answering 401.
        app.dependency_overrides[get_optional_user] = lambda: user
        try:
            with patch(_SEND_TASK) as send, patch(_LIVE_SETUP_CODE, return_value=False), \
                 patch(_STORE_SETUP_CODE):
                resp = client.post("/auth/2fa/setup", json={"method": "email"})
        finally:
            app.dependency_overrides.pop(get_optional_user, None)

        assert resp.status_code == 200, resp.json()
        assert self._queued_purpose(send) == "two_factor_setup"

    def test_a_login_challenge_sends_the_challenge_purpose(self, client, mock_db):
        user = _user(two_factor_enabled=True, method="email")
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_LIVE_CODE, return_value=False), patch(_STORE_CODE), \
             patch(_SEND_TASK) as send:
            resp = client.post(
                "/auth/login", json={"email": user.email, "password": "whatever"}
            )

        assert resp.json()["requires_2fa"] is True
        assert self._queued_purpose(send) == "two_factor_challenge"

    def test_the_lost_authenticator_fallback_sends_the_challenge_purpose(
        self, client, mock_db
    ):
        user = _user(two_factor_enabled=True, method="totp")
        mock_db.first.return_value = user

        with patch(_LIVE_CODE, return_value=False), patch(_STORE_CODE), \
             patch(_SEND_TASK) as send:
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(user.id))},
            )

        assert resp.status_code == 200
        assert self._queued_purpose(send) == "two_factor_challenge"


# ── 4. an unknown purpose still sends ───────────────────────────────────────


class TestAnUnknownPurposeIsNotAnError:
    def test_it_sends_neutral_wording_rather_than_raising(self):
        """A code the user is waiting for must never be lost to a KeyError
        over its label. Same rule SECURITY_NOTICE_BODIES already follows."""
        subject, html, text = render("something_nobody_added_here")
        body = visible_text(html)

        assert CODE in body and CODE in text
        assert email_tasks.NEUTRAL_CODE_COPY["heading"] in body
        assert email_tasks.NEUTRAL_CODE_COPY["lead"] in body
        assert email_tasks.NEUTRAL_CODE_COPY["lead"] in text

    def test_the_neutral_wording_takes_no_side_about_signing_in(self):
        """If the caller could not name the situation, the mail should not
        guess at one — neither "sign in" nor "you are already signed in"."""
        _subject, html, text = render("something_nobody_added_here")
        body = visible_text(html)

        for phrase in ("sign in to FreeFrame", "someone has your password",
                       "someone is signed in as you"):
            assert phrase not in body
            assert phrase not in text

    def test_the_legacy_two_factor_label_still_reads_as_a_challenge(self):
        """§191 called this purpose "two_factor". A Celery message queued
        moments before this deploy still carries that string, and its reader
        should get the challenge warning rather than the neutral one."""
        _subject, html, text = render("two_factor")

        assert "someone has your password" in visible_text(html)
        assert "someone has your password" in text


# ── 5. the codes themselves still work ──────────────────────────────────────


class TestTheFlowsStillDeliverAWorkingCode:
    """Wording is the subject of this change; working is the precondition.

    Both paths below assert the code is stored in the SAME Redis pool it was
    before — which is what makes a code sent by either path verifiable by
    `_second_factor_matches`, untouched here.
    """

    def test_enrolment_stores_a_code_in_the_setup_pool(
        self, client, mock_db, staged_2fa_setup
    ):
        user = _user()
        from apps.api.main import app
        from apps.api.middleware.auth import get_optional_user

        # `get_optional_user`, not `get_current_user`: /auth/2fa/setup serves
        # BOTH an already-signed-in user and a mid-login one holding a pending
        # token, so it takes the optional dependency. Overriding the wrong one
        # leaves the endpoint seeing no session and answering 401.
        app.dependency_overrides[get_optional_user] = lambda: user
        try:
            with patch(_SEND_TASK), patch(_LIVE_SETUP_CODE, return_value=False), \
                 patch(_STORE_SETUP_CODE) as store:
                resp = client.post("/auth/2fa/setup", json={"method": "email"})
        finally:
            app.dependency_overrides.pop(get_optional_user, None)

        assert resp.status_code == 200, resp.json()
        assert resp.json()["email_code_sent"] is True
        store.assert_called_once()
        assert store.call_args.args[0] == user.email

    def test_a_login_challenge_stores_a_code_in_the_same_pool(self, client, mock_db):
        user = _user(two_factor_enabled=True, method="email")
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_LIVE_CODE, return_value=False), patch(_SEND_TASK), \
             patch(_STORE_CODE) as store:
            resp = client.post(
                "/auth/login", json={"email": user.email, "password": "whatever"}
            )

        assert resp.json()["email_code_sent"] is True
        store.assert_called_once()
        assert store.call_args.args[0] == user.email

    def test_the_idempotency_window_is_unchanged(self, client, mock_db):
        """A live code still suppresses a second send, so two page loads do
        not mail two codes and invalidate the one being read (§194)."""
        user = _user(two_factor_enabled=True, method="email")
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.verify_password", return_value=True), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_LIVE_CODE, return_value=True), patch(_SEND_TASK) as send, \
             patch(_STORE_CODE) as store:
            resp = client.post(
                "/auth/login", json={"email": user.email, "password": "whatever"}
            )

        assert resp.json()["email_code_sent"] is False
        assert store.call_count == 0
        assert send.call_count == 0
