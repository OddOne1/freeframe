"""Reads of the site-settings singleton that several routers need (§191).

`routers/site_settings.py` owns writing these; this is the read side, put
here so `routers/auth.py` does not have to import a router to answer a
question about configuration. Both are deliberately uncached, matching what
§182 established for `timezone`: an admin changing a setting expects it to
bind on the next request, not after a restart.
"""

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from ..models.site_settings import SiteSettings


def _settings(db: Session) -> Optional[SiteSettings]:
    return db.query(SiteSettings).first()


def require_2fa_enabled(db: Session) -> bool:
    """Whether this instance requires 2FA of everyone.

    False when the row does not exist yet — a fresh install has no
    site_settings row until something creates one, and defaulting to True
    there would make an instance unreachable before it was ever configured.
    """
    row = _settings(db)
    return bool(row.require_2fa) if row else False


def instance_org_name(db: Session) -> str:
    """What to call this instance in an authenticator app.

    A self-hosted install branded as something else should not put
    "FreeFrame" in its users' authenticators.
    """
    row = _settings(db)
    name = row.org_name if row else None
    # isinstance, not a truthiness check: this value is handed to pyotp,
    # which calls urllib.quote on it and raises TypeError on anything that
    # is not a string. A NULL row, or a settings object that does not carry
    # the field, would otherwise turn an enrolment screen into a 500.
    if not isinstance(name, str) or not name.strip():
        return "FreeFrame"
    return name.strip()


def password_required_after(db: Session) -> Optional[datetime]:
    """When passwordless magic-code sign-in closes on this instance (§200).

    None means never — see the column's own comment for why that is the
    honest answer for a row this migration did not create.
    """
    row = _settings(db)
    value = getattr(row, "password_required_after", None) if row else None
    return value if isinstance(value, datetime) else None


def passwordless_window_closed(db: Session) -> bool:
    """Whether the migration window has passed on this instance.

    The comparison is made timezone-aware on both sides. The column is
    `DateTime(timezone=True)` so Postgres hands back an aware value, but a
    test fixture or a hand-edited row can produce a naive one, and comparing
    an aware `now()` with a naive stored value raises TypeError — which would
    turn every passwordless login into a 500 rather than into the refusal or
    the pass it should be. A naive value is read as UTC, which is what the
    column stores anyway.
    """
    cutoff = password_required_after(db)
    if cutoff is None:
        return False
    if cutoff.tzinfo is None:
        cutoff = cutoff.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) >= cutoff
