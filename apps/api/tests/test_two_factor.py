"""Two-factor authentication (§191).

The property the whole design rests on: a `2fa_pending` token is useless
anywhere except the 2FA completion endpoints. That is not new code — the
existing middleware already rejects any token whose `type` is not exactly
"access" — which is precisely why it is asserted here rather than assumed.

The other thing worth stating up front: an install that has not turned this
on must log in exactly as it did before. That is regression-tested first,
because it is the failure that would be noticed by everyone rather than by
the few people enrolled.
"""
import uuid
from unittest.mock import MagicMock, patch

import pyotp
import pytest

from apps.api.models.user import UserStatus
from apps.api.services import totp_service
from apps.api.services.auth_service import (
    create_2fa_pending_token,
    create_access_token,
    create_refresh_token,
    decode_2fa_pending_token,
)

_VERIFY_PATCH = "apps.api.routers.auth.verify_password"
_REQUIRE_2FA_PATCH = "apps.api.routers.auth.require_2fa_enabled"


def _user(
    *, two_factor_enabled=False, secret=None, backup=None, email="u@example.com",
    method=None,
):
    u = MagicMock()
    u.id = uuid.uuid4()
    u.email = email
    u.password_hash = "$2b$12$fake"
    u.status = UserStatus.active
    u.deleted_at = None
    u.two_factor_enabled = two_factor_enabled
    u.totp_secret_encrypted = totp_service.encrypt_secret(secret) if secret else None
    u.backup_codes_hashed = backup
    # §194 — set explicitly, never left as a MagicMock attribute: it is
    # serialised against Literal["totp", "email"], so a stray mock object
    # here fails the response rather than the assertion under test. An
    # enrolled user always has one, which is the invariant confirm-setup and
    # the migration's backfill both maintain.
    u.two_factor_method = method or ("totp" if two_factor_enabled else None)
    return u


def _login(client, mock_db, user, *, require_2fa=False):
    mock_db.first.return_value = user
    with patch(_VERIFY_PATCH, return_value=True), \
         patch(_REQUIRE_2FA_PATCH, return_value=require_2fa):
        return client.post(
            "/auth/login", json={"email": user.email, "password": "pw123456"}
        )


# ── the install that has NOT turned this on ─────────────────────────────────

class TestNothingChangesUntilItIsTurnedOn:
    def test_login_is_exactly_as_before(self, client, mock_db):
        """The regression that would hit everyone, not just the enrolled."""
        resp = _login(client, mock_db, _user(), require_2fa=False)

        assert resp.status_code == 200
        body = resp.json()
        assert "access_token" in body and "refresh_token" in body
        assert body["requires_2fa"] is False
        assert "pending_token" not in body

    def test_a_wrong_password_is_still_just_a_401(self, client, mock_db):
        mock_db.first.return_value = _user()
        with patch(_VERIFY_PATCH, return_value=False), \
             patch(_REQUIRE_2FA_PATCH, return_value=False):
            resp = client.post(
                "/auth/login", json={"email": "u@example.com", "password": "wrong"}
            )

        assert resp.status_code == 401
        assert "pending_token" not in resp.json()

    def test_the_site_default_is_off(self):
        """A deployment that upgrades into this feature must not change
        behaviour until an admin decides."""
        from apps.api.models.site_settings import SiteSettings

        col = SiteSettings.__table__.c.require_2fa
        assert str(col.server_default.arg) == "false"
        assert col.nullable is False

    def test_no_user_starts_enrolled(self):
        from apps.api.models.user import User

        assert str(User.__table__.c.two_factor_enabled.server_default.arg) == "false"


# ── the three branches of /auth/login ───────────────────────────────────────

