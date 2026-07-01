from pydantic import BaseModel
import uuid
from ..models.asset import AssetType

ALLOWED_MIME_TYPES = {
    # Images
    "image/jpeg", "image/png", "image/webp", "image/heic", "image/tiff", "image/gif",
    "image/x-dpx", "image/x-exr",
    # Audio
    "audio/mpeg", "audio/wav", "audio/flac", "audio/aac", "audio/ogg", "audio/x-m4a",
    "audio/x-wav", "audio/x-aiff", "audio/aiff",
    # Video - standard
    "video/mp4", "video/quicktime", "video/x-msvideo", "video/x-matroska",
    "video/webm", "video/mpeg", "video/x-ms-wmv", "video/x-flv",
    "video/3gpp", "video/3gpp2", "video/ogg",
    # Video - broadcast/professional containers
    "application/mxf", "application/x-mxf", "video/mxf", "video/x-mxf",
    "video/x-m2ts", "video/mp2t", "video/mts",
    # Generic fallback for professional formats browsers misidentify
    "application/octet-stream",
    # RAW camera formats
    "video/x-raw", "image/x-raw",
    "application/x-braw", "application/braw",
    "application/x-redraw", "application/x-r3d",
    "application/x-arriraw", "application/x-ari",
    "application/x-cine", "application/x-cinema-dng",
}

MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024 * 1024  # 200 GB
CHUNK_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB

def mime_to_asset_type(mime_type: str) -> AssetType:
    if mime_type.startswith("image/"):
        return AssetType.image
    elif mime_type.startswith("audio/"):
        return AssetType.audio
    elif mime_type.startswith("video/"):
        return AssetType.video
    elif mime_type in ("application/mxf", "application/x-mxf", "video/mxf", "video/x-mxf",
                       "application/x-braw", "application/braw", "application/x-r3d",
                       "application/x-arriraw", "application/x-ari", "application/x-cine",
                       "application/x-cinema-dng", "application/octet-stream",
                       "video/mp2t", "video/x-m2ts", "video/mts"):
        return AssetType.video
    raise ValueError(f"Unsupported mime type: {mime_type}")

class InitiateUploadRequest(BaseModel):
    project_id: uuid.UUID
    asset_name: str
    original_filename: str
    mime_type: str
    file_size_bytes: int
    # For new version of existing asset
    asset_id: uuid.UUID | None = None
    folder_id: uuid.UUID | None = None

class InitiateUploadResponse(BaseModel):
    upload_id: str
    s3_key: str
    asset_id: uuid.UUID
    version_id: uuid.UUID

class PresignPartRequest(BaseModel):
    s3_key: str
    upload_id: str
    part_number: int  # 1-indexed

class PresignPartResponse(BaseModel):
    presigned_url: str
    part_number: int

class UploadPart(BaseModel):
    PartNumber: int
    ETag: str

class CompleteUploadRequest(BaseModel):
    s3_key: str
    upload_id: str
    asset_id: uuid.UUID
    version_id: uuid.UUID
    parts: list[UploadPart]

class CompleteUploadResponse(BaseModel):
    status: str
    asset_id: uuid.UUID
    version_id: uuid.UUID

class AbortUploadRequest(BaseModel):
    s3_key: str
    upload_id: str
    version_id: uuid.UUID
