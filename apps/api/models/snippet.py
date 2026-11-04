"""SocialSnippet: speaker-labelled transcripts, clip suggestions and their jobs.

Data layer only. Nothing reads or writes these tables yet — no route, task or
page — so this module is the whole of the feature as it stands.

── What belongs to an asset, and the one read rule ─────────────────────────
Six of the eight tables hang off ONE media file (directly through
`media_file_id`, or through a transcript segment). An asset in the trash
keeps every one of those rows until the 30-day purge, because a restore has
to bring the transcript back with it. So every read of them has to leave out
the rows of a soft-deleted asset, and that rule lives in exactly one place:
`live_media_file_clause` below, reached through `AssetBound.live()`.

Do not write `Asset.deleted_at.is_(None)` against these tables by hand. Three
hand-written copies of a filter is how two of them come to disagree (see
§239's note on `can_manage_version`).

The two project-level tables — settings and the speaker roster — belong to
a project, not to an asset, and are deliberately not covered by that rule.

── Deleting ────────────────────────────────────────────────────────────────
Every FK to `media_files` and `transcript_segments` is ON DELETE CASCADE.
`purge_service.purge_asset` deletes `media_files` rows and knows nothing
about these tables; the cascade is what keeps the permanent purge working
without changing it. A NO ACTION FK here would make every purge of a
transcribed asset fail on a foreign-key violation.

── Search ──────────────────────────────────────────────────────────────────
`transcript_segments.search_vector` is a STORED generated column over
`text_current` with the `simple` text-search configuration: the content is
multilingual (es/pt/it/fr/de, per tasks/transcribe_tasks.py), and a
language-specific stemmer would mis-stem everything not in its language.
A trigram index on `text_current` exists only where the database already had
`pg_trgm` enabled when the migration ran; it is not declared here, because
whether it exists depends on the database, not on this code.
"""

import uuid
from datetime import datetime
from enum import Enum as PyEnum
from typing import Optional

from sqlalchemy import (
    JSON, Boolean, CheckConstraint, Computed, DateTime, Enum, Float, ForeignKey,
    Index, Integer, String, Text, UniqueConstraint, exists, func,
)
from sqlalchemy.dialects.postgresql import ARRAY, TSVECTOR, UUID
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import Mapped, Session, mapped_column

try:
    from ..database import Base
    from .asset import Asset, AssetVersion, MediaFile
except ImportError:  # pragma: no cover - alembic's import path
    from database import Base
    from models.asset import Asset, AssetVersion, MediaFile


# ── Enums ─────────────────────────────────────────────────────────────────


class SegmentStatus(str, PyEnum):
    """Where a segment's `text_current` came from."""

    #: Exactly what the model produced; `text_current == text_ai`.
    ai = "ai"
    #: A person changed it.
    edited = "edited"
    #: A person had edited it, and a later AI pass produced different text
    #: underneath. Kept apart from `edited` so the edit is not silently
    #: overwritten and the change can be shown for review.
    ai_changed = "ai_changed"


class EditResolution(str, PyEnum):
    pending = "pending"
    accepted = "accepted"
    reverted = "reverted"


