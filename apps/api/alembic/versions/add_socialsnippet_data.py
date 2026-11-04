"""SocialSnippet data layer: speakers, transcript segments/words/edits, jobs, snippets.

Eight new tables and four new enum types. Nothing existing is altered, and
nothing is backfilled: no row in any existing table is read or written.

── Extensions ────────────────────────────────────────────────────────────
NONE are created. The full-text search column is core Postgres
(`to_tsvector` + a GIN index). A trigram index on
`transcript_segments.text_current` is added ONLY if `pg_trgm` is already
enabled in this database when the migration runs — this migration never
issues CREATE EXTENSION. Not declared on the model for that reason: whether
the index exists is a fact about the database, so the drift check cannot
expect it either way.

── Deleting ──────────────────────────────────────────────────────────────
Every FK to `media_files` and to `transcript_segments` is ON DELETE CASCADE,
so `purge_service.purge_asset`, which deletes media_files rows and knows
nothing about these tables, keeps working unchanged. FKs to `users` are SET
NULL, matching user_hard_delete_fk_policy. See models/snippet.py.

Revision ID: add_socialsnippet_data
Revises: add_deleted_by_240
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "add_socialsnippet_data"
down_revision = "add_deleted_by_240"
branch_labels = None
depends_on = None

#: name -> values, created before the tables and dropped after them.
_ENUMS = {
    "transcriptsegmentstatus": ("ai", "edited", "ai_changed"),
    "transcripteditresolution": ("pending", "accepted", "reverted"),
    "snippetjobstatus": ("pending", "running", "done", "failed"),
    "snippetstatus": ("suggested", "approved", "rejected"),
}

_TRGM_INDEX = "ix_transcript_segments_text_trgm"


def _enum(name):
    """A column type for an enum this migration has already created."""
    return postgresql.ENUM(*_ENUMS[name], name=name, create_type=False)


def _uuid():
    return postgresql.UUID(as_uuid=True)


def _now():
    return sa.text("now()")


def upgrade() -> None:
    bind = op.get_bind()
    for name, values in _ENUMS.items():
        postgresql.ENUM(*values, name=name).create(bind, checkfirst=True)

    # 1 ── per-project settings ────────────────────────────────────────────
    op.create_table(
        "snippet_project_settings",
        sa.Column("project_id", _uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("source_folder_id", _uuid(), sa.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True),
        sa.Column("export_retention_days", sa.Integer(), nullable=True, server_default=sa.text("30")),
        sa.Column("export_aspect", sa.String(5), nullable=False, server_default="9:16"),
        sa.Column("caption_font", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.CheckConstraint(
            "export_retention_days IS NULL OR export_retention_days > 0",
            name="ck_snippet_settings_retention_positive",
        ),
        sa.CheckConstraint(
            "export_aspect IN ('9:16', '1:1', '4:5', '16:9')",
            name="ck_snippet_settings_export_aspect",
        ),
    )

    # 2 ── speaker roster ──────────────────────────────────────────────────
    op.create_table(
        "snippet_speakers",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("project_id", _uuid(), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_by", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
    )
    op.create_index("ix_snippet_speakers_project_id", "snippet_speakers", ["project_id"])
    op.create_index(
        "uq_snippet_speakers_project_lower_name",
        "snippet_speakers",
        ["project_id", sa.text("lower(name)")],
        unique=True,
    )

    # 3 ── track → speaker ─────────────────────────────────────────────────
    op.create_table(
        "snippet_track_speakers",
        sa.Column("media_file_id", _uuid(), sa.ForeignKey("media_files.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("track_index", sa.Integer(), primary_key=True),
        sa.Column("speaker_id", _uuid(), sa.ForeignKey("snippet_speakers.id", ondelete="CASCADE"), nullable=False),
        sa.CheckConstraint("track_index >= 0", name="ck_snippet_track_speakers_track_index"),
    )
    op.create_index("ix_snippet_track_speakers_speaker_id", "snippet_track_speakers", ["speaker_id"])

    # 4 ── transcript segments ─────────────────────────────────────────────
    op.create_table(
        "transcript_segments",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("media_file_id", _uuid(), sa.ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("track_index", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("speaker_id", _uuid(), sa.ForeignKey("snippet_speakers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("language", sa.String(10), nullable=True),
        sa.Column("text_ai", sa.Text(), nullable=False),
        sa.Column("text_current", sa.Text(), nullable=False),
        sa.Column("status", _enum("transcriptsegmentstatus"), nullable=False, server_default="ai"),
        sa.Column("edited_by", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column(
            "search_vector",
            postgresql.TSVECTOR(),
            sa.Computed("to_tsvector('simple'::regconfig, COALESCE(text_current, ''::text))", persisted=True),
            nullable=True,
        ),
        sa.UniqueConstraint("media_file_id", "track_index", "seq", name="uq_transcript_segments_file_track_seq"),
        sa.CheckConstraint("start_ms >= 0 AND end_ms >= start_ms", name="ck_transcript_segments_times"),
    )
    op.create_index("ix_transcript_segments_speaker_id", "transcript_segments", ["speaker_id"])
    op.create_index(
        "ix_transcript_segments_search_vector",
        "transcript_segments",
        ["search_vector"],
        postgresql_using="gin",
    )
    # Only where pg_trgm is ALREADY there. Never CREATE EXTENSION here.
    has_trgm = bind.execute(
        sa.text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")
    ).first() is not None
    if has_trgm:
        op.create_index(
            _TRGM_INDEX,
            "transcript_segments",
            ["text_current"],
            postgresql_using="gin",
            postgresql_ops={"text_current": "gin_trgm_ops"},
        )

    # 5 ── words ───────────────────────────────────────────────────────────
    op.create_table(
        "transcript_words",
        sa.Column("segment_id", _uuid(), sa.ForeignKey("transcript_segments.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("idx", sa.Integer(), primary_key=True),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("word", sa.Text(), nullable=False),
        sa.Column("probability", sa.Float(), nullable=True),
        sa.CheckConstraint("idx >= 0", name="ck_transcript_words_idx"),
        sa.CheckConstraint("start_ms >= 0 AND end_ms >= start_ms", name="ck_transcript_words_times"),
        sa.CheckConstraint(
            "probability IS NULL OR (probability >= 0 AND probability <= 1)",
            name="ck_transcript_words_probability",
        ),
    )

    # 6 ── edits ───────────────────────────────────────────────────────────
    op.create_table(
        "transcript_edits",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("segment_id", _uuid(), sa.ForeignKey("transcript_segments.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("old_text", sa.Text(), nullable=False),
        sa.Column("new_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column("resolution", _enum("transcripteditresolution"), nullable=False, server_default="pending"),
        sa.Column("resolved_by", _uuid(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_transcript_edits_segment_id", "transcript_edits", ["segment_id"])

    # 7 ── pipeline jobs ───────────────────────────────────────────────────
    op.create_table(
        "snippet_jobs",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("media_file_id", _uuid(), sa.ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("stage", sa.String(32), nullable=False),
        sa.Column("status", _enum("snippetjobstatus"), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.UniqueConstraint("media_file_id", "stage", name="uq_snippet_jobs_file_stage"),
        sa.CheckConstraint("attempts >= 0", name="ck_snippet_jobs_attempts"),
    )

    # 8 ── snippets ────────────────────────────────────────────────────────
    op.create_table(
        "snippets",
        sa.Column("id", _uuid(), primary_key=True),
        sa.Column("media_file_id", _uuid(), sa.ForeignKey("media_files.id", ondelete="CASCADE"), nullable=False),
        sa.Column("speaker_id", _uuid(), sa.ForeignKey("snippet_speakers.id", ondelete="SET NULL"), nullable=True),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(255), nullable=True),
        sa.Column("quote", sa.Text(), nullable=True),
        sa.Column("topics", postgresql.ARRAY(sa.Text()), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("viral_score", sa.Float(), nullable=True),
        sa.Column("status", _enum("snippetstatus"), nullable=False, server_default="suggested"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=_now()),
        sa.CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name="ck_snippets_times"),
    )
    op.create_index("ix_snippets_media_file_id", "snippets", ["media_file_id"])
    op.create_index("ix_snippets_speaker_id", "snippets", ["speaker_id"])


def downgrade() -> None:
    # Reverse order of creation; dropping a table drops its own indexes and
    # constraints, including the conditional trigram index.
    for table in (
        "snippets",
        "snippet_jobs",
        "transcript_edits",
        "transcript_words",
        "transcript_segments",
        "snippet_track_speakers",
        "snippet_speakers",
        "snippet_project_settings",
    ):
        op.drop_table(table)
    bind = op.get_bind()
    for name in reversed(list(_ENUMS)):
        postgresql.ENUM(name=name).drop(bind, checkfirst=True)
