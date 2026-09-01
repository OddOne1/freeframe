from pydantic import BaseModel, Field
import uuid
from datetime import datetime
from typing import Optional
from ..models.asset import AssetType, AssetStatus, ProcessingStatus, FileType, TranscriptionStatus
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
    # Speech-to-text stage -- independent of the version's processing_status,
    # since transcription is still running (or already failed) long after the
    # asset became playable. The transcript/captions content itself comes
    # from GET /assets/{id}/transcript, not from here.
    transcription_status: TranscriptionStatus = TranscriptionStatus.not_started
    transcript_language: Optional[str] = None
    model_config = {"from_attributes": True}

class AssetVersionResponse(BaseModel):
    id: uuid.UUID
    asset_id: uuid.UUID
    version_number: int
    processing_status: ProcessingStatus
    # §113 — 0-100 while transcoding, 100 when ready. NULL means no progress
    # was ever reported (an image, or a job not yet started) — deliberately
    # distinct from 0, which means a running job that has not advanced.
    processing_progress: Optional[int] = None
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
    # The LUT the whole team sees on this shot, if any. The picker resolves
    # it to a real LUT via GET /projects/{id}/luts.
    applied_lut_id: Optional[uuid.UUID] = None
    due_date: Optional[datetime]
    keywords: Optional[list]
    created_by: Optional[uuid.UUID] = None
    created_by_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    latest_version: Optional[AssetVersionResponse] = None
    # §108 — this asset has more than one version and the caller has not
    # opened the newest one. False for anonymous callers, who have no
    # per-user seen state to compare against.
    has_unseen_version: bool = False
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

class TranscriptSegment(BaseModel):
    id: int
    start: float
    end: float
    text: str

class TranscriptResponse(BaseModel):
    """Everything the transcript panel and the <track> element need in one
    request: status, detected language, a proxy URL for captions.vtt, and
    the parsed segments.

    `segments` is only populated once transcription_status is `ready` --
    while it is `processing` the panel shows its own "Transcribing…" state
    off the status alone, and flips over on the SSE event.
    """
    transcription_status: TranscriptionStatus
    language: Optional[str] = None
    captions_url: Optional[str] = None
    text: str = ""
    segments: list[TranscriptSegment] = []

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


class CheckExistingRequest(BaseModel):
    """§97A — which of these assets are still there?

    Asked once per resumed job with every id the journal claims succeeded,
    rather than once per file: the point of the journal is to avoid a
    round trip per file, and replacing one-per-file uploads with
    one-per-file checks would trade nothing for nothing.
    """

    asset_ids: list[uuid.UUID] = Field(..., max_length=5000)


class CheckExistingResponse(BaseModel):
    # Only the ones that survive. The caller re-uploads everything it does
    # NOT get back — an id that was deleted, never existed, or belongs to
    # someone else all mean the same thing to a resume: do the work again.
    existing_ids: list[uuid.UUID]