class SnippetJobStatus(str, PyEnum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"


class SnippetStatus(str, PyEnum):
    #: Proposed by the pipeline, not yet looked at.
    suggested = "suggested"
    approved = "approved"
    rejected = "rejected"


#: The export shapes a project can default to. `export_aspect`, never
#: `aspect_ratio`: `ShareLinkAppearance.aspect_ratio` already means the
#: thumbnail-card layout on a share page, which is unrelated.
EXPORT_ASPECTS = ("9:16", "1:1", "4:5", "16:9")

#: The generated search column. `simple`: no language-specific stemming,
#: because the content is multilingual. The migration repeats this string
#: verbatim rather than importing it — a migration must not change when a
#: model does.
SEARCH_VECTOR_EXPR = "to_tsvector('simple'::regconfig, COALESCE(text_current, ''::text))"


# ── SQLite, for the test suite only ───────────────────────────────────────
#
# Production is Postgres and only Postgres. But several existing tests
# (test_purge.py, test_storage_prefix.py, test_email_case_insensitive.py)
# build an in-memory SQLite schema with `Base.metadata.create_all`, which
# takes in EVERY model, these included. SQLite has no tsvector, no array and
# no `::` cast, so without the three shims below every one of those tests
# errors at schema creation, before it reaches anything it tests.
#
# Each shim is scoped to the SQLite dialect and to these columns, and none of
# them changes a byte of the Postgres DDL: `with_variant` leaves the
# Postgres type as declared, and `_PgComputed` compiles exactly like
# `Computed` everywhere except SQLite.

#: tsvector on Postgres; plain text on SQLite.
_SearchVectorType = TSVECTOR().with_variant(Text(), "sqlite")
#: text[] on Postgres; JSON on SQLite.
_TopicsType = ARRAY(Text).with_variant(JSON(), "sqlite")


class _PgComputed(Computed):
    """`Computed` whose expression is Postgres SQL. On SQLite only, the
    column becomes a generated copy of the text instead, which is enough
    for `create_all` to succeed; nothing on SQLite searches it."""

    inherit_cache = True


@compiles(_PgComputed, "sqlite")
def _pg_computed_on_sqlite(element, compiler, **kw):
    return "GENERATED ALWAYS AS (coalesce(text_current, '')) VIRTUAL"


# ── The one read rule ─────────────────────────────────────────────────────


def live_media_file_clause(media_file_id_column, *via):
    """SQL criterion: this media file belongs to an asset that is NOT in the trash.

    THE single implementation of the soft-delete rule for SocialSnippet
    rows. Usable in both `select(...).where(...)` and `db.query(...).filter(...)`.

    `via` is any extra join criteria needed to reach `media_file_id_column`
    from the outer row — for a word or an edit, "the segment whose id is my
    segment_id". They go into the SAME EXISTS rather than a nested scalar
    subquery: a subquery two levels down does not correlate to the outer
    row, and Postgres then (rightly) refuses it with "more than one row
    returned by a subquery". tests/test_socialsnippet_data.py pins this.

    EXISTS rather than a join so a caller's own joins and row counts are not
    changed by it: a media file has exactly one version and one asset, but a
    join written into a caller's query is still one more thing that query
    has to be read around.
    """
    return exists().where(
        *via,
        MediaFile.id == media_file_id_column,
        AssetVersion.id == MediaFile.version_id,
        Asset.id == AssetVersion.asset_id,
        Asset.deleted_at.is_(None),
    )


class AssetBound:
    """Mixin for the tables whose rows belong to one asset's media file.

    Each subclass says how it reaches `media_files.id` (`_media_file_path`),
    and `live()` / `live_clause()` apply `live_media_file_clause` to it. That
    is the whole of the soft-delete handling: no subclass filters on
    `Asset.deleted_at` itself.
    """

    @classmethod
    def _media_file_path(cls):  # pragma: no cover - every subclass overrides
        """(media_file_id column, *join criteria to reach it)."""
        raise NotImplementedError

    @classmethod
    def live_clause(cls):
        """The criterion that keeps only rows of non-deleted assets."""
        column, *via = cls._media_file_path()
        return live_media_file_clause(column, *via)

    @classmethod
    def live(cls, db: Session):
        """`db.query(cls)` with rows of soft-deleted assets already excluded.

        The entry point for every read. Further filters chain on as usual.
        """
        return db.query(cls).filter(cls.live_clause())


# ── Project-level ─────────────────────────────────────────────────────────


class SnippetProjectSettings(Base):
    """One row per project that has SocialSnippet configured.

    No row is the same as `enabled = false` with every other setting at its
    default; a reader must not need a row to exist.
    """

    __tablename__ = "snippet_project_settings"

    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    enabled: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    # SET NULL: deleting the folder leaves the project configured but
    # without a source, rather than deleting its settings.
    source_folder_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("folders.id", ondelete="SET NULL"), nullable=True
    )
    # NULL means "keep exports forever" — a real choice, not "unset". The
    # default 30 matches purge_service.RETENTION_DAYS.
    export_retention_days: Mapped[Optional[int]] = mapped_column(
        Integer, nullable=True, default=30, server_default="30"
    )
    export_aspect: Mapped[str] = mapped_column(
        String(5), nullable=False, default="9:16", server_default="9:16"
    )
    caption_font: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "export_retention_days IS NULL OR export_retention_days > 0",
            name="ck_snippet_settings_retention_positive",
        ),
        CheckConstraint(
            "export_aspect IN ('9:16', '1:1', '4:5', '16:9')",
            name="ck_snippet_settings_export_aspect",
        ),
    )


class SnippetSpeaker(Base):
    """A named person in a project's speaker roster."""

    __tablename__ = "snippet_speakers"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    project_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


# Declared after the class because the expression needs the column object.
# "Anna" and "anna" are one speaker in one project.
Index(
    "uq_snippet_speakers_project_lower_name",
    SnippetSpeaker.project_id,
    func.lower(SnippetSpeaker.name),
    unique=True,
)


# ── Asset-bound ───────────────────────────────────────────────────────────


