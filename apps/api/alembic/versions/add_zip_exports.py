"""zip_exports: server-built multi-file downloads (CLAUDE.md §143).

Revision ID: add_zip_exports
Revises: add_transcription_ctl
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "add_zip_exports"
down_revision: Union[str, Sequence[str], None] = "add_transcription_ctl"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The enum is created explicitly rather than inline so the downgrade can
    # drop it. An inline Enum() leaves the type behind, and a later upgrade
    # then fails with "type already exists" — this project has had a
    # migration crash-loop in production before (CLAUDE.md, the enum-cast
    # incident), so the tidier path is worth the extra lines.
    status = postgresql.ENUM(
        "pending", "building", "ready", "failed", name="zipexportstatus"
    )
    status.create(op.get_bind(), checkfirst=True)
    # create_type=False is load-bearing, not tidiness: without it
    # create_table below emits CREATE TYPE a SECOND time and the migration
    # dies with DuplicateObject — having already created the type, so the
    # retry fails identically. That is the enum crash-loop shape CLAUDE.md
    # records from the add_user_global_role incident, in a different guise.
    status_col = postgresql.ENUM(
        "pending", "building", "ready", "failed",
        name="zipexportstatus", create_type=False,
    )

    op.create_table(
        "zip_exports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("cache_key", sa.String(64), nullable=False),
        sa.Column(
            "share_link_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("share_links.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "project_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("s3_key", sa.String(1024), nullable=False),
        sa.Column("status", status_col, nullable=False, server_default="pending"),
        sa.Column("file_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("files_done", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "manifest",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_zip_exports_cache_key", "zip_exports", ["cache_key"])
    op.create_index("ix_zip_exports_share_link_id", "zip_exports", ["share_link_id"])
    op.create_index("ix_zip_exports_project_id", "zip_exports", ["project_id"])


def downgrade() -> None:
    op.drop_index("ix_zip_exports_project_id", table_name="zip_exports")
    op.drop_index("ix_zip_exports_share_link_id", table_name="zip_exports")
    op.drop_index("ix_zip_exports_cache_key", table_name="zip_exports")
    op.drop_table("zip_exports")
    postgresql.ENUM(name="zipexportstatus").drop(op.get_bind(), checkfirst=True)
