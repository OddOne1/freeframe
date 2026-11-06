"""Request and response shapes for routers/snippet.py (socialsnippet-api-contract.md, draft v1)."""
import uuid
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


class TrackSpeakerOut(TrackOut):
    segments_relabelled: int


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
