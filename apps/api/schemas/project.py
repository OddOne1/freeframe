from pydantic import BaseModel
import uuid
from datetime import datetime
from ..models.project import ProjectType, ProjectRole

class ProjectCreate(BaseModel):
    name: str
    description: str | None = None
    project_type: ProjectType = ProjectType.personal

class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    is_public: bool | None = None
    storage_limit_bytes: int | None = None
    ratings_visible_to_all: bool | None = None

class ProjectResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None
    project_type: ProjectType
    created_by: uuid.UUID
    created_at: datetime
    poster_url: str | None = None
    is_public: bool = False
    asset_count: int = 0
    storage_bytes: int = 0
    member_count: int = 0
    role: ProjectRole | None = None
    model_config = {"from_attributes": True}
    storage_limit_bytes: int | None = None
    ratings_visible_to_all: bool = False
    archived_at: datetime | None = None
    archived_by: uuid.UUID | None = None
    archived_by_is_superadmin: bool = False

class AdminProjectResponse(ProjectResponse):
    """ProjectResponse plus owner identity, used only by the superadmin
    project-overview dashboard (which lists projects the admin isn't
    necessarily a member of, so plain `role` is always None there)."""
    owner_name: str | None = None
    owner_email: str | None = None

class TransferOwnershipRequest(BaseModel):
    new_owner_id: uuid.UUID

class ProjectMemberResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    user_id: uuid.UUID
    role: ProjectRole
    model_config = {"from_attributes": True}

class AddProjectMemberRequest(BaseModel):
    user_id: uuid.UUID
    role: ProjectRole = ProjectRole.viewer

class UpdateProjectMemberRequest(BaseModel):
    role: ProjectRole
