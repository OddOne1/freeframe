"""`smtp_use_tls=False` could not reach a plaintext SMTP server (§199).

`_send_via_smtp` branched on one boolean: True meant SMTP + STARTTLS, and
False meant `SMTP_SSL` — implicit TLS, not "no TLS". So the setting whose
name says "do not use TLS" was the one that guaranteed TLS, and an
unencrypted relay on a trusted network (a normal self-hosting arrangement)
was unreachable. It failed with "[SSL: WRONG_VERSION_NUMBER] wrong version
number", which reads like a certificate problem and is really the client
speaking TLS to a server that never offered it. Found by FilmBill running
this code against Mailpit; production has never been affected, because
Microsoft 365 is STARTTLS on 587.

Three modes now. The property tested hardest is NOT the new one — it is that
every stored configuration keeps doing exactly what it did before, because
this ships as a migration against a live install.
"""

from unittest.mock import MagicMock, patch

import pytest

from apps.api.services.email_config import (
    MailConfig,
    SMTP_SECURITY_IMPLICIT_TLS,
    SMTP_SECURITY_NONE,
    SMTP_SECURITY_STARTTLS,
    resolve_mail_config,
    smtp_security_from,
)
from apps.api.services.email_service import EmailService


def _config(**over):
    base = dict(
        provider="smtp",
        from_address="f@example.com",
        from_name="FreeFrame",
        aws_access_key_id=None,
        aws_secret_access_key=None,
        aws_region="eu-west-1",
        smtp_host="mail.example.com",
        smtp_port=587,
        smtp_user=None,
        smtp_password=None,
        smtp_use_tls=True,
        smtp_security=SMTP_SECURITY_STARTTLS,
    )
    base.update(over)
    return MailConfig(**base)


def _row(**over):
    """An EmailSettings row. A MagicMock would make every unset column a
    truthy object, which `_pick` reads as an override — so this is a plain
    object with real Nones."""
    fields = dict(
        mail_provider=None,
        mail_from_address=None,
        mail_from_name=None,
        aws_mail_access_key_id=None,
        aws_mail_secret_access_key_encrypted=None,
        aws_mail_region=None,
        smtp_host=None,
        smtp_port=None,
        smtp_user=None,
        smtp_password_encrypted=None,
        smtp_use_tls=None,
        smtp_security=None,
    )
    fields.update(over)
    return type("Row", (), fields)()


def _send(config):
    """Run one send against a stubbed smtplib and report which constructor
    was used and whether starttls() was called."""
    service = EmailService.__new__(EmailService)
    service.config = config
    service.provider = config.provider
    service.from_address = config.from_address
    service.from_name = config.from_name

    plain, implicit = MagicMock(), MagicMock()
    with patch("apps.api.services.email_service.smtplib.SMTP", plain), \
         patch("apps.api.services.email_service.smtplib.SMTP_SSL", implicit):
        ok = service._send_via_smtp("to@example.com", "s", "<p>b</p>")

    used_implicit = implicit.called
    server = implicit.return_value if used_implicit else plain.return_value
    return {
        "ok": ok,
        "implicit_tls": used_implicit,
        "plain_socket": plain.called,
        "starttls": server.starttls.called,
        "port": (implicit if used_implicit else plain).call_args[0][1],
    }


# ── the mapping, which is what makes this deployable ────────────────────────


