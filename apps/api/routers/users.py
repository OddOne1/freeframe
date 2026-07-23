from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session
import uuid
import secrets
from datetime import datetime, timezone, timedelta
from ..database import get_db
from ..schemas.auth import UserResponse, InviteRequest, UpdateProfileRequest
from ..models.user import User, UserStatus, UserGlobalRole
from ..services import s3_service
from ..middleware.auth import get_current_user
from ..services.auth_service import hash_password, get_user_by_email, split_full_name
from ..tasks.email_tasks import send_invite_email
from ..tasks.celery_app import send_task_safe
from ..config import settings
from .hls_proxy import proxy_url_for

router = APIRouter(prefix="/users", tags=["users"])

@router.post("/me/avatar", response_model=UserResponse, status_code=status.HTTP_200_OK)
async def upload_avatar(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload the caller's own avatar. The client crops/downsizes the image
    to a small square WebP itself before uploading -- we don't re-process
    it server-side.

    Uploaded straight through this API container rather than a presigned
    browser->S3 PUT. AIStor is only reachable over plain HTTP on the LAN,
    so handing the browser a direct http://192.168.x.x presigned URL from
    an https:// page gets blocked as mixed content / a CORS preflight
    failure in any browser without an insecure-content override already
    set for this origin -- which is exactly what broke this in Safari.
    Proxying the bytes through here instead matches how every *read*
    already works (see hls_proxy.py's module docstring): the bucket never
    needs to be reachable from outside the Docker/LAN network, for uploads
    either.
    """
    body = await file.read()
    key = f"avatars/{current_user.id}/{uuid.uuid4()}.webp"
    s3_service.put_object(key, body, content_type="image/webp", cache_control="max-age=86400")
    # ~5 years -- avatar_url is stored as a plain string with no separate
    # resolution step at read time, so this needs to outlive normal token
    # lifetimes.
    current_user.avatar_url = proxy_url_for(key, expires_hours=24 * 365 * 5)
    db.commit()
    db.refresh(current_user)
    return current_user

@router.get("", response_model=list[UserResponse])
def get_users_batch(
    ids: str = Query(..., description="Comma-separated user IDs"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get basic user info for a batch of user IDs. Any authenticated user can call this."""
    try:
        user_ids = [uuid.UUID(uid.strip()) for uid in ids.split(",") if uid.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid user ID format")
    if len(user_ids) > 100:
        raise HTTPException(status_code=400, detail="Max 100 user IDs per request")
    users = db.query(User).filter(User.id.in_(user_ids), User.deleted_at.is_(None)).all()
    return users


@router.get("/search", response_model=list[UserResponse])
def search_users(
    q: str = Query(..., min_length=1, description="Search by name or email"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Search users by name or email. Returns up to 10 matching users."""
    pattern = f"%{q}%"
    users = db.query(User).filter(
        User.deleted_at.is_(None),
        (User.first_name.ilike(pattern) | User.last_name.ilike(pattern) | User.email.ilike(pattern)),
    ).limit(10).all()
    return users


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

def require_superuser(current_user: User = Depends(get_current_user)) -> User:
    """Superuser-or-above -- looser than require_admin. Only for endpoints
    explicitly opened up to superusers (task 11); everything else that
    used to gate on is_superadmin stays on require_admin."""
    if current_user.role == UserGlobalRole.user:
        raise HTTPException(status_code=403, detail="Superuser access required")
    return current_user

@router.post("/invite", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def invite_user(body: InviteRequest, db: Session = Depends(get_db), current_user: User = Depends(require_superuser)):
    if get_user_by_email(db, body.email):
        raise HTTPException(status_code=400, detail="Email already registered")
    
    # Generate invite token
    invite_token = secrets.token_urlsafe(48)
    invite_expires = datetime.now(timezone.utc) + timedelta(days=7)
    
    first_name, last_name = split_full_name(body.name)
    user = User(
        email=body.email,
        first_name=first_name,
        last_name=last_name,
        status=UserStatus.pending_invite,
        invite_token=invite_token,
        invite_token_expires_at=invite_expires,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    
    # Send invite email
    invite_url = f"{settings.frontend_url}/invite/{invite_token}"
    send_task_safe(send_invite_email, user.email, current_user.name or "Admin", "FreeFrame", invite_url)
    
    return user

@router.patch("/{user_id}", response_model=UserResponse)
def update_user(user_id: uuid.UUID, body: UpdateProfileRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Update user profile. Users can update their own profile."""
    if current_user.id != user_id and current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(status_code=403, detail="Can only update your own profile")
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if body.first_name is not None:
        user.first_name = body.first_name.strip() or None
    if body.last_name is not None:
        stripped_last_name = body.last_name.strip()
        if not stripped_last_name:
            raise HTTPException(status_code=400, detail="Last name cannot be empty")
        user.last_name = stripped_last_name
    if body.avatar_url is not None:
        user.avatar_url = body.avatar_url
    db.commit()
    db.refresh(user)
    return user

@router.patch("/{user_id}/deactivate", response_model=UserResponse)
def deactivate_user(user_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = UserStatus.deactivated
    db.commit()
    db.refresh(user)
    return user

@router.patch("/{user_id}/reactivate", response_model=UserResponse)
def reactivate_user(user_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.status = UserStatus.active
    db.commit()
    db.refresh(user)
    return user

@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: uuid.UUID, db: Session = Depends(get_db), _: User = Depends(require_admin)):
    """Soft-delete only -- deleted_at is read distinctly from status across
    auth (get_user_by_id), admin, and setup, so this endpoint's contract
    stays exactly as it was. Permanent deletion is a separate action: see
    POST /admin/users/{user_id}/purge (routers/admin.py), which is what the
    admin dashboard's Delete button actually calls."""
    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.deleted_at = datetime.now(timezone.utc)
    db.commit()