class TestLoginBranches:
    def test_an_enrolled_user_gets_a_pending_token_and_no_real_ones(self, client, mock_db):
        resp = _login(client, mock_db, _user(two_factor_enabled=True), require_2fa=False)

        body = resp.json()
        assert body["requires_2fa"] is True
        assert body["setup_required"] is False
        assert body["pending_token"]
        # The property that makes the union safe: not null tokens, ABSENT
        # ones. A client reaching for access_token fails where the mistake
        # is instead of storing "null".
        assert "access_token" not in body
        assert "refresh_token" not in body

    def test_enrolment_is_forced_not_refused_when_the_admin_turns_it_on(self, client, mock_db):
        """Locking everyone out the moment the switch flips would make the
        switch unusable."""
        resp = _login(client, mock_db, _user(two_factor_enabled=False), require_2fa=True)

        body = resp.json()
        assert resp.status_code == 200
        assert body["requires_2fa"] is True
        assert body["setup_required"] is True
        assert "access_token" not in body

    def test_an_enrolled_user_is_still_asked_even_if_the_site_setting_is_off(
        self, client, mock_db
    ):
        """Turning the instance-wide requirement off must not silently
        downgrade someone who chose 2FA for themselves."""
        resp = _login(client, mock_db, _user(two_factor_enabled=True), require_2fa=False)

        assert resp.json()["requires_2fa"] is True

    def test_the_discriminator_is_present_in_BOTH_arms(self, client, mock_db):
        """One field to branch on. A discriminator that only appears in one
        arm is one a careless client reads as undefined and treats as false
        by accident rather than by decision."""
        plain = _login(client, mock_db, _user(), require_2fa=False).json()
        pending = _login(client, mock_db, _user(two_factor_enabled=True)).json()

        assert plain["requires_2fa"] is False
        assert pending["requires_2fa"] is True


# ── the pending token cannot do anything else ───────────────────────────────

class TestThePendingTokenIsInert:
    def test_it_is_rejected_by_get_current_user(self, client, mock_db):
        """The whole design leans on this. It costs no new code — the
        middleware already demands type == "access" — so it is asserted
        rather than trusted."""
        token = create_2fa_pending_token(str(uuid.uuid4()))

        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code == 401

    @pytest.mark.parametrize("path", ["/auth/me", "/projects"])
    def test_it_reaches_no_authenticated_endpoint(self, client, mock_db, path):
        """Endpoints that REQUIRE a session. /site-settings is deliberately
        public (it backs the login page's branding) so it is not a useful
        case here — being reachable proves nothing either way."""
        token = create_2fa_pending_token(str(uuid.uuid4()))

        resp = client.get(path, headers={"Authorization": f"Bearer {token}"})

        assert resp.status_code in (401, 403)

    def test_it_carries_its_own_type_claim(self):
        token = create_2fa_pending_token("abc")
        assert decode_2fa_pending_token(token) == "abc"

    def test_an_access_token_is_NOT_accepted_as_a_pending_one(self):
        """Without this check a live session would satisfy the second factor
        for a login it was never part of."""
        assert decode_2fa_pending_token(create_access_token("abc")) is None
        assert decode_2fa_pending_token(create_refresh_token("abc")) is None

    def test_garbage_is_rejected_rather_than_raising(self):
        assert decode_2fa_pending_token("not-a-token") is None
        assert decode_2fa_pending_token("") is None


# ── TOTP, against the real library ──────────────────────────────────────────

class TestTotp:
    def test_a_real_pyotp_code_verifies(self):
        """Generated with the same library at the same secret — not just a
        check that the function returns a boolean."""
        secret = totp_service.generate_totp_secret()
        code = pyotp.TOTP(secret).now()

        assert totp_service.verify_totp_code(secret, code) is True

    def test_a_code_for_a_different_secret_does_not(self):
        code = pyotp.TOTP(totp_service.generate_totp_secret()).now()

        assert totp_service.verify_totp_code(totp_service.generate_totp_secret(), code) is False

    def test_spaces_and_padding_are_tolerated(self):
        """People read these off a phone and type them with a space."""
        secret = totp_service.generate_totp_secret()
        code = pyotp.TOTP(secret).now()

        assert totp_service.verify_totp_code(secret, f" {code[:3]} {code[3:]} ") is True

    @pytest.mark.parametrize("bad", ["", "000000", "abcdef", None])
    def test_rubbish_fails_without_raising(self, bad):
        secret = totp_service.generate_totp_secret()
        assert totp_service.verify_totp_code(secret, bad or "") is False

    def test_no_secret_never_verifies(self):
        assert totp_service.verify_totp_code(None, "123456") is False

    def test_the_provisioning_uri_is_scannable_and_carries_the_issuer(self):
        secret = totp_service.generate_totp_secret()
        uri = totp_service.totp_provisioning_uri(secret, "a@b.com", issuer="Acme Studio")

        assert uri.startswith("otpauth://totp/")
        assert "Acme%20Studio" in uri or "Acme+Studio" in uri
        assert secret in uri

    def test_the_qr_is_a_png_data_uri(self):
        """Rendered server-side so the secret never reaches a third-party
        QR service."""
        uri = totp_service.totp_provisioning_uri(
            totp_service.generate_totp_secret(), "a@b.com"
        )
        data = totp_service.qr_code_data_uri(uri)

        assert data.startswith("data:image/png;base64,")
        assert len(data) > 200


