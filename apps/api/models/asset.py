import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional
from sqlalchemy import String, Enum, DateTime, ForeignKey, Integer, BigInteger, Float, func, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
try:
    from ..database import Base
except ImportError:
    from database import Base

class AssetType(str, PyEnum):
    image = "image"
    image_carousel = "image_carousel"
    audio = "audio"
    video = "video"

class AssetStatus(str, PyEnum):
    draft = "draft"
    in_review = "in_review"
    in_progress = "in_progress"
    approved = "approved"
    rejected = "rejected"
    archived = "archived"

class ProcessingStatus(str, PyEnum):
    uploading = "uploading"
    processing = "processing"
    ready = "ready"
    failed = "failed"

class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("projects.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(String(2000), nullable=True)
    asset_type: Mapped[AssetType] = mapped_column(Enum(AssetType), nullable=False)
    status: Mapped[AssetStatus] = mapped_column(Enum(AssetStatus), default=AssetStatus.draft)
    rating: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    assignee_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("folders.id"), nullable=True, index=True)
    due_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    keywords: Mapped[Optional[list]] = mapped_column(JSONB, nullable=True, default=list)
    # Snapshot-and-nullify: created_by_name survives the User row being
    # hard-deleted (set once at creation, never updated) -- same pattern as
    # projects.created_by_name from task 8.
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    created_by_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    # The LUT the whole team sees applied to this shot. On Asset rather than
    # AssetVersion on purpose: a grade is a creative choice about the shot,
    # and should survive a version bump rather than silently resetting.
    # SET NULL so deleting a LUT degrades to "no grade" instead of orphaning.
    # Only a LUT visible in this asset's project may be set here (enforced in
    # routers/luts.py) — otherwise teammates hit a reference they can't read.
    applied_lut_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("luts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("ix_assets_project_folder_deleted", "project_id", "folder_id", "deleted_at"),
    )

class AssetVersion(Base):
    __tablename__ = "asset_versions"
    __table_args__ = (UniqueConstraint("asset_id", "version_number", name="uq_asset_versions_asset_version"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    asset_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("assets.id"), nullable=False, index=True)
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    processing_status: Mapped[ProcessingStatus] = mapped_column(Enum(ProcessingStatus), default=ProcessingStatus.uploading)
    # §113 — how far processing has got, 0-100.
    #
    # A plain column rather than a side table: it is one small, frequently
    # overwritten number with exactly the same lifetime as processing_status,
    # which already lives here. A separate table would mean a join on every
    # asset listing to read a value that is meaningless without the status
    # beside it.
    #
    # Nullable, and null is not zero: it means "no progress has ever been
    # reported for this version", which is the honest state for an image (its
    # processor has no progress callback at all) and for anything queued but
    # not yet started. A reader must not present null as 0% of a running job.
    processing_progress: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_by_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # §114 — heartbeat for the stuck-processing sweeper.
    #
    # The sweeper cannot key on created_at: a legitimate 4K transcode can run
    # for well over an hour, and a threshold generous enough to never kill one
    # of those is too generous to catch anything usefully. It needs to know
    # when this row last showed a sign of life, not when it was created.
    #
    # `onupdate` makes that automatic rather than something every writer has
    # to remember: §113's progress callback already commits this row on each
    # new whole percent, so a genuinely running transcode touches it every few
    # seconds without a single call site knowing about the sweeper. Matches
    # Asset.updated_at's own definition deliberately.
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    deleted_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

class FileType(str, PyEnum):
    image = "image"
    audio = "audio"
    video = "video"

class TranscriptionStatus(str, PyEnum):
    """Speech-to-text stage, deliberately independent of
    AssetVersion.processing_status.

    Transcription runs *after* the asset is already playable (see
    tasks/transcribe_tasks.py), so it can still be running -- or fail
    outright -- against a version whose processing_status is already
    `ready`. Folding the two together would either delay playback or make
    a transcription failure look like a transcode failure.
    """
    not_started = "not_started"
    processing = "processing"
    ready = "ready"
    failed = "failed"

class MediaFile(Base):
    __tablename__ = "media_files"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("asset_versions.id"), nullable=False, index=True)
    file_type: Mapped[FileType] = mapped_column(Enum(FileType), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(500), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    s3_key_raw: Mapped[str] = mapped_column(String(1000), nullable=False)
    s3_key_processed: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    s3_key_thumbnail: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    # A standalone 1080p MP4, built at upload ONLY for sources heavy enough
    # that re-encoding them per download hurts: >100 Mbit/s or 4K+ (§57).
    # Null for everything else, and null means every download for that asset
    # behaves exactly as it did before this existed.
    #
    # Deliberately NOT the HLS ladder (`s3_key_processed`): that is segmented
    # for adaptive playback, this is one file for downloads and NLE ingest.
    # And unlike an export it is permanent -- that is what makes the second
    # and every later download of a heavy source fast, not just the first.
    proxy_1080p_key: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    fps: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    sequence_order: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Codec/color/bitrate details from ffprobe — shape varies by file_type, so
    # JSONB rather than one column per possible field. See
    # packages/transcoder/base.py::parse_ffprobe_metadata for what gets
    # written into it. Keys currently used: video_codec, video_bit_rate,
    # visual_bit_depth, alpha_channel, color_space, dynamic_range,
    # color_transfer, color_primaries, video_codec_profile, video_codec_level,
    # field_order, display_aspect_ratio, timecode, rotation, camera_make,
    # camera_model, creation_time, encoder, audio_codec, audio_bit_rate,
    # audio_bit_depth, audio_channels, audio_sample_rate. (Camera make/model/
    # timecode/etc. added 2026-07-30 — only populated when the source
    # container actually carries these tags, which generic ffprobe parsing
    # can't guarantee for proprietary raw formats like R3D/BRAW/ARRIRAW.)
    technical_metadata: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    # Speech-to-text derivatives, written by tasks/transcribe_tasks.py long
    # after the transcode pipeline has already marked the version ready.
    # transcript.json is the source of truth (full text + segment
    # timestamps); captions.vtt is generated from the same segments for the
    # <track> element.
    s3_key_transcript: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    s3_key_captions: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    # ISO 639-1, as auto-detected by Whisper -- stored rather than left to
    # be parsed out of transcript.json, so <track srclang> and the panel's
    # language label don't need the full file fetched just for this.
    transcript_language: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    transcription_status: Mapped[TranscriptionStatus] = mapped_column(
        Enum(TranscriptionStatus), nullable=False, default=TranscriptionStatus.not_started,
        server_default=TranscriptionStatus.not_started.value,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class CarouselItem(Base):
    __tablename__ = "carousel_items"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("asset_versions.id"), nullable=False)
    media_file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("media_files.id"), nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
