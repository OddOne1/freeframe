"""§233b — this instance is invite-only, and /auth/* is where that is true.

Two doors are closed here.

**POST /auth/send-magic-code created an account for any address that asked.**
When `get_user_by_email` found nothing and the purpose was anything but
`password_reset`, the handler counted the table, inserted
`User(status=pending_verification, email_verified=False, role=user)` — or
`superadmin` if the table was empty — and mailed a code to the address the
caller had just typed. `POST /auth/verify-magic-code` turned that code into
a session. So anyone who could load the login page could create an account
and sign into it, with email verification as the only gate. It is the same
open door §233 deleted `POST /auth/register` for, and §195 had closed it
only on instances that require 2FA.

**And the refusals told you who exists.** An unknown address got 404 "User
not found" from verify-magic-code while a wrong code got 401 — one request
per address, nothing to guess, and a list of addresses sorts itself into
accounts and non-accounts. A deactivated account got its own 401 "Account
deactivated", which is strictly worse: it confirms both that the address is
real and that somebody switched it off. On the send side the two success
bodies did the same job more quietly — "Magic code sent to your email" for a
known address, "If that email has an account…" for an unknown one.

So closing the creation half alone would have been half a fix. What is
asserted below is one neutral success body on the way in, one generic 401 on
the way back, and nothing written for an address nobody invited.

What must NOT change, and is asserted here rather than assumed:

  * an invited user still signs in — both by the invite link they were sent
    and by a magic code, because `POST /users/invite` already inserted their
    row;
  * the first-run bootstrap still works, through the route that always
    actually ran it (`POST /setup/create-superadmin`);
  * the password-reset recovery path still issues codes;
  * §195's 403 and §193's second-factor outcomes still look like themselves,
    because those are the responses `apps/web`'s login form branches on.

The row-count and Redis-key assertions at the bottom need a real Postgres
(and, for the Redis half, a real Redis); a mocked session can report
whatever a test asks it to, which is how a phantom row would stay invisible.
"""

import inspect
import json
import os
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

import pytest

from apps.api.models.user import User, UserStatus, UserGlobalRole
from apps.api.routers.auth import (
    SEND_MAGIC_CODE_MESSAGE,
    VERIFY_MAGIC_CODE_REFUSED,
)

_REQUIRE_2FA = "apps.api.routers.auth.require_2fa_enabled"
_STORE_CODE = "apps.api.routers.auth.store_magic_code"
_STORE_RESET = "apps.api.routers.auth.store_password_reset_code"
_VERIFY_CODE = "apps.api.routers.auth.redis_verify_magic_code"
_VERIFY_RESET = "apps.api.routers.auth.verify_password_reset_code"
_SEND_TASK = "apps.api.routers.auth.send_task_safe"
_WINDOW_CLOSED = "apps.api.routers.auth.passwordless_window_closed"


def _user(
    *,
    email="known@example.com",
    status=UserStatus.active,
    password_hash="$2b$12$fake",
    backup_verified=True,
):
    """A user row complete enough for the endpoints under test to serialise."""
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.name = "Known User"
    u.first_name = "Known"
    u.last_name = "User"
    u.avatar_url = None
    u.status = status
    u.email_verified = True
    u.role = UserGlobalRole.user
    u.invite_token = None
    u.preferences = {}
    u.created_at = datetime.now(timezone.utc)
    u.storage_limit_bytes = None
    u.deleted_at = None
    u.password_hash = password_hash
    u.two_factor_enabled = False
    u.two_factor_method = None
    u.totp_secret_encrypted = None
    u.backup_codes_hashed = None
    u.token_version = 0
    u.backup_email = "backup@example.org" if backup_verified else None
    u.backup_email_verified_at = (
        datetime.now(timezone.utc) if backup_verified else None
    )
    return u


def _send(client, mock_db, *, user, email, purpose=None, require_2fa=False):
    """POST /auth/send-magic-code with every side effect captured.

    Both Redis pools and the Celery dispatcher are patched, so "no code was
    stored" and "no mail was queued" are assertions about calls rather than
    about a Redis that happens not to be reachable from the test runner.
    """
    mock_db.first.return_value = user
    body = {"email": email}
    if purpose is not None:
        body["purpose"] = purpose
    with patch(_REQUIRE_2FA, return_value=require_2fa), \
         patch(_STORE_CODE) as store_login, \
         patch(_STORE_RESET) as store_reset, \
         patch(_SEND_TASK) as send_task:
        resp = client.post("/auth/send-magic-code", json=body)
    return resp, store_login, store_reset, send_task


def _rows_added(mock_db):
    """Every User the endpoint tried to persist."""
    return [c.args[0] for c in mock_db.add.call_args_list if isinstance(c.args[0], User)]


