"""SocialSnippet exports: one row per rendered clip download.

One new table, `snippet_exports`. Nothing existing is altered or backfilled.

── Deleting ──────────────────────────────────────────────────────────────
An exported clip survives the deletion of its asset, so every FK to the
asset side — `snippets`, `media_files`, `asset_versions` — is ON DELETE SET
NULL, never CASCADE. `purge_service.purge_asset` deletes those rows; with
SET NULL it neither fails on this table nor takes it along. The row keeps
`s3_key` and `download_filename`, which is all a download needs, and the
object sits under `snippet-exports/`, a prefix purge never lists.
`project_id` is CASCADE: a deleted project takes its exports with it.
`created_by` is SET NULL, matching user_hard_delete_fk_policy.

── Value lists ───────────────────────────────────────────────────────────
`status` is a varchar with a CHECK, written out by hand here (a migration
must not change when a model does); tests/test_snippet_export.py compares
it with models/snippet_export.EXPORT_STATUSES.

`aspect` has no CHECK on purpose: the six ratios are validated by the API,
and a CHECK would turn every ratio added later into a migration.

Revision ID: add_snippet_exports
Revises: add_socialsnippet_data
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "add_snippet_exports"
# Re-point this if another migration merges onto add_socialsnippet_data
# first: `alembic heads` must print exactly one head.
down_revision = "add_socialsnippet_data"
branch_labels = None
depends_on = None

_STATUSES = ("queued", "running", "done", "failed", "expired")


def upgrade() -> None:
    op.create_table(
        "snippet_exports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "project_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column(
            "snippet_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("snippets.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "media_file_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("media_files.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "asset_version_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("asset_versions.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("start_ms", sa.Integer(), nullable=False),
        sa.Column("end_ms", sa.Integer(), nullable=False),
        sa.Column("aspect", sa.String(5), nullable=False),
        sa.Column("framing", sa.JSON(), nullable=True),
        sa.Column("caption_style", sa.JSON(), nullable=True),
        sa.Column("captions", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("progress", sa.Float(), nullable=False, server_default="0"),
        sa.Column("s3_key", sa.String(1000), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("download_filename", sa.String(255), nullable=True),
        sa.Column(
            "created_by", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("cache_key", name="uq_snippet_exports_cache_key"),
        sa.CheckConstraint(
            "status IN ({})".format(", ".join("'%s'" % s for s in _STATUSES)),
            name="ck_snippet_exports_status",
        ),
        sa.CheckConstraint("start_ms >= 0 AND end_ms > start_ms", name="ck_snippet_exports_times"),
        sa.CheckConstraint("progress >= 0 AND progress <= 1", name="ck_snippet_exports_progress"),
    )
    op.create_index("ix_snippet_exports_project_id", "snippet_exports", ["project_id"])
    op.create_index("ix_snippet_exports_snippet_id", "snippet_exports", ["snippet_id"])
    op.create_index("ix_snippet_exports_media_file_id", "snippet_exports", ["media_file_id"])
    op.create_index("ix_snippet_exports_expires_at", "snippet_exports", ["expires_at"])


def downgrade() -> None:
    # Dropping the table drops its indexes and constraints with it. The S3
    # objects under snippet-exports/ are NOT touched: a downgrade is a schema
    # operation, and deleting users' downloads is not one.
    op.drop_table("snippet_exports")
