"""
First-time setup / onboarding endpoints.
These are only available when no superadmin exists in the system.
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr

from ..database import get_db
from ..models.user import User, UserStatus, UserGlobalRole
from ..services.auth_service import hash_password, create_access_token, create_refresh_token
from ..schemas.auth import TokenResponse
from ..middleware.rate_limit import rate_limit

router = APIRouter(prefix="/setup", tags=["setup"])


class SetupStatusResponse(BaseModel):
    needs_setup: bool
    message: str


class CreateSuperAdminRequest(BaseModel):
    email: EmailStr
    # Two explicit fields, matching User's own columns rather than a single
    # name split server-side. split_full_name (services/auth_service.py)
    # exists and the invite-accept flow uses it, but this form deliberately
    # collects both parts -- see CLAUDE.md §20. Nullability mirrors the
    # model exactly: first_name is optional, last_name is NOT NULL.
    first_name: str | None = None
    last_name: str
    password: str


class SetupCompleteResponse(BaseModel):
    message: str
    user_id: str
    access_token: str
    refresh_token: str


def _has_superadmin(db: Session) -> bool:
    """Check if any superadmin exists in the system."""
    return db.query(User).filter(
        User.role == UserGlobalRole.superadmin,
        User.deleted_at.is_(None),
    ).first() is not None


@router.get("/status", response_model=SetupStatusResponse)
def get_setup_status(db: Session = Depends(get_db)):
    """
    Check if the system needs initial setup.
    Returns needs_setup=True if no superadmin exists.
    """
    if _has_superadmin(db):
        return SetupStatusResponse(
            needs_setup=False,
            message="System is already configured",
        )
    return SetupStatusResponse(
        needs_setup=True,
        message="No superadmin found. Please complete initial setup.",
    )


@router.post("/create-superadmin", response_model=SetupCompleteResponse, status_code=status.HTTP_201_CREATED, dependencies=[Depends(rate_limit("create_superadmin", 3, 600))])
def create_superadmin(body: CreateSuperAdminRequest, db: Session = Depends(get_db)):
    """
    Create the first superadmin user.
    This endpoint is only available when no superadmin exists.
    """
    # Check if superadmin already exists
    if _has_superadmin(db):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Setup already completed. Superadmin already exists.",
        )
    
    # Check if email is already taken -- case-insensitively, so this can't
    # mint a second account that differs from an existing one only by
    # capitalisation. Same reasoning as auth_service.get_user_by_email;
    # this is the one email lookup that doesn't route through it.
    existing = db.query(User).filter(
        func.lower(User.email) == body.email.strip().lower(),
        User.deleted_at.is_(None),
    ).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    
    # Same rule update_user already enforces for the same column
    # (routers/users.py) -- last_name is NOT NULL, and a whitespace-only
    # value would satisfy pydantic while failing at commit.
    last_name = body.last_name.strip()
    if not last_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Last name cannot be empty",
        )

    # Create superadmin user.
    #
    # first_name/last_name, never name=. User.name is a read-only @property
    # computed from these two (since the name-split migration), so passing
    # name= to the declarative constructor raised AttributeError and 500'd
    # every fresh install's very first request. last_name was additionally
    # never passed at all, which would have failed the NOT NULL constraint
    # even if the property had accepted a write.
    user = User(
        email=body.email,
        first_name=(body.first_name or "").strip() or None,
        last_name=last_name,
        password_hash=hash_password(body.password),
        status=UserStatus.active,
        role=UserGlobalRole.superadmin,
        email_verified=True,  # Skip verification for initial setup
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Generate tokens
    access_token = create_access_token(str(user.id))
    refresh_token = create_refresh_token(str(user.id))
    
    return SetupCompleteResponse(
        message="Superadmin created successfully. You can now create organizations.",
        user_id=str(user.id),
        access_token=access_token,
        refresh_token=refresh_token,
    )