class TestExistingConfigurationsAreUnchanged:
    def test_use_tls_true_maps_to_starttls(self):
        assert smtp_security_from(None, True) == SMTP_SECURITY_STARTTLS

    def test_use_tls_false_maps_to_implicit_tls_not_none(self):
        """Behaviour-preserving, not intention-preserving.

        `False` has always DONE implicit TLS, whatever its name suggested.
        Mapping it to "none" would silently switch off encryption for
        everyone currently on port 465 with the box unticked — a security
        regression introduced by a fix for a security-adjacent trap.
        """
        assert smtp_security_from(None, False) == SMTP_SECURITY_IMPLICIT_TLS

    @pytest.mark.parametrize(
        "mode",
        [SMTP_SECURITY_STARTTLS, SMTP_SECURITY_IMPLICIT_TLS, SMTP_SECURITY_NONE],
    )
    def test_an_explicit_mode_wins_over_the_boolean(self, mode):
        assert smtp_security_from(mode, True) == mode
        assert smtp_security_from(mode, False) == mode

    def test_an_unrecognised_stored_value_falls_back_to_starttls(self):
        """A typo in a column must not be the reason mail stops sending —
        the same reasoning load_mail_config applies to a DB it cannot read."""
        assert smtp_security_from("tls", True) == SMTP_SECURITY_STARTTLS
        assert smtp_security_from("", True) == SMTP_SECURITY_STARTTLS

    def test_a_row_with_neither_field_set_derives_from_the_env_boolean(self):
        with patch("apps.api.services.email_config.settings") as st:
            st.smtp_use_tls = False
            st.smtp_security = None
            st.smtp_port = 465
            resolved = resolve_mail_config(_row())

        assert resolved.smtp_security == SMTP_SECURITY_IMPLICIT_TLS

    def test_a_row_that_overrides_only_the_boolean_still_decides_the_mode(self):
        with patch("apps.api.services.email_config.settings") as st:
            st.smtp_use_tls = True
            st.smtp_security = None
            resolved = resolve_mail_config(_row(smtp_use_tls=False))

        assert resolved.smtp_security == SMTP_SECURITY_IMPLICIT_TLS

    def test_a_row_that_overrides_the_mode_wins_over_the_boolean(self):
        with patch("apps.api.services.email_config.settings") as st:
            st.smtp_use_tls = True
            st.smtp_security = None
            resolved = resolve_mail_config(
                _row(smtp_use_tls=True, smtp_security=SMTP_SECURITY_NONE)
            )

        assert resolved.smtp_security == SMTP_SECURITY_NONE

    def test_the_env_mode_applies_when_the_row_says_nothing(self):
        with patch("apps.api.services.email_config.settings") as st:
            st.smtp_use_tls = True
            st.smtp_security = SMTP_SECURITY_NONE
            resolved = resolve_mail_config(_row())

        assert resolved.smtp_security == SMTP_SECURITY_NONE


# ── what actually goes over the wire ────────────────────────────────────────


class TestTheTransportMatchesTheMode:
    def test_starttls_opens_a_plain_socket_and_upgrades(self):
        """Production's path: Microsoft 365 on 587. Unchanged by this work,
        which is the single most important thing to keep true."""
        r = _send(_config(smtp_security=SMTP_SECURITY_STARTTLS, smtp_port=587))

        assert r["plain_socket"] and not r["implicit_tls"]
        assert r["starttls"]
        assert r["port"] == 587
        assert r["ok"] is True

    def test_implicit_tls_opens_an_ssl_socket_and_does_not_upgrade(self):
        r = _send(_config(smtp_security=SMTP_SECURITY_IMPLICIT_TLS, smtp_port=465))

        assert r["implicit_tls"] and not r["plain_socket"]
        assert not r["starttls"]
        assert r["port"] == 465

    def test_none_opens_a_plain_socket_and_leaves_it_plain(self):
        """THE regression. Before this, no combination of settings could
        produce this connection at all."""
        r = _send(_config(smtp_security=SMTP_SECURITY_NONE, smtp_port=1025))

        assert r["plain_socket"] and not r["implicit_tls"]
        assert not r["starttls"]
        assert r["port"] == 1025
        assert r["ok"] is True

    def test_the_boolean_alone_no_longer_decides_anything(self):
        """`smtp_use_tls` is kept on MailConfig (it is what .env.prod holds
        and what the resolver derives from), but the transport reads only
        the resolved mode. A contradictory pair must not resurrect the old
        two-way branch."""
        r = _send(_config(smtp_security=SMTP_SECURITY_NONE, smtp_use_tls=True))

        assert not r["starttls"] and not r["implicit_tls"]

    def test_credentials_are_still_sent_on_every_mode(self):
        """Auth is orthogonal to encryption, and quietly dropping it on the
        new mode would be a silent authentication failure rather than a
        visible one."""
        for mode in (
            SMTP_SECURITY_STARTTLS,
            SMTP_SECURITY_IMPLICIT_TLS,
            SMTP_SECURITY_NONE,
        ):
            service = EmailService.__new__(EmailService)
            service.config = _config(
                smtp_security=mode, smtp_user="u", smtp_password="p"
            )
            service.provider = "smtp"
            service.from_address = "f@example.com"
            service.from_name = "FreeFrame"

            plain, implicit = MagicMock(), MagicMock()
            with patch("apps.api.services.email_service.smtplib.SMTP", plain), \
                 patch("apps.api.services.email_service.smtplib.SMTP_SSL", implicit):
                service._send_via_smtp("to@example.com", "s", "<p>b</p>")

            server = (implicit if implicit.called else plain).return_value
            server.login.assert_called_once_with("u", "p")

    def test_a_connection_failure_is_still_reported_as_False_not_raised(self):
        service = EmailService.__new__(EmailService)
        service.config = _config(smtp_security=SMTP_SECURITY_NONE)
        service.provider = "smtp"
        service.from_address = "f@example.com"
        service.from_name = "FreeFrame"

        with patch(
            "apps.api.services.email_service.smtplib.SMTP",
            side_effect=OSError("connection refused"),
        ):
            assert service._send_via_smtp("to@example.com", "s", "<p>b</p>") is False


