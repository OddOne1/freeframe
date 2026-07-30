"""Superadmin-only mail configuration.

**No public read path, by design.** This is the whole reason these fields
don't live on SiteSettings: `GET /site-settings` is unauthenticated (it
backs login-page branding), and a route that was never meant to carry
secrets must never start carrying them. Both endpoints here go through
`require_admin`.
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.user import User
from ..models.email_settings import EmailSettings
from ..schemas.email_settings import (
    EmailSettingsResponse,
    EmailSettingsUpdate,
    TestEmailRequest,
    TestEmailResponse,
)
from ..services.secrets_service import encrypt_secret
from ..services.email_config import resolve_mail_config
from .users import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(tags=["email-settings"])

# Plain (non-secret) columns that a PATCH may write directly. Secrets are
# handled separately below — they must never be blanked by an omitted or
# empty form field.
PLAIN_FIELDS = (
    "mail_provider",
    "mail_from_address",
    "mail_from_name",
    "aws_mail_access_key_id",
    "aws_mail_region",
    "smtp_host",
    "smtp_port",
    "smtp_user",
    "smtp_use_tls",
)


def _get_or_create(db: Session) -> EmailSettings:
    row = db.query(EmailSettings).first()
    if not row:
        row = EmailSettings()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _to_response(row: EmailSettings) -> EmailSettingsResponse:
    effective = resolve_mail_config(row)
    # "Using env fallback" is judged on the fields that actually decide
    # where mail goes, not on cosmetic ones like from-name.
    overridden = any(
        getattr(row, f) is not None
        for f in ("mail_provider", "mail_from_address", "smtp_host", "aws_mail_access_key_id")
    ) or row.smtp_password_encrypted is not None or row.aws_mail_secret_access_key_encrypted is not None

    return EmailSettingsResponse(
        mail_provider=row.mail_provider,
        mail_from_address=row.mail_from_address,
        mail_from_name=row.mail_from_name,
        aws_mail_access_key_id=row.aws_mail_access_key_id,
        aws_mail_secret_access_key_set=bool(row.aws_mail_secret_access_key_encrypted),
        aws_mail_region=row.aws_mail_region,
        smtp_host=row.smtp_host,
        smtp_port=row.smtp_port,
        smtp_user=row.smtp_user,
        smtp_password_set=bool(row.smtp_password_encrypted),
        smtp_use_tls=row.smtp_use_tls,
        effective_provider=effective.provider,
        effective_from_address=effective.from_address,
        effective_smtp_host=effective.smtp_host,
        using_env_fallback=not overridden,
    )


@router.get("/email-settings", response_model=EmailSettingsResponse)
def get_email_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return _to_response(_get_or_create(db))


@router.patch("/email-settings", response_model=EmailSettingsResponse)
def update_email_settings(
    body: EmailSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    row = _get_or_create(db)
    fields_set = body.model_fields_set

    for field in PLAIN_FIELDS:
        if field in fields_set:
            value = getattr(body, field)
            # Empty string means "clear this override, fall back to env" —
            # distinct from not sending the field at all, which leaves it be.
            if isinstance(value, str) and value.strip() == "":
                value = None
            setattr(row, field, value)

    if body.mail_provider is not None and body.mail_provider not in ("ses", "smtp"):
        raise HTTPException(status_code=400, detail="mail_provider must be 'ses' or 'smtp'")

    # Secrets: only overwrite on a real non-empty value, or clear on the
    # explicit flag. A form that re-submits an empty password box must not
    # destroy a working credential.
    if body.smtp_password_clear:
        row.smtp_password_encrypted = None
    elif body.smtp_password and body.smtp_password.strip():
        row.smtp_password_encrypted = encrypt_secret(body.smtp_password)

    if body.aws_mail_secret_access_key_clear:
        row.aws_mail_secret_access_key_encrypted = None
    elif body.aws_mail_secret_access_key and body.aws_mail_secret_access_key.strip():
        row.aws_mail_secret_access_key_encrypted = encrypt_secret(body.aws_mail_secret_access_key)

    db.commit()
    db.refresh(row)
    return _to_response(row)


@router.post("/email-settings/test", response_model=TestEmailResponse)
def send_test_email(
    body: TestEmailRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Send a real message through whatever config is currently in effect.

    Sent synchronously rather than via Celery on purpose: the entire point
    is to surface the provider's own error text back to the admin, and a
    fire-and-forget task would swallow exactly the message they need.
    """
    from ..services.email_service import EmailService

    to_email = (body.to_email or "").strip()
    if not to_email or "@" not in to_email:
        raise HTTPException(status_code=400, detail="Enter a valid email address")

    try:
        # Constructed fresh so it picks up settings saved moments ago rather
        # than whatever the long-lived singleton resolved at import time.
        service = EmailService()
        ok = service.send_email(
            to_email,
            "FreeFrame test email",
            "<html><body style=\"font-family: Arial, sans-serif;\">"
            "<h2>It works</h2>"
            "<p>Your FreeFrame mail settings are configured correctly.</p>"
            "</body></html>",
            "Your FreeFrame mail settings are configured correctly.",
        )
    except Exception as exc:
        # Surfaced verbatim: provider auth errors (SMTP 535 and friends) are
        # the whole diagnostic value here.
        return TestEmailResponse(success=False, detail=str(exc))

    if not ok:
        return TestEmailResponse(
            success=False,
            detail="The mail provider rejected the message. Check the API logs for the provider's error.",
        )
    return TestEmailResponse(success=True, detail=f"Test email sent to {to_email}.")