# ── encrypted at rest ───────────────────────────────────────────────────────

class TestTheSecretIsNotStoredInPlaintext:
    def test_the_stored_value_is_not_the_secret(self):
        """Asserted against the value that would go in the column, which is
        the only thing that matters — a 'we encrypt it' comment is not a
        test."""
        secret = totp_service.generate_totp_secret()

        stored = totp_service.encrypt_secret(secret)

        assert stored != secret
        assert secret not in stored

    def test_it_round_trips(self):
        secret = totp_service.generate_totp_secret()
        assert totp_service.decrypt_secret(totp_service.encrypt_secret(secret)) == secret

    def test_two_encryptions_of_one_secret_differ(self):
        """Fernet is randomised; identical ciphertext would leak that two
        users share a secret."""
        secret = totp_service.generate_totp_secret()

        assert totp_service.encrypt_secret(secret) != totp_service.encrypt_secret(secret)

    def test_an_undecryptable_value_returns_None_rather_than_raising(self):
        """Which is what a rotated jwt_secret looks like. The useful outcome
        is 'this user must re-enrol', not a 500 on every login."""
        assert totp_service.decrypt_secret("not-a-fernet-token") is None
        assert totp_service.decrypt_secret(None) is None

    def test_the_key_is_not_the_jwt_secret_itself(self):
        """HKDF with domain separation, so neither key can be used to attack
        the other."""
        import inspect

        src = inspect.getsource(totp_service._fernet)
        assert "HKDF" in src
        assert "_HKDF_INFO" in src


# ── backup codes ────────────────────────────────────────────────────────────

class TestBackupCodes:
    def test_ten_are_issued(self):
        assert len(totp_service.generate_backup_codes()) == 10

    def test_they_are_all_different(self):
        assert len(set(totp_service.generate_backup_codes())) == 10

    def test_they_are_stored_hashed_not_plaintext(self):
        codes = totp_service.generate_backup_codes()

        hashed = totp_service.hash_backup_codes(codes)

        assert all(c not in h for c, h in zip(codes, hashed))
        assert all(h.startswith("$2") for h in hashed)

    def test_one_verifies(self):
        codes = totp_service.generate_backup_codes()
        hashed = totp_service.hash_backup_codes(codes)

        ok, remaining = totp_service.consume_backup_code(hashed, codes[3])

        assert ok is True
        assert len(remaining) == 9

    def test_using_one_SPENDS_it(self):
        """Single use is the whole point. A code that verified but stayed in
        the list would be a permanent password."""
        codes = totp_service.generate_backup_codes()
        hashed = totp_service.hash_backup_codes(codes)

        _ok, remaining = totp_service.consume_backup_code(hashed, codes[0])
        second, _ = totp_service.consume_backup_code(remaining, codes[0])

        assert second is False

    def test_the_others_still_work_afterwards(self):
        codes = totp_service.generate_backup_codes()
        hashed = totp_service.hash_backup_codes(codes)

        _ok, remaining = totp_service.consume_backup_code(hashed, codes[0])

        assert totp_service.consume_backup_code(remaining, codes[1])[0] is True

    def test_case_and_dashes_are_forgiven(self):
        """These get retyped off a screenshot or a printout."""
        codes = totp_service.generate_backup_codes()
        hashed = totp_service.hash_backup_codes(codes)
        messy = codes[0].lower().replace("-", " ")

        assert totp_service.consume_backup_code(hashed, messy)[0] is True

    def test_an_unknown_code_changes_nothing(self):
        hashed = totp_service.hash_backup_codes(totp_service.generate_backup_codes())

        ok, remaining = totp_service.consume_backup_code(hashed, "ZZZZ-ZZZZ")

        assert ok is False and len(remaining) == 10

    def test_no_codes_at_all_is_not_a_crash(self):
        assert totp_service.consume_backup_code(None, "ABCD-EFGH") == (False, [])


# ── the email fallback has its OWN everything ───────────────────────────────

