"""Settings -> Contact: a real form, not a mailto: directory (§47).

Authenticated-only throughout. The sender is the session's user, so nothing
here re-collects a name or an email that could disagree with the account
actually submitting.

Where the target address lives, and why: EmailSettings, not SiteSettings.
`GET /site-settings` is unauthenticated (it backs login-page branding), and
a support inbox has no business being readable by an anonymous request --
the same reasoning that put the SMTP credentials there in the first place.
"""

import logging
from datetime import datetime, timedelta, timezone
from html import escape

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..models.contact import ContactRequest
from ..models.email_settings import EmailSettings
from ..models.user import User, UserGlobalRole
from ..middleware.auth import get_current_user
from ..schemas.contact import (
    ContactRequestCreate,
    ContactRequestResponse,
    ContactSettingsResponse,
    ContactSettingsUpdate,
)
from ..services.email_service import email_service
from .users import require_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/contact", tags=["contact"])

RECENT_WINDOW_DAYS = 30


def _settings_row(db: Session) -> EmailSettings:
    """The singleton, created on demand -- same helper shape as
    email_settings.py's, so a fresh install has no special case."""
    row = db.query(EmailSettings).first()
    if not row:
        row = EmailSettings()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _target(db: Session) -> str | None:
    value = (_settings_row(db).contact_target_email or "").strip()
    return value or None


def _recent_count(db: Session) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENT_WINDOW_DAYS)
    return db.query(ContactRequest).filter(ContactRequest.created_at >= cutoff).count()


@router.get("/settings", response_model=ContactSettingsResponse)
def get_contact_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    target = _target(db)
    if current_user.role != UserGlobalRole.superadmin:
        # Everyone learns whether the form works; only a superadmin learns
        # where it goes and how much traffic it gets.
        return ContactSettingsResponse(configured=target is not None)
    return ContactSettingsResponse(
        configured=target is not None,
        target_email=target,
        requests_last_30_days=_recent_count(db),
    )


@router.patch("/settings", response_model=ContactSettingsResponse)
def update_contact_settings(
    body: ContactSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    row = _settings_row(db)
    if "target_email" in body.model_fields_set:
        value = (body.target_email or "").strip()
        # Empty clears it, matching email_settings' convention for plain
        # fields. Cleared means unconfigured, and the form then refuses to
        # send rather than delivering nowhere.
        row.contact_target_email = value or None
    db.commit()
    db.refresh(row)
    target = (row.contact_target_email or "").strip() or None
    return ContactSettingsResponse(
        configured=target is not None,
        target_email=target,
        requests_last_30_days=_recent_count(db),
    )


@router.post("", response_model=ContactRequestResponse, status_code=status.HTTP_201_CREATED)
def submit_contact_request(
    body: ContactRequestCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    target = _target(db)
    if not target:
        raise HTTPException(
            status_code=400,
            detail="No contact address is configured yet. Ask a superadmin to set one.",
        )

    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    sender_name = current_user.name or current_user.email
    subject = (body.subject or "").strip() or f"Contact form: {sender_name}"

    # escape() on every interpolated value: this body is assembled from user
    # input and goes out as HTML.
    html_body = (
        f"<p><strong>From:</strong> {escape(sender_name)} "
        f"&lt;{escape(current_user.email)}&gt;</p>"
        f"<p style=\"white-space:pre-wrap\">{escape(message)}</p>"
    )
    text_body = f"From: {sender_name} <{current_user.email}>\n\n{message}"

    sent = email_service.send_email(
        to_email=target,
        subject=subject[:255],
        html_body=html_body,
        text_body=text_body,
    )
    if not sent:
        # No row is written for a message that never left. The 30-day count
        # is meant to say how much reached the inbox, not how many times a
        # button was pressed.
        raise HTTPException(
            status_code=502,
            detail="The message could not be sent. Check the mail configuration.",
        )

    record = ContactRequest(
        sender_id=current_user.id,
        sender_email=current_user.email,
        sender_name=current_user.name,
        subject=subject[:255],
        message=message,
        target_email=target,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return ContactRequestResponse(
        id=str(record.id),
        created_at=record.created_at,
        target_email=record.target_email,
    )
