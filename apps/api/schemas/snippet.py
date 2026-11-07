"""Request and response shapes for routers/snippet.py (socialsnippet-api-contract.md, draft v1)."""
import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

SnippetSourceLiteral = Literal["keyword", "llm", "import", "manual"]
SnippetStatusLiteral = Literal["suggested", "approved", "rejected"]
ExportAspectLiteral = Literal["9:16", "16:9", "1:1", "4:5", "3:4", "4:3"]


# ── Settings ───────────────────────────────────────────────────────────────


class SnippetSettingsOut(BaseModel):
    enabled: bool
    source_folder_id: Optional[uuid.UUID] = None
    export_retention_days: Optional[int] = None
    export_aspect: str
    caption_font: Optional[str] = None


class SnippetSettingsPatch(BaseModel):
    """Every field optional. An explicit null is a value: `source_folder_id`
    null is the whole project, `export_retention_days` null is "keep
    forever", `caption_font` null is no font. `enabled` and
    `export_aspect` cannot be null."""

    enabled: Optional[bool] = None
    source_folder_id: Optional[uuid.UUID] = None
    export_retention_days: Optional[int] = None
    export_aspect: Optional[ExportAspectLiteral] = None
    caption_font: Optional[str] = None


class SnippetProcessIn(BaseModel):
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=20)
    force: bool = False


class SnippetProcessItem(BaseModel):
    asset_id: uuid.UUID
    queued: bool
    reason: str


class SnippetProcessOut(BaseModel):
    queued: int
    results: list[SnippetProcessItem]


# ── Speakers and tracks ────────────────────────────────────────────────────


class SpeakerOut(BaseModel):
    id: uuid.UUID
    name: str


class SpeakerIn(BaseModel):
    name: str


class TrackOut(BaseModel):
    track_index: int
    label: str
    speaker_id: Optional[uuid.UUID] = None
    speaker_name: Optional[str] = None


class TrackSpeakerIn(BaseModel):
    speaker_id: uuid.UUID


class DetectSummary(BaseModel):
    """What re-running clip detection after a speaker change did.

    `ran` false with a `reason` when it was not run (no transcript yet, or a
    transcription is running and its own detect stage will pick the speaker
    up) or when it failed; the speaker change itself is saved either way.
    `created` and `removed` count only untouched `source='keyword'`
    suggestions: approved, rejected, imported, hand-made and person-edited
    clips are never touched (tasks/transcribe_tasks.replaceable_snippets).
    """

    ran: bool
    created: int = 0
    removed: int = 0
    reason: Optional[str] = None


class TrackSpeakerOut(TrackOut):
    segments_relabelled: int
    detect_summary: DetectSummary


# ── Files ──────────────────────────────────────────────────────────────────

SnippetFileStatusLiteral = Literal["not_processed", "queued", "running", "done", "failed"]


class SnippetFileItem(BaseModel):
    asset_id: uuid.UUID
    #: The latest live version's media file.
    media_file_id: Optional[uuid.UUID] = None
    name: str
    kind: Literal["video", "audio"]
    #: "/" for the project root, else "/Parent/Child".
    folder_path: str
    duration_ms: Optional[int] = None
    #: The latest version's processing status (uploading, processing, ready, failed).
    asset_status: str
    #: Why the file cannot be processed yet; null when `asset_status` is ready.
    #: The same words POST /snippet/process answers with.
    not_ready_reason: Optional[str] = None
    snippet_status: SnippetFileStatusLiteral
    segment_count: int
    #: Clips that are not rejected.
    snippet_count: int
    error: Optional[str] = None
    updated_at: Optional[datetime] = None
    tracks: list[TrackOut]


class SnippetFilesOut(BaseModel):
    total: int
    items: list[SnippetFileItem]


# ── Suggest ────────────────────────────────────────────────────────────────


class TopicCount(BaseModel):
    topic: str
    count: int


class SuggestOut(BaseModel):
    names: list[SpeakerOut]
    topics: list[TopicCount]


# ── Clips and search ───────────────────────────────────────────────────────


class ClipSpeaker(BaseModel):
    id: uuid.UUID
    name: str


class Clip(BaseModel):
    #: The snippet id, or "moment:{media_file_id}:{start_ms}" for a moment.
    id: str
    kind: Literal["snippet", "moment"]
    asset_id: uuid.UUID
    asset_name: str
    media_file_id: uuid.UUID
    speaker: Optional[ClipSpeaker] = None
    start_ms: int
    end_ms: int
    duration_ms: int
    title: Optional[str] = None
    quote: Optional[str] = None
    topics: list[str] = []
    quality_score: Optional[float] = None
    viral_score: Optional[float] = None
    #: Null for a moment: it is a transcript hit, not a stored clip, so it
    #: has no source, generator or review status.
    source: Optional[SnippetSourceLiteral] = None
    generator: Optional[str] = None
    status: Optional[SnippetStatusLiteral] = None
    #: A person changed the title, topics or in/out points (PATCH sets
    #: snippets.user_edited_at). Always false for a moment.
    user_edited: bool = False
    stream_url: Optional[str] = None
    thumbnail_url: Optional[str] = None


class ClipGroup(BaseModel):
    key: str
    label: str
    items: list[Clip]


class SearchOut(BaseModel):
    total: int
    page: int
    page_size: int
    groups: list[ClipGroup]


# ── Transcript and clip edit ───────────────────────────────────────────────


class TranscriptWordOut(BaseModel):
    start_ms: int
    end_ms: int
    word: str


class TranscriptSegmentOut(BaseModel):
    id: uuid.UUID
    track_index: int
    speaker_name: Optional[str] = None
    start_ms: int
    end_ms: int
    text: str
    status: str
    words: list[TranscriptWordOut]


class TranscriptOut(BaseModel):
    language: Optional[str] = None
    segments: list[TranscriptSegmentOut]


class SnippetPatch(BaseModel):
    title: Optional[str] = None
    topics: Optional[list[str]] = None
    status: Optional[SnippetStatusLiteral] = None
    start_ms: Optional[int] = None
    end_ms: Optional[int] = None


# ── Exports (prompt #8) ────────────────────────────────────────────────────


class ExportFraming(BaseModel):
    """Where the picked region sits in the source; see services/snippet_export.
    Missing values default to the centre at zoom 1. Range checks happen in
    the service so the 422 says which value is wrong in plain words."""

    x: Optional[float] = None
    y: Optional[float] = None
    zoom: Optional[float] = None


class ExportCaptionStyle(BaseModel):
    x: Optional[float] = None
    y: Optional[float] = None
    size: Optional[float] = None


class SnippetExportIn(BaseModel):
    """POST /snippets/{snippet_id}/exports.

    `start_ms`/`end_ms` may be left out for a stored snippet, which then
    exports its saved in/out; a moment (`moment:{media_file_id}:{start_ms}`)
    must send `end_ms` and may leave `start_ms` to the id's."""

    start_ms: Optional[int] = None
    end_ms: Optional[int] = None
    aspect: str
    captions: bool = False
    framing: Optional[ExportFraming] = None
    caption_style: Optional[ExportCaptionStyle] = None


class SnippetExportCreatedOut(BaseModel):
    export_id: uuid.UUID
    #: "queued" for a new or re-queued render; an existing export answers
    #: with its own status (e.g. "done", "running").
    status: str


class SnippetExportOut(BaseModel):
    status: str
    progress: float
    download_url: Optional[str] = None
    error: Optional[str] = None