def _answer(resp):
    """What a caller can actually see. The whole of the comparison.

    The body is serialised rather than returned as a dict so several of
    these can go into a set — "all of these are the same answer" reads
    better as one `len(...) == 1` than as a chain of pairwise `==`.
    """
    return resp.status_code, json.dumps(resp.json(), sort_keys=True)


# ── the door that closes ────────────────────────────────────────────────────


class TestAnUnknownAddressGetsNothing:
    def test_no_row_no_code_no_mail(self, client, mock_db):
        """THE test in this file."""
        resp, store_login, store_reset, send_task = _send(
            client, mock_db, user=None, email="nobody@example.com"
        )

        assert resp.status_code == 200
        assert _rows_added(mock_db) == []
        mock_db.add.assert_not_called()
        mock_db.commit.assert_not_called()
        store_login.assert_not_called()
        store_reset.assert_not_called()
        send_task.assert_not_called()

    @pytest.mark.parametrize("purpose", [None, "login", "signup", "", "register"])
    def test_for_every_purpose_but_a_reset(self, client, mock_db, purpose):
        """Written as "anything but password_reset", not as a list of known
        purposes — a purpose invented next year must not create accounts by
        default. `""` and `"register"` are there because a caller picks this
        field, not us."""
        resp, store_login, store_reset, send_task = _send(
            client, mock_db, user=None, email="nobody@example.com", purpose=purpose
        )

        assert resp.status_code == 200
        assert _rows_added(mock_db) == []
        store_login.assert_not_called()
        store_reset.assert_not_called()
        send_task.assert_not_called()

    def test_an_empty_users_table_does_not_mint_a_superadmin(self, client, mock_db):
        """The `is_first_user` branch is gone.

        It read `db.query(User)...count() == 0` and, on an empty table, made
        the address asking for a code a SUPERADMIN — pending_verification,
        unverified and with no password, but superadmin. A fresh install that
        was reachable before anyone ran setup handed its instance to whoever
        typed an address first. The bootstrap lives in
        POST /setup/create-superadmin; see
        TestTheFirstRunBootstrapStillWorks below.
        """
        mock_db.count.return_value = 0

        resp, store_login, _, send_task = _send(
            client, mock_db, user=None, email="first@example.com"
        )

        assert resp.status_code == 200
        assert _rows_added(mock_db) == []
        store_login.assert_not_called()
        send_task.assert_not_called()

    def test_the_handler_no_longer_contains_a_write_at_all(self):
        """A source-text tripwire, and the only one in this file.

        Every other assertion here is about behaviour. This one exists
        because the regression it guards against is a three-line paste: the
        block that was removed is still in this repo's history, and a merge
        that brings it back would be caught by the tests above only while
        they are run against a mock whose `first` returns None. Reading the
        handler is cheap and says plainly that no INSERT remains.
        """
        from apps.api.routers.auth import send_magic_code

        source = inspect.getsource(send_magic_code)
        # Comments in this handler discuss the removed code by name, so the
        # check is on the code lines only.
        code_lines = [
            line
            for line in source.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        body = "\n".join(code_lines)
        assert "db.add(" not in body
        assert "db.commit(" not in body
        assert "is_first_user" not in body
        assert "UserGlobalRole" not in body


class TestTheTwoAnswersAreTheSameAnswer:
    def test_known_and_unknown_are_byte_identical(self, client, mock_db):
        """The enumeration oracle this change would otherwise have left
        behind. Closing the creation half while still answering "Magic code
        sent to your email" for a real account and "If that email has an
        account…" for a fake one would have swapped a way IN for a way to
        find out who is in — which, on a self-hosted instance for one studio
        and its clients, is a client list."""
        known, _, _, _ = _send(
            client, mock_db, user=_user(), email="known@example.com"
        )
        unknown, _, _, _ = _send(
            client, mock_db, user=None, email="nobody@example.com"
        )

        # `email` echoes back whatever was submitted, so the comparison is on
        # the status and the message — everything that is not the caller's
        # own input.
        assert known.status_code == unknown.status_code == 200
        assert known.json()["message"] == unknown.json()["message"]
        assert known.json()["message"] == SEND_MAGIC_CODE_MESSAGE
        assert set(known.json()) == set(unknown.json())

    def test_the_message_is_the_neutral_one_the_reset_branch_already_used(
        self, client, mock_db
    ):
        """Same string, so nothing new had to be invented and the claim is
        true on every path it is returned from."""
        reset_unknown, _, _, _ = _send(
            client,
            mock_db,
            user=None,
            email="nobody@example.com",
            purpose="password_reset",
        )
        login_unknown, _, _, _ = _send(
            client, mock_db, user=None, email="nobody@example.com"
        )

        assert _answer(reset_unknown) == _answer(login_unknown)
        assert reset_unknown.json()["message"] == SEND_MAGIC_CODE_MESSAGE

    def test_a_reset_that_cannot_be_delivered_looks_the_same_too(
        self, client, mock_db
    ):
        """§200's channel split: a reset for an account with no VERIFIED
        backup address sends nothing. That outcome shares the body as well,
        so "has an account but has not finished the gate" is not a third
        thing a caller can detect."""
        resp, _, store_reset, send_task = _send(
            client,
            mock_db,
            user=_user(backup_verified=False),
            email="known@example.com",
            purpose="password_reset",
        )

        assert resp.json()["message"] == SEND_MAGIC_CODE_MESSAGE
        store_reset.assert_called_once()  # the code is minted; only the mail stops
        send_task.assert_not_called()


class TestAKnownAddressStillGetsItsCode:
    def test_a_login_code_is_stored_and_queued(self, client, mock_db):
        resp, store_login, store_reset, send_task = _send(
            client, mock_db, user=_user(), email="known@example.com"
        )

        assert resp.status_code == 200
        store_login.assert_called_once()
        store_reset.assert_not_called()
        send_task.assert_called_once()
        # The mail goes to the login address for a login code (§200).
        assert send_task.call_args.args[1] == "known@example.com"

    def test_a_reset_code_still_goes_to_the_backup_address(self, client, mock_db):
        resp, store_login, store_reset, send_task = _send(
            client,
            mock_db,
            user=_user(),
            email="known@example.com",
            purpose="password_reset",
        )

        assert resp.status_code == 200
        store_reset.assert_called_once()
        store_login.assert_not_called()
        send_task.assert_called_once()
        assert send_task.call_args.args[1] == "backup@example.org"

    def test_the_rate_limiter_is_still_attached(self):
        """`rate_limit("send_magic_code", 5, 600)` is what bounds how much of
        the remaining timing difference between a known and an unknown
        address anyone can collect, so it is pinned rather than trusted."""
        from apps.api.routers.auth import router

        route = next(
            r for r in router.routes
            if getattr(r, "path", None) == "/auth/send-magic-code"
        )
        # `rate_limit(action, max, window)` closes over its three arguments,
        # so the route's own dependency carries them — read them back rather
        # than trusting that a decorator line is still there.
        closed_over = [
            cell.cell_contents
            for dep in route.dependencies
            for cell in (dep.dependency.__closure__ or ())
        ]
        assert "send_magic_code" in closed_over
        assert 5 in closed_over
        assert 600 in closed_over


class TestTheRequire2faGateIsUntouched:
    """§195's 403 is a different answer from everything above, deliberately.

    It says something about the INSTANCE (which GET /site-settings already
    publishes anonymously) and nothing about the address, and a legitimate
    user needs to be told their inbox will stay empty rather than be left
    watching it.
    """

    def test_a_known_address_is_still_refused_with_403(self, client, mock_db):
        resp, store_login, _, send_task = _send(
            client, mock_db, user=_user(), email="known@example.com", require_2fa=True
        )

        assert resp.status_code == 403
        store_login.assert_not_called()
        send_task.assert_not_called()

    def test_an_unknown_address_is_refused_identically(self, client, mock_db):
        known, _, _, _ = _send(
            client, mock_db, user=_user(), email="known@example.com", require_2fa=True
        )
        unknown, _, _, _ = _send(
            client, mock_db, user=None, email="nobody@example.com", require_2fa=True
        )

        assert _answer(known) == _answer(unknown)

    def test_no_row_is_created_with_the_requirement_on_either(self, client, mock_db):
        resp, _, _, _ = _send(
            client, mock_db, user=None, email="nobody@example.com", require_2fa=True
        )

        assert resp.status_code == 403
        assert _rows_added(mock_db) == []

    def test_a_reset_still_gets_through_with_the_requirement_on(self, client, mock_db):
        """The recovery path for users whose `password_hash` is NULL. Closing
        it would lock them out permanently."""
        resp, _, store_reset, send_task = _send(
            client,
            mock_db,
            user=_user(),
            email="known@example.com",
            purpose="password_reset",
            require_2fa=True,
        )

        assert resp.status_code == 200
        store_reset.assert_called_once()
        send_task.assert_called_once()


# ── the way back: one refusal ───────────────────────────────────────────────


def _verify(client, mock_db, *, user, code_ok, error="Invalid code", purpose=None):
    mock_db.first.return_value = user
    body = {"email": "whoever@example.com", "code": "000000"}
    if purpose is not None:
        body["purpose"] = purpose
    reset = purpose == "password_reset"
    with patch(_VERIFY_RESET if reset else _VERIFY_CODE,
               return_value=(code_ok, "" if code_ok else error)), \
         patch(_REQUIRE_2FA, return_value=False), \
         patch(_WINDOW_CLOSED, return_value=False):
        return client.post("/auth/verify-magic-code", json=body)


class TestEveryRefusalLooksTheSame:
    def test_unknown_deactivated_and_wrong_code_are_one_answer(
        self, client, mock_db
    ):
        """THE other test in this file.

        Four callers, four different reasons to be turned away, one response.
        A soft-deleted account is the first case rather than a fifth, because
        `get_user_by_email` filters on `deleted_at` — so by the time the
        handler looks, a deleted account and an address that never existed
        are the same thing.
        """
        unknown = _verify(client, mock_db, user=None, code_ok=False,
                          error="Code expired or not found")
        deactivated = _verify(
            client, mock_db, user=_user(status=UserStatus.deactivated), code_ok=True
        )
        wrong_code = _verify(client, mock_db, user=_user(), code_ok=False,
                             error="Invalid code")
        expired = _verify(client, mock_db, user=_user(), code_ok=False,
                          error="Code expired or not found")
        throttled = _verify(client, mock_db, user=_user(), code_ok=False,
                            error="Too many attempts. Request a new code.")

        answers = {
            _answer(unknown),
            _answer(deactivated),
            _answer(wrong_code),
            _answer(expired),
            _answer(throttled),
        }
        assert len(answers) == 1
        assert answers.pop() == (401, json.dumps({"detail": VERIFY_MAGIC_CODE_REFUSED}))

    def test_the_unknown_case_is_no_longer_a_404(self, client, mock_db):
        """Named on its own because 404 is what the other conversation found
        and what a reviewer will look for. A 404 here is an enumeration
        oracle that costs one request and needs no code at all."""
        resp = _verify(client, mock_db, user=None, code_ok=False)

        assert resp.status_code == 401

    def test_the_message_names_the_code_and_not_the_account(self, client, mock_db):
        for user, code_ok in (
            (None, False),
            (_user(status=UserStatus.deactivated), True),
            (_user(), False),
        ):
            detail = _verify(client, mock_db, user=user, code_ok=code_ok).json()["detail"]
            assert detail == VERIFY_MAGIC_CODE_REFUSED
            assert "not found" not in detail.lower()
            assert "deactivated" not in detail.lower()
            assert "account" not in detail.lower()

    def test_a_reset_code_is_refused_identically(self, client, mock_db):
        """The reset pool verifies through a different function, and it had
        the same 404 above it."""
        unknown = _verify(client, mock_db, user=None, code_ok=False,
                          purpose="password_reset")
        wrong = _verify(client, mock_db, user=_user(), code_ok=False,
                        purpose="password_reset")

        assert _answer(unknown) == _answer(wrong)
        assert unknown.status_code == 401

    def test_an_unknown_address_still_costs_a_redis_lookup(self, client, mock_db):
        """Not a style point: this is the timing half of "indistinguishable".

        The handler used to answer an unknown address before touching Redis,
        so the three refusals differed in latency even once they stopped
        differing in text. The code pool is now consulted first and
        regardless of what the account turns out to be.
        """
        mock_db.first.return_value = None
        with patch(_VERIFY_CODE, return_value=(False, "nope")) as redis_check:
            client.post(
                "/auth/verify-magic-code",
                json={"email": "nobody@example.com", "code": "000000"},
            )

        redis_check.assert_called_once()

    def test_a_correct_code_is_spent_even_when_the_account_cannot_sign_in(
        self, client, mock_db
    ):
        """The consequence of checking the code first, stated as a test
        because it is a behaviour change and the right way round: a code is
        consumed by being PRESENTED, not by succeeding."""
        with patch(_VERIFY_CODE, return_value=(True, "")) as redis_check:
            mock_db.first.return_value = _user(status=UserStatus.deactivated)
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": "known@example.com", "code": "123456"},
            )

        assert resp.status_code == 401
        redis_check.assert_called_once()