class TestEmailFallbackIsSeparateFromMagicCode:
    def test_it_uses_a_different_redis_key(self):
        """A magic code is a FULL login. Accepting one as a second factor
        would collapse 2FA back to single-factor, and sharing the key would
        let either overwrite the other's pending code."""
        from apps.api.services import redis_service as rs

        assert rs.TWOFA_EMAIL_CODE_PREFIX != rs.MAGIC_CODE_PREFIX
        assert rs.TWOFA_EMAIL_ATTEMPTS_PREFIX != rs.MAGIC_CODE_ATTEMPTS_PREFIX

    def test_it_uses_a_different_rate_limit_bucket(self):
        """Buckets are keyed (ip, action), so a distinct action string is a
        distinct allowance. A 2FA-locked-out user hammering this must not
        drain the passwordless-login allowance, or vice versa."""
        import inspect

        from apps.api.routers import auth as auth_router

        src = inspect.getsource(auth_router)
        assert 'rate_limit("send_2fa_email_fallback"' in src
        assert 'rate_limit("send_magic_code"' in src

    def test_the_email_says_something_different(self):
        """'Here is your login code' and 'you could not reach your
        authenticator' mean different things to the person reading them."""
        import inspect

        from apps.api.tasks import email_tasks

        src = inspect.getsource(email_tasks.send_magic_code_email)
        assert 'purpose == "two_factor"' in src


# ── completing a login ──────────────────────────────────────────────────────

class TestVerifyLogin:
    def _post(self, client, mock_db, user, code, token=None):
        mock_db.first.return_value = user
        return client.post(
            "/auth/2fa/verify-login",
            json={
                "pending_token": token or create_2fa_pending_token(str(user.id)),
                "code": code,
            },
        )

    def test_a_correct_totp_code_completes_the_login(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        user = _user(two_factor_enabled=True, secret=secret)

        resp = self._post(client, mock_db, user, pyotp.TOTP(secret).now())

        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_a_wrong_code_is_401(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        user = _user(two_factor_enabled=True, secret=secret)

        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(False, "")):
            resp = self._post(client, mock_db, user, "000000")

        assert resp.status_code == 401

    def test_the_failure_does_not_say_WHICH_factor_failed(self, client, mock_db):
        """Saying so would confirm whether a fallback code had been sent."""
        user = _user(two_factor_enabled=True, secret=totp_service.generate_totp_secret())

        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(False, "")):
            resp = self._post(client, mock_db, user, "000000")

        assert resp.json()["detail"] == "Invalid code"

    def test_a_backup_code_completes_the_login_too(self, client, mock_db):
        codes = totp_service.generate_backup_codes()
        user = _user(
            two_factor_enabled=True,
            secret=totp_service.generate_totp_secret(),
            backup=totp_service.hash_backup_codes(codes),
        )

        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(False, "")):
            resp = self._post(client, mock_db, user, codes[0])

        assert resp.status_code == 200
        assert "access_token" in resp.json()

    def test_a_spent_backup_code_is_persisted_as_spent(self, client, mock_db):
        codes = totp_service.generate_backup_codes()
        user = _user(
            two_factor_enabled=True,
            secret=totp_service.generate_totp_secret(),
            backup=totp_service.hash_backup_codes(codes),
        )

        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(False, "")):
            self._post(client, mock_db, user, codes[0])

        assert len(user.backup_codes_hashed) == 9
        mock_db.commit.assert_called()

    def test_an_emailed_fallback_code_completes_the_login(self, client, mock_db):
        user = _user(two_factor_enabled=True, secret=totp_service.generate_totp_secret())

        with patch("apps.api.routers.auth.verify_2fa_email_code", return_value=(True, "")):
            resp = self._post(client, mock_db, user, "123456")

        assert resp.status_code == 200

    def test_a_user_who_never_enrolled_cannot_redeem_a_pending_token_here(
        self, client, mock_db
    ):
        """A forced-setup pending token must go through confirm-setup, which
        actually enrols them. Otherwise 'enforcement on' would be satisfiable
        by anyone who never enrolled."""
        user = _user(two_factor_enabled=False)

        resp = self._post(client, mock_db, user, "123456")

        assert resp.status_code == 401

    def test_an_access_token_cannot_be_used_as_the_pending_token(self, client, mock_db):
        user = _user(two_factor_enabled=True, secret=totp_service.generate_totp_secret())

        resp = self._post(
            client, mock_db, user, "123456", token=create_access_token(str(user.id))
        )

        assert resp.status_code == 401

    def test_a_deactivated_account_cannot_complete_a_login(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        user = _user(two_factor_enabled=True, secret=secret)
        user.status = UserStatus.deactivated

        resp = self._post(client, mock_db, user, pyotp.TOTP(secret).now())

        assert resp.status_code == 401


# ── enrolment ───────────────────────────────────────────────────────────────

class TestSetupAndConfirm:
    def test_setup_stores_a_secret_but_does_NOT_enable_2fa(self, client, mock_db):
        """An abandoned setup must not lock someone out of their own
        account."""
        user = _user()
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/setup",
            json={"pending_token": create_2fa_pending_token(str(user.id))},
        )

        assert resp.status_code == 200
        assert user.totp_secret_encrypted is not None
        assert user.two_factor_enabled is False

    def test_setup_returns_everything_a_client_needs_to_draw_the_screen(
        self, client, mock_db
    ):
        user = _user()
        mock_db.first.return_value = user

        body = client.post(
            "/auth/2fa/setup",
            json={"pending_token": create_2fa_pending_token(str(user.id))},
        ).json()

        assert body["provisioning_uri"].startswith("otpauth://")
        assert body["qr_code_data_uri"].startswith("data:image/png;base64,")
        assert body["secret"]

    def test_setup_needs_a_session_or_a_pending_token(self, client, mock_db):
        resp = client.post("/auth/2fa/setup", json={})
        assert resp.status_code == 401

    def test_confirm_enables_2fa_and_returns_backup_codes_once(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        user = _user(secret=secret)
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": pyotp.TOTP(secret).now(),
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        body = resp.json()
        assert resp.status_code == 200
        assert user.two_factor_enabled is True
        assert len(body["backup_codes"]) == 10
        # Stored hashed, never readable again.
        assert all(c not in str(user.backup_codes_hashed) for c in body["backup_codes"])

    def test_confirm_via_a_forced_login_hands_back_real_tokens(self, client, mock_db):
        secret = totp_service.generate_totp_secret()
        user = _user(secret=secret)
        mock_db.first.return_value = user

        body = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": pyotp.TOTP(secret).now(),
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        ).json()

        assert body["tokens"] is not None
        assert body["tokens"]["access_token"]

    def test_a_wrong_code_does_not_enable_2fa(self, client, mock_db):
        user = _user(secret=totp_service.generate_totp_secret())
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": "000000",
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        assert resp.status_code == 401
        assert user.two_factor_enabled is False

    def test_confirm_accepts_ONLY_the_authenticator(self, client, mock_db):
        """A backup code proves nothing about whether the app the user just
        configured actually works, which is the one thing this step checks."""
        codes = totp_service.generate_backup_codes()
        user = _user(
            secret=totp_service.generate_totp_secret(),
            backup=totp_service.hash_backup_codes(codes),
        )
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": codes[0],
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        assert resp.status_code == 401
        assert user.two_factor_enabled is False

    def test_confirming_without_ever_starting_setup_is_a_400(self, client, mock_db):
        user = _user()
        user.totp_secret_encrypted = None
        mock_db.first.return_value = user

        resp = client.post(
            "/auth/2fa/confirm-setup",
            json={
                "code": "123456",
                "pending_token": create_2fa_pending_token(str(user.id)),
            },
        )

        assert resp.status_code == 400


