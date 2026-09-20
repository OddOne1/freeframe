from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import uuid
from typing import Optional
from sqlalchemy.orm import Session
from ..database import get_db
from ..services.auth_service import decode_token, get_user_by_id, token_version_of
from ..models.user import User, UserStatus

bearer_scheme = HTTPBearer()
optional_bearer_scheme = HTTPBearer(auto_error=False)

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    token = credentials.credentials
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    user = get_user_by_id(db, uuid.UUID(payload["sub"]))
    if not user or user.status == UserStatus.deactivated:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found or deactivated")
    # §199 — the token was valid when it was issued; this asks whether it
    # still is. Deactivation was already caught by the line above, because
    # this function re-reads the row on every request; what it could not see
    # was a change that leaves the account active but changes what a session
    # is entitled to. Same 401 an expired token gets: whether a token is
    # stale or forged is not the caller's business.
    if token_version_of(payload) != (user.token_version or 0):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired token")
    return user

def get_optional_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(optional_bearer_scheme),
    db: Session = Depends(get_db),
) -> Optional[User]:
    """Returns the authenticated user if a valid token is provided, None otherwise."""
    if not credentials:
        return None
    try:
        payload = decode_token(credentials.credentials)
        if not payload or payload.get("type") != "access":
            return None
        user = get_user_by_id(db, uuid.UUID(payload["sub"]))
        if not user or user.status == UserStatus.deactivated:
            return None
        # §199 — the same check as get_current_user. This variant exists for
        # endpoints that work with or without a session, so a stale token
        # here means "no session", not an error.
        if token_version_of(payload) != (user.token_version or 0):
            return None
        return user
    except Exception:
        return None