class TestTheGoodPathsStayDistinguishable:
    """Everything below the refusal has already proved it read the mailbox,
    and `apps/web/components/auth/login-form.tsx` branches on all three."""

    def test_a_correct_code_for_an_active_user_still_signs_in(self, client, mock_db):
        resp = _verify(client, mock_db, user=_user(), code_ok=True)

        assert resp.status_code == 200
        assert resp.json()["requires_2fa"] is False
        assert resp.json()["access_token"]

    def test_a_pending_verification_user_is_still_activated_by_a_code(
        self, client, mock_db
    ):
        user = _user(status=UserStatus.pending_verification)
        resp = _verify(client, mock_db, user=user, code_ok=True)

        assert resp.status_code == 200
        assert user.status == UserStatus.active
        assert user.email_verified is True

    def test_the_2fa_gate_still_answers_requires_2fa(self, client, mock_db):
        user = _user()
        user.two_factor_enabled = True
        user.two_factor_method = "totp"
        mock_db.first.return_value = user

        with patch(_VERIFY_CODE, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=False):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": "123456"},
            )

        assert resp.status_code == 200
        assert resp.json()["requires_2fa"] is True
        assert resp.json()["pending_token"]

    def test_the_passwordless_cut_off_is_still_its_own_403(self, client, mock_db):
        """§200's window. Distinguishable on purpose, and safe to be: the
        caller has already presented a correct code, so it tells them
        nothing they did not have."""
        mock_db.first.return_value = _user(password_hash=None)
        with patch(_VERIFY_CODE, return_value=(True, "")), \
             patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=True):
            resp = client.post(
                "/auth/verify-magic-code",
                json={"email": "known@example.com", "code": "123456"},
            )

        assert resp.status_code == 403
        assert "administrator" in resp.json()["detail"]


