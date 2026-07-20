from pydantic import BaseModel, EmailStr
import uuid
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

class DeactivateUserRequest(BaseModel):
    user_id: uuid.UUID
