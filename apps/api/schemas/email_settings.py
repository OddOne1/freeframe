from typing import Optional

from pydantic import BaseModel


class EmailSettingsResponse(BaseModel):
    """What the admin form reads.

    Note what is absent: the secrets themselves. They are reported only as
    `*_set` booleans, so a stored SMTP password never leaves the server
    even for an authenticated superadmin — matching the write-only
    convention the profile page's own password field already uses.
    """
    mail_provider: Optional[str] = None
    mail_from_address: Optional[str] = None
    mail_from_name: Optional[str] = None

    aws_mail_access_key_id: Optional[str] = None
    aws_mail_secret_access_key_set: bool = False
    aws_mail_region: Optional[str] = None

    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password_set: bool = False
    smtp_use_tls: Optional[bool] = None
    #: §199 — what is STORED ("starttls"/"implicit_tls"/"none", or null when
    #: the mode has never been set explicitly).
    smtp_security: Optional[str] = None
    #: And what would actually be used right now, after the env fallback and
    #: the smtp_use_tls derivation. Reported separately for the same reason
    #: `effective_smtp_host` is: an empty box must not look like "no
    #: encryption" when the answer is really "STARTTLS, by default".
    effective_smtp_security: Optional[str] = None

    # What the service would actually use right now, after DB-over-env
    # precedence is applied. Lets the form show "currently smtp via
    # mail.example.com (from environment)" instead of an empty box that
    # looks like nothing is configured.
    effective_provider: Optional[str] = None
    effective_from_address: Optional[str] = None
    effective_smtp_host: Optional[str] = None
    # True when the value in play comes from .env rather than this table.
    using_env_fallback: bool = True


class EmailSettingsUpdate(BaseModel):
    """Every field optional; only what's explicitly sent is written.

    Secrets have their own rule (see the router): a blank or omitted secret
    leaves the stored value untouched rather than clearing it, so a form
    re-submit can't wipe a working credential. Clearing is explicit, via
    the dedicated *_clear flags.
    """
    mail_provider: Optional[str] = None
    mail_from_address: Optional[str] = None
    mail_from_name: Optional[str] = None

    aws_mail_access_key_id: Optional[str] = None
    aws_mail_secret_access_key: Optional[str] = None
    aws_mail_region: Optional[str] = None

    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = None
    #: §199 — "starttls" | "implicit_tls" | "none". Validated in the router
    #: rather than as a Literal here so an unknown value is a 400 naming the
    #: three modes, not a schema error naming a type.
    smtp_security: Optional[str] = None

    # Explicit opt-in to drop a stored secret and fall back to the env var.
    smtp_password_clear: bool = False
    aws_mail_secret_access_key_clear: bool = False


class TestEmailRequest(BaseModel):
    to_email: str


class TestEmailResponse(BaseModel):
    success: bool
    detail: str