# ── and the people who are supposed to get in ───────────────────────────────


class TestAnInvitedUserIsUnaffected:
    """`POST /users/invite` inserts the row, so `get_user_by_email` finds it.

    That is the whole reason this change does not touch invited users, and it
    is worth asserting rather than reasoning about: the row exists before
    they ever reach /auth/*, in `pending_invite` with an `invite_token`.
    """

    def _invited(self, **kw):
        user = _user(status=UserStatus.pending_invite, password_hash=None, **kw)
        user.invite_token = "a-token-the-admin-mailed-them"
        user.invite_token_expires_at = datetime.now(timezone.utc) + timedelta(days=7)
        return user

    def test_the_invite_link_still_resolves(self, client, mock_db):
        user = self._invited()
        mock_db.first.return_value = user

        resp = client.get(f"/auth/invite/{user.invite_token}")

        assert resp.status_code == 200
        assert resp.json()["email"] == user.email

    def test_accepting_an_invite_still_sets_a_password_and_activates(
        self, client, mock_db
    ):
        user = self._invited()
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/accept-invite",
            json={"token": user.invite_token, "password": "Tf4#qRn8!vZw"},
        )

        assert resp.status_code == 200
        assert resp.json()["access_token"]
        assert user.status == UserStatus.active
        assert user.password_hash is not None
        assert user.invite_token is None

    def test_a_pending_invite_user_can_still_ask_for_a_magic_code(
        self, client, mock_db
    ):
        """The case this change could plausibly have broken: an invited
        person who ignores the link and types their address into the login
        box instead. Their row exists, so nothing here refuses them."""
        resp, store_login, _, send_task = _send(
            client, mock_db, user=self._invited(), email="known@example.com"
        )

        assert resp.status_code == 200
        store_login.assert_called_once()
        send_task.assert_called_once()

    def test_and_can_still_complete_that_sign_in(self, client, mock_db):
        """Through to tokens, including `needs_password=True` — they have no
        password yet, which is what sends the login form to its
        set-a-password step."""
        user = self._invited()
        resp = _verify(client, mock_db, user=user, code_ok=True)

        assert resp.status_code == 200
        body = resp.json()
        assert body["access_token"]
        assert body["needs_password"] is True
        assert user.email_verified is True
        # `pending_invite` is deliberately NOT auto-activated by this path —
        # only `pending_verification` is, and that was true before §233b too.
        # The account gate (§200) is what then walks them through setting a
        # password; accept-invite is what flips the status.
        assert user.status == UserStatus.pending_invite

    def test_a_pending_verification_user_can_still_sign_in_too(
        self, client, mock_db
    ):
        """There are existing rows in this state — every account self-created
        before §233b. They keep working: the status is not a gate, the
        presence of a row is."""
        resp, store_login, send = _send(
            client, mock_db, user=_user(status=UserStatus.pending_verification),
            email="known@example.com",
        )[:3]

        assert resp.status_code == 200
        store_login.assert_called_once()


