from pydantic import BaseModel, EmailStr
import uuid
from datetime import datetime
from ..models.user import UserStatus, UserGlobalRole
from ..models.project import ProjectRole

class RegisterRequest(BaseModel):
    email: EmailStr
    name: str
    password: str

class LoginRequest(BaseModel):
    email: EmailStr
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    needs_password: bool = False  # True if user needs to set password

class RefreshRequest(BaseModel):
    refresh_token: str

class UserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    first_name: str | None
    last_name: str
    avatar_url: str | None
    status: UserStatus
    email_verified: bool = False
    role: UserGlobalRole = UserGlobalRole.user
    invite_token: str | None = None
    preferences: dict = {}
    created_at: datetime
    storage_limit_bytes: int | None = None

    model_config = {"from_attributes": True}


class ContactUserResponse(BaseModel):
    """Deliberately minimal -- backs GET /users/admins, which any
    authenticated user can call. UserResponse carries invite_token,
    storage_limit_bytes, preferences and status; none of that belongs in a
    world-readable "who do I contact for help" list, so this is a separate
    schema rather than a reuse.
    """
    id: uuid.UUID
    email: str
    name: str
    avatar_url: str | None

    model_config = {"from_attributes": True}


class AdminUserProjectSummary(BaseModel):
    project_id: uuid.UUID
    project_name: str
    role: ProjectRole

    model_config = {"from_attributes": True}

class AdminUserResponse(UserResponse):
    """UserResponse plus a per-project role summary, used only by the
    superadmin user-management dashboard so it can group users and show
    per-project roles without a separate round-trip per user."""
    projects: list[AdminUserProjectSummary] = []

class InviteRequest(BaseModel):
    email: EmailStr
    name: str

# Magic code flow
class SendMagicCodeRequest(BaseModel):
    email: EmailStr
    purpose: str = "login"

class SendMagicCodeResponse(BaseModel):
    message: str
    email: str

class VerifyMagicCodeRequest(BaseModel):
    email: EmailStr
    code: str

class SetPasswordRequest(BaseModel):
    password: str

# Invite flow
class AcceptInviteRequest(BaseModel):
    token: str
    password: str

class InviteInfoResponse(BaseModel):
    email: str
    name: str
    org_name: str | None = None

class UpdateProfileRequest(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    avatar_url: str | None = None

class UpdateUserRoleRequest(BaseModel):
    is_admin: bool

class UpdateUserStorageLimitRequest(BaseModel):
    """A superadmin setting one user's personal storage budget.

    `None` means UNLIMITED, not "reset to the 200GB default". That is the
    reading the rest of the codebase already commits to: routers/projects.py's
    _check_owner_storage_allocation returns early on a NULL personal limit,
    and the web UI renders NULL as "Unlimited". The 200GB in
    add_user_global_role.py is a column server_default, which only applies
    when a row is INSERTed -- it is not a fallback for NULL. So sending null
    here grants unlimited storage; to put someone back on the default, send
    the 200GB value explicitly.
    """
    storage_limit_bytes: int | None

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID

# Permanent user deletion (superadmin-only, task 1 2026-07-23)
class PurgeUserOwnerCandidate(BaseModel):
    id: uuid.UUID
    name: str
    email: str

class PurgeUserOwnedProject(BaseModel):
    project_id: uuid.UUID
    project_name: str
    candidates: list[PurgeUserOwnerCandidate] = []

class PurgeUserPreviewResponse(BaseModel):
    owned_projects: list[PurgeUserOwnedProject] = []

class PurgeUserRequest(BaseModel):
    # project_id -> chosen new-owner user_id. Only needed for projects
    # where purge-preview listed at least one Manager candidate -- when a
    # project has none, the caller becomes owner automatically and no
    # entry is required here for that project.
    owner_assignments: dict[uuid.UUID, uuid.UUID] = {}
