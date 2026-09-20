"""Resolves effective mail configuration: DB overrides, env fallback.

Precedence is per-field, not all-or-nothing. An admin who only wants to
change the SMTP password should get exactly that, with host/port/user still
coming from .env.prod. An all-or-nothing rule would silently blank the rest
the moment they saved one field.

A null column means "not overridden" — which is why every column on
EmailSettings is nullable and there is no backfill in the migration.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from ..config import settings
from ..services.secrets_service import decrypt_secret

logger = logging.getLogger(__name__)


#: How the SMTP connection is encrypted (§199). Three modes, because there
#: are three real arrangements and the old boolean could only express two.
#:
#:   "starttls"     — connect in the clear on the given port (587, usually)
#:                    and upgrade with STARTTLS. The default, and what
#:                    Microsoft 365 uses, so production is on this path.
#:   "implicit_tls" — the connection is TLS from the first byte. Port 465.
#:   "none"         — no encryption at all. A plaintext relay on a trusted
#:                    network, which is a normal self-hosting arrangement.
#:
#: The boolean this replaces read False as "implicit TLS", so there was NO
#: way to reach an unencrypted server: `smtp_use_tls=False` opened an
#: SMTP_SSL connection and died with "[SSL: WRONG_VERSION_NUMBER] wrong
#: version number" — which reads like a certificate problem and is in fact
#: the client speaking TLS to a server that never offered it. Found by
#: FilmBill running this code against Mailpit.
SMTP_SECURITY_STARTTLS = "starttls"
SMTP_SECURITY_IMPLICIT_TLS = "implicit_tls"
SMTP_SECURITY_NONE = "none"
SMTP_SECURITY_MODES = (
    SMTP_SECURITY_STARTTLS,
    SMTP_SECURITY_IMPLICIT_TLS,
    SMTP_SECURITY_NONE,
)


def smtp_security_from(explicit, use_tls: bool) -> str:
    """The effective mode, from an explicit setting or the legacy boolean.

    **The mapping is deliberately behaviour-preserving, not
    intention-preserving.** `smtp_use_tls=False` becomes "implicit_tls",
    which is what it has always DONE, rather than "none", which is what its
    name suggests it was for. Anyone currently sending mail through port 465
    with the box unticked keeps sending mail after this deploy; the new
    "none" mode is reachable only by choosing it, so nobody's encryption is
    silently switched off either.

    An unrecognised stored value falls back to STARTTLS rather than raising —
    a mail send failing because a column held a typo would be a worse
    outcome than using the default, and it is the same reasoning
    load_mail_config already applies to a DB it cannot read.
    """
    if explicit in SMTP_SECURITY_MODES:
        return explicit
    return SMTP_SECURITY_STARTTLS if use_tls else SMTP_SECURITY_IMPLICIT_TLS


@dataclass(frozen=True)
class MailConfig:
    provider: str
    from_address: str
    from_name: str
    aws_access_key_id: Optional[str]
    aws_secret_access_key: Optional[str]
    aws_region: str
    smtp_host: Optional[str]
    smtp_port: int
    smtp_user: Optional[str]
    smtp_password: Optional[str]
    #: Kept alongside `smtp_security` rather than replaced by it: it is still
    #: what the admin form and .env.prod hold today, and the resolver needs
    #: it to derive a mode for a row that has none.
    smtp_use_tls: bool
    smtp_security: str


def _pick(db_value, env_value):
    """DB wins when set; env otherwise. None (and only None) means unset —
    an empty string is treated as unset too, since that's what an emptied
    form field produces."""
    if db_value is None:
        return env_value
    if isinstance(db_value, str) and db_value.strip() == "":
        return env_value
    return db_value


def resolve_mail_config(row) -> MailConfig:
    """Merge an EmailSettings row (or None) over the env-var settings."""
    if row is None:
        return MailConfig(
            provider=settings.mail_provider,
            from_address=settings.mail_from_address,
            from_name=settings.mail_from_name,
            aws_access_key_id=settings.aws_mail_access_key_id,
            aws_secret_access_key=settings.aws_mail_secret_access_key,
            aws_region=settings.aws_mail_region,
            smtp_host=settings.smtp_host,
            smtp_port=settings.smtp_port,
            smtp_user=settings.smtp_user,
            smtp_password=settings.smtp_password,
            smtp_use_tls=settings.smtp_use_tls,
            smtp_security=smtp_security_from(
                settings.smtp_security, settings.smtp_use_tls
            ),
        )

    # decrypt_secret returns None if jwt_secret changed since the value was
    # stored, which correctly degrades this field to the env fallback rather
    # than to an empty password.
    return MailConfig(
        provider=_pick(row.mail_provider, settings.mail_provider),
        from_address=_pick(row.mail_from_address, settings.mail_from_address),
        from_name=_pick(row.mail_from_name, settings.mail_from_name),
        aws_access_key_id=_pick(row.aws_mail_access_key_id, settings.aws_mail_access_key_id),
        aws_secret_access_key=_pick(
            decrypt_secret(row.aws_mail_secret_access_key_encrypted),
            settings.aws_mail_secret_access_key,
        ),
        aws_region=_pick(row.aws_mail_region, settings.aws_mail_region),
        smtp_host=_pick(row.smtp_host, settings.smtp_host),
        smtp_port=_pick(row.smtp_port, settings.smtp_port),
        smtp_user=_pick(row.smtp_user, settings.smtp_user),
        smtp_password=_pick(
            decrypt_secret(row.smtp_password_encrypted),
            settings.smtp_password,
        ),
        # Bool needs care: False is a legitimate override, so only None
        # falls through to the env value.
        smtp_use_tls=settings.smtp_use_tls if row.smtp_use_tls is None else row.smtp_use_tls,
        # §199 — resolved from the SAME per-field precedence the two inputs
        # above went through, not from the row alone: an admin who set only
        # the boolean and an admin who set only the mode should both get the
        # mode they meant.
        smtp_security=smtp_security_from(
            _pick(row.smtp_security, settings.smtp_security),
            settings.smtp_use_tls if row.smtp_use_tls is None else row.smtp_use_tls,
        ),
    )


def load_mail_config() -> MailConfig:
    """Read the singleton and resolve. Opens its own short-lived session —
    callers are Celery workers and request handlers alike.

    Any DB problem degrades to pure-env config rather than raising: a mail
    send failing because the settings table was briefly unreachable would
    be a worse outcome than using the environment defaults.
    """
    try:
        from ..database import SessionLocal
        from ..models.email_settings import EmailSettings

        db = SessionLocal()
        try:
            row = db.query(EmailSettings).first()
            return resolve_mail_config(row)
        finally:
            db.close()
    except Exception:
        logger.warning("Could not read email settings; using environment configuration", exc_info=True)
        return resolve_mail_config(None)
