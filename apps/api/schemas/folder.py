import uuid
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field

class FolderCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    parent_id: Optional[uuid.UUID] = None

class FolderUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    parent_id: Optional[uuid.UUID] = None  # use model_fields_set to distinguish unset vs null

class FolderResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    parent_id: Optional[uuid.UUID]
    name: str
    created_by: Optional[uuid.UUID] = None
    created_at: datetime
    updated_at: datetime
    item_count: int = 0
    total_size_bytes: int = 0
    # §240 C2 — may THIS caller move this folder to the trash: the project
    # owner or a superadmin always, an editor only if the folder and
    # everything live inside it is theirs. Computed server-side so the web
    # renders the action from the answer.
    can_delete: bool = False

    model_config = {"from_attributes": True}

class FolderTreeNode(BaseModel):
    id: uuid.UUID
    name: str
    parent_id: Optional[uuid.UUID]
    item_count: int = 0
    total_size_bytes: int = 0
    # §240 C2 — see FolderResponse.can_delete. Batched for the whole tree
    # (see routers/folders.py's `_can_delete_folder_map`), not one
    # recursive query per node.
    can_delete: bool = False
    children: list["FolderTreeNode"] = []

class AssetMoveRequest(BaseModel):
    folder_id: Optional[uuid.UUID] = None  # null = move to root

class BulkMoveRequest(BaseModel):
    asset_ids: list[uuid.UUID] = []
    folder_ids: list[uuid.UUID] = []
    target_folder_id: Optional[uuid.UUID] = None  # null = root