class TestEmailFallbackEndpoint:
    def test_it_sends_for_an_enrolled_user(self, client, mock_db):
        user = _user(two_factor_enabled=True, secret=totp_service.generate_totp_secret())
        mock_db.first.return_value = user

        with patch("apps.api.routers.auth.store_2fa_email_code") as store, \
             patch("apps.api.routers.auth.send_task_safe") as send:
            resp = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(user.id))},
            )

        assert resp.status_code == 200
        store.assert_called_once()
        send.assert_called_once()

    def test_it_says_the_same_thing_for_a_user_who_is_not_enrolled(self, client, mock_db):
        """Whether an account has 2FA is not something an unauthenticated
        caller learns from this endpoint."""
        enrolled = _user(two_factor_enabled=True, secret=totp_service.generate_totp_secret())
        mock_db.first.return_value = enrolled
        with patch("apps.api.routers.auth.store_2fa_email_code"), \
             patch("apps.api.routers.auth.send_task_safe"):
            yes = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(enrolled.id))},
            )

        plain = _user(two_factor_enabled=False)
        mock_db.first.return_value = plain
        with patch("apps.api.routers.auth.store_2fa_email_code") as store:
            no = client.post(
                "/auth/2fa/send-email-fallback",
                json={"pending_token": create_2fa_pending_token(str(plain.id))},
            )

        assert yes.status_code == no.status_code == 200
        assert yes.json() == no.json()
        store.assert_not_called()

    def test_it_refuses_a_bad_pending_token(self, client, mock_db):
        resp = client.post(
            "/auth/2fa/send-email-fallback", json={"pending_token": "garbage"}
        )
        assert resp.status_code == 401
