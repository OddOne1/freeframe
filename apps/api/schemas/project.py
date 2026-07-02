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
    storage_bytes: int = 0
    storage_limit_bytes: int | None = None
    member_count: int = 0

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
