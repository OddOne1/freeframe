"""Reads of the site-settings singleton that several routers need (§191).

`routers/site_settings.py` owns writing these; this is the read side, put
here so `routers/auth.py` does not have to import a router to answer a
question about configuration. Both are deliberately uncached, matching what
§182 established for `timezone`: an admin changing a setting expects it to
bind on the next request, not after a restart.
"""

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