class TestTheFirstRunBootstrapStillWorks:
    """The `is_first_user` branch removed from send-magic-code was never the
    bootstrap. This is, and the evidence is in three places:

      * `routers/setup.py` creates the first superadmin ACTIVE,
        `email_verified=True`, with a password `validate_password` checked,
        and refuses once any superadmin exists;
      * `apps/web/middleware.ts` redirects every unauthenticated request to
        `/setup` while `GET /setup/status` answers `needs_setup`;
      * `app/(auth)/login/page.tsx` does the same on load — so the login
        screen, where the magic-code branch lived, cannot be reached on an
        empty instance.

    tests/test_setup_superadmin.py owns this route in detail; what is pinned
    here is the pair of claims §233b rests on.
    """

    def test_setup_status_reports_a_fresh_instance_as_needing_setup(
        self, client, mock_db
    ):
        mock_db.first.return_value = None

        resp = client.get("/setup/status")

        assert resp.status_code == 200
        assert resp.json()["needs_setup"] is True

    def test_create_superadmin_still_makes_an_active_verified_superadmin(
        self, client, mock_db
    ):
        mock_db.first.return_value = None

        resp = client.post(
            "/setup/create-superadmin",
            json={
                "email": "owner@example.com",
                "first_name": "Owner",
                "last_name": "Person",
                "password": "Tf4#qRn8!vZw",
            },
        )

        assert resp.status_code == 201
        assert resp.json()["access_token"]
        created = _rows_added(mock_db)
        assert len(created) == 1
        assert created[0].role == UserGlobalRole.superadmin
        assert created[0].status == UserStatus.active
        assert created[0].email_verified is True
        assert created[0].password_hash  # unlike the branch that was removed

    def test_it_refuses_once_a_superadmin_exists(self, client, mock_db):
        mock_db.first.return_value = _user()

        resp = client.post(
            "/setup/create-superadmin",
            json={
                "email": "second@example.com",
                "last_name": "Person",
                "password": "Tf4#qRn8!vZw",
            },
        )

        assert resp.status_code == 403
        assert _rows_added(mock_db) == []


