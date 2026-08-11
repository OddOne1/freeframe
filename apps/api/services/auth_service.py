from datetime import datetime, timedelta, timezone
from typing import Optional
import uuid
from jose import JWTError, jwt
import bcrypt
from sqlalchemy import func
from sqlalchemy.orm import Session
from ..config import settings
from ..models.user import User, UserStatus

def hash_password(password: str) -> str:
    # bcrypt has a 72 byte limit, truncate to avoid errors
    pwd_bytes = password[:72].encode('utf-8')
    salt = bcrypt.gensalt()
    hashed_bytes = bcrypt.hashpw(pwd_bytes, salt)
    return hashed_bytes.decode('utf-8')

def verify_password(plain: str, hashed: str) -> bool:
    try:
        plain_bytes = plain[:72].encode('utf-8')
        hashed_bytes = hashed.encode('utf-8')
        return bcrypt.checkpw(plain_bytes, hashed_bytes)
    except ValueError:
        return False

def create_access_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_expire_minutes)
    payload = {"sub": str(user_id), "type": "access", "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def create_refresh_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.refresh_token_expire_days)
    payload = {"sub": str(user_id), "type": "refresh", "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)

def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None

def get_user_by_email(db: Session, email: str) -> Optional[User]:
    """Look a user up by email, case-insensitively.

    `users.email` is a plain case-sensitive unique column, so
    `Mathias@yon.studio` and `mathias@yon.studio` were two different
    accounts as far as this lookup was concerned — which is exactly how
    one person ended up with two, holding different project grants (see
    CLAUDE.md §13a and scripts/merge_user_accounts.sql).

    **The comparison is normalised, not the stored value.** Existing rows
    legitimately contain uppercase, so lowercasing the *input* against a
    `==` on the raw column would stop matching them and lock those people
    out on their next login. Nothing here rewrites what is stored; new
    signups keep whatever capitalisation the person typed.

    The `deleted_at` filter is load-bearing now in a way it wasn't before:
    the retired half of a merged pair keeps its lowercase address forever,
    and without this filter the case-insensitive comparison would match
    both rows and could authenticate someone into the dead account.

    This is the single choke point for login, magic-code, the register and
    invite duplicate-checks, and share access — eight call sites across
    auth.py, users.py and share.py — so they all become case-insensitive
    together. `routers/setup.py` has its own inline copy of this query and
    is fixed alongside.
    """
    return db.query(User).filter(
        func.lower(User.email) == email.strip().lower(),
        User.deleted_at.is_(None),
    ).first()

def get_user_by_id(db: Session, user_id: uuid.UUID) -> Optional[User]:
    return db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()

def split_full_name(full_name: str) -> tuple[Optional[str], str]:
    """Split a single "full name" string into (first_name, last_name) by
    splitting on the first space -- everything before the first space
    becomes first_name, everything after becomes last_name (so multi-word
    last names like "Mary Jane Watson" stay together as one last_name).
    Single-word names have no first_name. Used by the legacy /auth/register
    endpoint and the admin invite flow, which still collect one "name"
    field, to populate the split first_name/last_name columns on User.
    """
    stripped = full_name.strip()
    if " " in stripped:
        first, rest = stripped.split(" ", 1)
        return first, rest
    return None, stripped
