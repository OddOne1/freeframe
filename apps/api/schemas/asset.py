from pydantic import BaseModel, Field
import uuid
from datetime import datetime
from typing import Optional
from ..models.asset import AssetType, AssetStatus, ProcessingStatus, FileType
from ..models.activity import NotificationType

class MediaFileResponse(BaseModel):
    id: uuid.UUID
    version_id: uuid.UUID
    file_type: FileType
    original_filename: str
    mime_type: str
    file_size_bytes: int
    s3_key_raw: str
    s3_key_processed: Optional[str]
    s3_key_thumbnail: Optional[str]
    width: Optional[int]
    height: Optional[int]
    duration_seconds: Optional[float]
    fps: Optional[float]
    sequence_order: Optional[int]
    technical_metadata: Optional[dict] = None
    model_config = {"from_attributes": True}

class AssetVersionResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_number: int
    processing_status: ProcessingStatus
    created_by: Optional[uuid.UUID] = None
    created_by_name: Optional[str] = None
    created_at: datetime
    files: list[MediaFileResponse] = []
    model_config = {"from_attributes": True}

class AssetResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    description: Optional[str]
    asset_type: AssetType
    status: AssetStatus
    rating: Optional[int]
    assignee_id: Optional[uuid.UUID]
    folder_id: Optional[uuid.UUID] = None
    due_date: Optional[datetime]
    keywords: Optional[list]
    created_by: Optional[uuid.UUID] = None
    created_by_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    latest_version: Optional[AssetVersionResponse] = None
    thumbnail_url: Optional[str] = None
    avg_rating: Optional[float] = None
    rating_count: int = 0
    my_rating: Optional[int] = None
    model_config = {"from_attributes": True}

class AssetUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[AssetStatus] = None
    rating: Optional[int] = None
    assignee_id: Optional[uuid.UUID] = None
    due_date: Optional[datetime] = None
    keywords: Optional[list] = None

class VoteRequest(BaseModel):
    stars: int = Field(..., ge=1, le=5)

class VoteToggleResponse(BaseModel):
    avg_rating: Optional[float] = None
    rating_count: int
    my_rating: Optional[int] = None

class StreamUrlResponse(BaseModel):
    url: str
    asset_type: AssetType
    expires_in: int = 3600

class NotificationResponse(BaseModel):
    id: uuid.UUID
    type: NotificationType
    asset_id: uuid.UUID
    comment_id: Optional[uuid.UUID] = None
    read: bool
    created_at: datetime
    # Enriched fields
    asset_name: Optional[str] = None
    actor_name: Optional[str] = None
    comment_preview: Optional[str] = None
    project_id: Optional[uuid.UUID] = None