class SnippetTrackSpeaker(AssetBound, Base):
    """Which speaker is on which audio track of a file.

    `track_index` is the ordinal among the file's AUDIO streams (ffprobe's
    `a:N`), not the container stream index.
    """

    __tablename__ = "snippet_track_speakers"

    media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("media_files.id", ondelete="CASCADE"), primary_key=True
    )
    track_index: Mapped[int] = mapped_column(Integer, primary_key=True)
    speaker_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("snippet_speakers.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )

    __table_args__ = (
        CheckConstraint("track_index >= 0", name="ck_snippet_track_speakers_track_index"),
    )

    @classmethod
    def _media_file_path(cls):
        return (cls.media_file_id,)


class TranscriptSegment(AssetBound, Base):
    __tablename__ = "transcript_segments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False
    )
    track_index: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    speaker_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("snippet_speakers.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    #: Order within (media_file_id, track_index).
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    #: ISO 639-1, same width as MediaFile.transcript_language.
    language: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    #: What the model produced. Never edited by a person.
    text_ai: Mapped[str] = mapped_column(Text, nullable=False)
    #: What is shown and searched.
    text_current: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[SegmentStatus] = mapped_column(
        Enum(SegmentStatus, name="transcriptsegmentstatus"),
        nullable=False, default=SegmentStatus.ai, server_default=SegmentStatus.ai.value,
    )
    edited_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    edited_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # Written exactly as Postgres normalises it (see pg_get_expr), so the
    # drift check compares like with like instead of warning on spelling.
    search_vector: Mapped[Optional[str]] = mapped_column(
        _SearchVectorType,
        _PgComputed(SEARCH_VECTOR_EXPR, persisted=True),
        nullable=True,
    )

    __table_args__ = (
        UniqueConstraint(
            "media_file_id", "track_index", "seq", name="uq_transcript_segments_file_track_seq"
        ),
        CheckConstraint(
            "start_ms >= 0 AND end_ms >= start_ms", name="ck_transcript_segments_times"
        ),
        Index("ix_transcript_segments_search_vector", "search_vector", postgresql_using="gin"),
    )

    @classmethod
    def _media_file_path(cls):
        return (cls.media_file_id,)


class _SegmentBound(AssetBound):
    """Reaches its media file through `segment_id` → transcript_segments."""

    @classmethod
    def _media_file_path(cls):
        return (TranscriptSegment.media_file_id, TranscriptSegment.id == cls.segment_id)


class TranscriptWord(_SegmentBound, Base):
    __tablename__ = "transcript_words"

    segment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("transcript_segments.id", ondelete="CASCADE"), primary_key=True
    )
    #: Position of the word within its segment, from 0.
    idx: Mapped[int] = mapped_column(Integer, primary_key=True)
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    word: Mapped[str] = mapped_column(Text, nullable=False)
    #: faster-whisper's per-word probability, 0..1.
    probability: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    __table_args__ = (
        CheckConstraint("idx >= 0", name="ck_transcript_words_idx"),
        CheckConstraint("start_ms >= 0 AND end_ms >= start_ms", name="ck_transcript_words_times"),
        CheckConstraint(
            "probability IS NULL OR (probability >= 0 AND probability <= 1)",
            name="ck_transcript_words_probability",
        ),
    )


class TranscriptEdit(_SegmentBound, Base):
    """One person's change to one segment, and what became of it."""

    __tablename__ = "transcript_edits"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    segment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("transcript_segments.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    old_text: Mapped[str] = mapped_column(Text, nullable=False)
    new_text: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    resolution: Mapped[EditResolution] = mapped_column(
        Enum(EditResolution, name="transcripteditresolution"),
        nullable=False, default=EditResolution.pending, server_default=EditResolution.pending.value,
    )
    resolved_by: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)


class SnippetJob(AssetBound, Base):
    """One pipeline stage for one media file. At most one row per stage.

    `stage` is a string, not an enum: the stages are a pipeline that will
    change, and every new Postgres enum value is a migration of its own.
    """

    __tablename__ = "snippet_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False
    )
    stage: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[SnippetJobStatus] = mapped_column(
        Enum(SnippetJobStatus, name="snippetjobstatus"),
        nullable=False, default=SnippetJobStatus.pending, server_default=SnippetJobStatus.pending.value,
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # §114's lesson: a sweeper needs "last sign of life", not "created".
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("media_file_id", "stage", name="uq_snippet_jobs_file_stage"),
        CheckConstraint("attempts >= 0", name="ck_snippet_jobs_attempts"),
    )

    @classmethod
    def _media_file_path(cls):
        return (cls.media_file_id,)


class Snippet(AssetBound, Base):
    """A candidate clip: an in/out range on one media file."""

    __tablename__ = "snippets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    media_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Nullable: a clip can span several speakers, or one nobody named yet.
    speaker_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("snippet_speakers.id", ondelete="SET NULL"),
        nullable=True, index=True,
    )
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    quote: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    topics: Mapped[list[str]] = mapped_column(
        _TopicsType, nullable=False, default=list, server_default="{}"
    )
    quality_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    viral_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[SnippetStatus] = mapped_column(
        Enum(SnippetStatus, name="snippetstatus"),
        nullable=False, default=SnippetStatus.suggested, server_default=SnippetStatus.suggested.value,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name="ck_snippets_times"),
    )

    @classmethod
    def _media_file_path(cls):
        return (cls.media_file_id,)
