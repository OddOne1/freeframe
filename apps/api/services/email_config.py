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
    smtp_use_tls: bool


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
