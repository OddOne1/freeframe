from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ContactSettingsResponse(BaseModel):
    """One call, shaped by role.

    `configured` is for everyone -- the form needs to know whether it can
    send. The other two are populated only for superadmins; a support inbox
    and a submission count are admin data, and there is no reason for every
    user to read them just to render a textarea.
    """
    configured: bool
    target_email: Optional[str] = None
    requests_last_30_days: Optional[int] = None


class ContactSettingsUpdate(BaseModel):
    # Empty string clears it, matching email_settings' own convention for
    # plain (non-secret) fields. Clearing means "not configured", which
    # disables the form rather than silently dropping messages.
    target_email: Optional[str] = None


class ContactRequestCreate(BaseModel):
    # Sender identity comes from the session; this form is inside the
    # authenticated app and re-asking for a name and email would only
    # invite a mismatch with the account actually submitting.
    subject: Optional[str] = Field(default=None, max_length=255)
    message: str = Field(min_length=1)


class ContactRequestResponse(BaseModel):
    id: str
    created_at: datetime
    target_email: str
