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
    "video/x-braw", "video/braw", "video/x-raw", "video/raw",
    "video/x-arriraw", "video/arriraw", "video/x-r3d",
    "video/r3d", "video/x-redraw", "video/redraw",
    "video/x-cine", "video/cine", "video/x-cinema-dng",
    "video/cinema-dng", "video/x-ari", "video/ari",
    "movie/x-braw", "movie/braw", "movie/x-raw", "movie/raw", 
    "movie/x-arriraw", "movie/arriraw", "movie/x-r3d",
    "movie/r3d", "movie/x-cine", "movie/cine",
    "movie/x-cinema-dng", "movie/cinema-dng",
    "movie/x-redraw", "movie/redraw", "movie/x-ar", "movie/ari"
}

# §213 — there is no hand-written maximum file size any more. It is
# arithmetic over the configured per-part ceiling, and it lives in
# services/upload_policy.py (`plan_parts`, `max_file_bytes`). The old
# constant here said 2000 GB, which no client could ever upload: at the
# 10-16 MiB parts they used, S3's 10,000-part limit capped a real upload
# at 98-156 GiB, and the rest of the promise was discovered as a failure
# at part 10,001 after hours of transfer.
CHUNK_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB -- client fallback only

def mime_to_asset_type (mime_type: str) -> AssetType:
    if mime_type.startswith("image/"):
        return AssetType.image
    elif mime_type.startswith("audio/"):
        return AssetType.audio
    elif mime_type.startswith("video/"):
        return AssetType.video
    elif mime_type.startswith("movie/") or mime_type in (
        "application/mxf", "application/x-mxf", "video/mxf", "video/x-mxf",
        "application/x-braw", "application/braw", "application/x-r3d",
        "application/x-arriraw", "application/x-ari", "application/x-cine",
        "application/x-cinema-dng", "application/octet-stream",
        "video/mp2t", "video/x-m2ts", "video/mts"
    ):
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
    # §213 — the SERVER decides how the file is split, and both clients
    # use what it says. Additive and optional so a client built against
    # the older response still parses this one: web and api are rebuilt
    # as separate containers, so for one rolling deploy a new web talks
    # to an old api (falls back to its own 10 MiB) and an old web talks
    # to a new api (ignores these and keeps its 10 MiB, which is still
    # legal -- just a lower ceiling).
    part_size: int | None = None
    total_parts: int | None = None

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


class UploadedPart(BaseModel):
    """One part the store already holds, as `GET /upload/parts` reports it.

    `Size` is what makes a resume safe: a part listed at the wrong size is
    a partial write, and re-sending it is far cheaper than completing a
    multipart upload around it.
    """
    PartNumber: int
    ETag: str
    Size: int


class UploadedPartsResponse(BaseModel):
    parts: list[UploadedPart]