# ─── against a real database ─────────────────────────────────────────────────
#
# Everything above runs on the mocked session the rest of this suite uses,
# which can express "the endpoint did not call db.add" but not "the table did
# not grow". The difference is not academic: a phantom row is exactly the
# kind of thing a mock reports whatever the test asks it to.
#
#   docker run -d --name ff-pg -e POSTGRES_USER=freeframe \
#     -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \
#     -p 55441:5432 postgres:15-alpine
#   (cd apps/api && alembic upgrade head)
#   TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55441/freeframe \
#     pytest apps/api/tests/test_signup_closed.py
#
# TEST_REDIS_URL additionally points the magic-code pool at a real Redis, so
# "no code was stored" becomes a key that is absent rather than a mock that
# was not called.

PG_URL = os.environ.get("TEST_DATABASE_URL")
REDIS_URL = os.environ.get("TEST_REDIS_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres; a row "
           "count is not something the mocked session can express",
)
realredis = pytest.mark.skipif(
    not REDIS_URL or not REDIS_URL.startswith("redis"),
    reason="needs TEST_REDIS_URL pointing at a Redis; an absent key is not "
           "something a patched store function can express",
)


@pytest.fixture
def real_db():
    """A session on the real Postgres, plus the list of rows to delete.

    Named rows only, like tests/test_user_storage_default.py: this database
    may be somebody's scratch copy of a real one, so nothing here truncates
    a table.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    engine = create_engine(PG_URL, future=True)
    Session = sessionmaker(bind=engine, future=True)
    session = Session()
    created: list[uuid.UUID] = []
    try:
        yield session, created, Session
    finally:
        session.rollback()
        if created:
            session.query(User).filter(
                User.id.in_(created)
            ).delete(synchronize_session=False)
            session.commit()
        session.close()


@pytest.fixture
def real_client(real_db):
    """A TestClient wired to the real session, with the setup guard satisfied.

    The guard reaches past any dependency override to the real
    `SessionLocal`; with a reachable database and no superadmin in it, it
    would answer 503 to every assertion in this file. Flipping its cached
    flag is what the mocked half of the suite gets for free from an
    unreachable DATABASE_URL.
    """
    from fastapi.testclient import TestClient

    from apps.api.database import get_db
    from apps.api.main import app
    from apps.api.middleware import setup_guard

    session, _created, Session = real_db

    def _override():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    previous = setup_guard._setup_complete
    setup_guard._setup_complete = True
    app.dependency_overrides[get_db] = _override
    try:
        yield TestClient(app, raise_server_exceptions=False)
    finally:
        app.dependency_overrides.pop(get_db, None)
        setup_guard._setup_complete = previous


@pytest.fixture
def real_redis():
    """Point the magic-code pool at a real Redis for the duration of a test.

    The client is swapped rather than the three helper functions patched,
    because the property under test is what is in Redis afterwards. Keys this
    test created are deleted on the way out; nothing is flushed.
    """
    import redis as redis_lib

    from apps.api.services import redis_service

    client = redis_lib.from_url(REDIS_URL, decode_responses=True)
    previous = redis_service._redis_client
    redis_service._redis_client = client
    created_keys: list[str] = []
    try:
        yield client, created_keys
    finally:
        if created_keys:
            client.delete(*created_keys)
        redis_service._redis_client = previous


@pytest.fixture
def no_rate_limit():
    """The limiter shares the Redis client the fixture above swaps in, and
    these tests are not about it. Six sends in one module would otherwise hit
    `rate_limit("send_magic_code", 5, 600)` and assert against a 429."""
    with patch("apps.api.middleware.rate_limit.check_rate_limit",
               return_value=(True, 0)):
        yield


def _unique_email(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}@ff233btest.com"


def _invited_row(session, created, email):
    """A row in exactly the state POST /users/invite leaves behind."""
    user = User(
        email=email,
        first_name="In",
        last_name="Vited",
        status=UserStatus.pending_invite,
        invite_token=uuid.uuid4().hex,
        invite_token_expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    session.add(user)
    session.commit()
    created.append(user.id)
    return user


@realdb
class TestTheTableDoesNotGrow:
    def test_an_unknown_address_adds_no_row(
        self, real_db, real_client, no_rate_limit
    ):
        """THE assertion this whole file exists for, against real SQL."""
        from sqlalchemy import func

        session, _created, _ = real_db
        before = session.query(func.count(User.id)).scalar()
        email = _unique_email("nobody")

        with patch(_STORE_CODE) as store, patch(_SEND_TASK) as send_task:
            resp = real_client.post("/auth/send-magic-code", json={"email": email})

        assert resp.status_code == 200
        assert resp.json()["message"] == SEND_MAGIC_CODE_MESSAGE

        # The row count FIRST, deliberately: it is what this test is named
        # for, and a mutation that puts the INSERT back should fail on the
        # table rather than on a mock that happened to be checked earlier.
        session.expire_all()
        assert session.query(func.count(User.id)).scalar() == before
        assert (
            session.query(User).filter(func.lower(User.email) == email).first()
            is None
        )
        store.assert_not_called()
        send_task.assert_not_called()

    @pytest.mark.parametrize("purpose", ["login", "signup"])
    def test_nor_does_any_other_purpose(
        self, real_db, real_client, no_rate_limit, purpose
    ):
        from sqlalchemy import func

        session, _created, _ = real_db
        before = session.query(func.count(User.id)).scalar()
        email = _unique_email("nobody")

        with patch(_STORE_CODE), patch(_SEND_TASK):
            resp = real_client.post(
                "/auth/send-magic-code", json={"email": email, "purpose": purpose}
            )

        assert resp.status_code == 200
        session.expire_all()
        assert session.query(func.count(User.id)).scalar() == before

    def test_an_invited_address_still_gets_its_code(
        self, real_db, real_client, no_rate_limit
    ):
        """Same real table, the other side of the rule: a row the admin
        invite flow inserted is found, so a code is minted and queued."""
        session, created, _ = real_db
        user = _invited_row(session, created, _unique_email("invited"))

        with patch(_STORE_CODE) as store, patch(_SEND_TASK) as send_task:
            resp = real_client.post(
                "/auth/send-magic-code", json={"email": user.email}
            )

        assert resp.status_code == 200
        store.assert_called_once()
        send_task.assert_called_once()
        assert send_task.call_args.args[1] == user.email

    def test_the_bootstrap_still_works_on_an_instance_with_no_superadmin(
        self, real_db, real_client, no_rate_limit
    ):
        """The claim the `is_first_user` removal rests on, end to end.

        Two halves: the setup route creates a real superadmin row, and
        send-magic-code does NOT — not even for the very first address, which
        is what the removed branch used to make one for.
        """
        from sqlalchemy import func

        session, created, _ = real_db

        # The address the removed branch would have made a superadmin.
        unknown = _unique_email("firstcomer")
        before = session.query(func.count(User.id)).scalar()
        with patch(_STORE_CODE), patch(_SEND_TASK):
            assert real_client.post(
                "/auth/send-magic-code", json={"email": unknown}
            ).status_code == 200
        session.expire_all()
        assert session.query(func.count(User.id)).scalar() == before
        assert not session.query(User).filter(
            func.lower(User.email) == unknown
        ).count()

        # The route that really does bootstrap, called directly.
        #
        # `_has_superadmin` is forced to False rather than arranged for. This
        # database is a scratch one that other realdb files in this suite
        # leave superadmin rows in (test_upload_prefix_concurrency.py and
        # test_comment_replies.py both do), so "no superadmin exists yet" is
        # not a state a test can rely on finding — and emptying the table to
        # get it is exactly what none of these files are allowed to do. The
        # guard's refusal has its own coverage either way:
        # test_it_refuses_once_a_superadmin_exists above, and
        # tests/test_setup_superadmin.py. What this test adds is the REAL
        # ROW the route writes, which is the half a mock cannot show.
        from apps.api.routers import setup as setup_router
        from apps.api.routers.setup import CreateSuperAdminRequest, create_superadmin

        owner = _unique_email("owner")
        with patch.object(setup_router, "_has_superadmin", return_value=False), \
             patch.object(setup_router, "hash_password", return_value="$2b$12$stub"):
            create_superadmin(
                CreateSuperAdminRequest(
                    email=owner,
                    first_name="Owner",
                    last_name="Person",
                    password="Tf4#qRn8!vZw",
                ),
                db=session,
            )
        row = session.query(User).filter(func.lower(User.email) == owner).one()
        created.append(row.id)
        assert row.role == UserGlobalRole.superadmin
        assert row.status == UserStatus.active
        assert row.email_verified is True
        assert row.password_hash


@realdb
@realredis
class TestNothingReachesRedisEither:
    def test_no_key_appears_for_an_unknown_address(
        self, real_db, real_client, real_redis, no_rate_limit
    ):
        client_redis, _keys = real_redis
        email = _unique_email("nobody")
        key = f"magic_code:{email.lower()}"
        assert client_redis.get(key) is None  # nothing left from a prior run

        with patch(_SEND_TASK) as send_task:
            resp = real_client.post("/auth/send-magic-code", json={"email": email})

        assert resp.status_code == 200
        assert client_redis.get(key) is None
        send_task.assert_not_called()

    def test_a_key_does_appear_for_an_invited_address(
        self, real_db, real_client, real_redis, no_rate_limit
    ):
        """The control. Without it, an absent key above would also be
        satisfied by a Redis this test cannot reach at all."""
        session, created, _ = real_db
        client_redis, keys = real_redis
        user = _invited_row(session, created, _unique_email("invited"))
        key = f"magic_code:{user.email.lower()}"
        keys.append(key)

        with patch(_SEND_TASK) as send_task:
            resp = real_client.post(
                "/auth/send-magic-code", json={"email": user.email}
            )

        assert resp.status_code == 200
        stored = client_redis.get(key)
        assert stored is not None and len(stored) == 6
        send_task.assert_called_once()

    def test_and_that_code_completes_the_sign_in(
        self, real_db, real_client, real_redis, no_rate_limit
    ):
        """The invited user's whole path through a real Redis and a real
        table: ask, read the code out of the pool the way the mail would,
        redeem it, get tokens."""
        session, created, _ = real_db
        client_redis, keys = real_redis
        user = _invited_row(session, created, _unique_email("invited"))
        key = f"magic_code:{user.email.lower()}"
        keys.append(key)

        with patch(_SEND_TASK):
            real_client.post("/auth/send-magic-code", json={"email": user.email})
        code = client_redis.get(key)

        with patch(_REQUIRE_2FA, return_value=False), \
             patch(_WINDOW_CLOSED, return_value=False):
            resp = real_client.post(
                "/auth/verify-magic-code",
                json={"email": user.email, "code": code},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["access_token"]
        assert body["needs_password"] is True
        # Spent, so it cannot be replayed.
        assert client_redis.get(key) is None

    def test_the_three_refusals_are_one_answer_against_a_real_redis(
        self, real_db, real_client, real_redis, no_rate_limit
    ):
        """The generic 401, with nothing patched between the endpoint and the
        code pool — so "identical" covers what the real Redis helpers would
        otherwise have said about each case."""
        session, created, _ = real_db
        client_redis, keys = real_redis

        unknown_email = _unique_email("nobody")
        deactivated = _invited_row(session, created, _unique_email("off"))
        deactivated.status = UserStatus.deactivated
        session.commit()
        active = _invited_row(session, created, _unique_email("on"))

        # A real code for the deactivated account, so its refusal is the
        # account's and not the code's.
        with patch(_SEND_TASK):
            real_client.post(
                "/auth/send-magic-code", json={"email": deactivated.email}
            )
        keys.append(f"magic_code:{deactivated.email.lower()}")
        real_code = client_redis.get(f"magic_code:{deactivated.email.lower()}")
        assert real_code

        answers = {
            _answer(real_client.post("/auth/verify-magic-code",
                                     json={"email": unknown_email, "code": "123456"})),
            _answer(real_client.post("/auth/verify-magic-code",
                                     json={"email": deactivated.email,
                                           "code": real_code})),
            _answer(real_client.post("/auth/verify-magic-code",
                                     json={"email": active.email, "code": "000000"})),
        }

        assert answers == {(401, json.dumps({"detail": VERIFY_MAGIC_CODE_REFUSED}))}