# ── the admin endpoint ──────────────────────────────────────────────────────


class TestTheSettingsEndpointAcceptsTheMode:
    @pytest.mark.parametrize(
        "mode",
        [SMTP_SECURITY_STARTTLS, SMTP_SECURITY_IMPLICIT_TLS, SMTP_SECURITY_NONE],
    )
    def test_each_mode_is_stored(self, client, mock_db, test_user, auth_headers, mode):
        from apps.api.models.user import UserGlobalRole

        test_user.role = UserGlobalRole.superadmin
        row = _row()
        mock_db.first.return_value = row

        resp = client.patch(
            "/email-settings", json={"smtp_security": mode}, headers=auth_headers
        )

        assert resp.status_code == 200
        assert row.smtp_security == mode

    def test_an_unknown_mode_is_a_400_that_names_the_three(
        self, client, mock_db, test_user, auth_headers
    ):
        from apps.api.models.user import UserGlobalRole

        test_user.role = UserGlobalRole.superadmin
        mock_db.first.return_value = _row()

        resp = client.patch(
            "/email-settings", json={"smtp_security": "tls"}, headers=auth_headers
        )

        assert resp.status_code == 400
        detail = resp.json()["detail"]
        for mode in (
            SMTP_SECURITY_STARTTLS,
            SMTP_SECURITY_IMPLICIT_TLS,
            SMTP_SECURITY_NONE,
        ):
            assert mode in detail

    def test_an_empty_string_clears_the_override_rather_than_failing(
        self, client, mock_db, test_user, auth_headers
    ):
        """Empty means "stop overriding, fall back to the environment" — the
        same convention every other plain field in this router follows. It
        must not be caught by the validation above."""
        from apps.api.models.user import UserGlobalRole

        test_user.role = UserGlobalRole.superadmin
        row = _row(smtp_security=SMTP_SECURITY_NONE)
        mock_db.first.return_value = row

        resp = client.patch(
            "/email-settings", json={"smtp_security": ""}, headers=auth_headers
        )

        assert resp.status_code == 200
        assert row.smtp_security is None

    def test_the_response_reports_both_stored_and_effective(
        self, client, mock_db, test_user, auth_headers
    ):
        """An empty stored value must not read as "no encryption" when the
        real answer is "STARTTLS, by default"."""
        from apps.api.models.user import UserGlobalRole

        test_user.role = UserGlobalRole.superadmin
        mock_db.first.return_value = _row()

        body = client.get("/email-settings", headers=auth_headers).json()

        assert body["smtp_security"] is None
        assert body["effective_smtp_security"] in (
            SMTP_SECURITY_STARTTLS,
            SMTP_SECURITY_IMPLICIT_TLS,
        )
