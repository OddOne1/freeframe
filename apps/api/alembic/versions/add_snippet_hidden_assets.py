"""SocialSnippet: files a project owner has hidden from it.

One new table, `snippet_hidden_assets`: a row means "this asset is not shown
in SocialSnippet" -- not in search, suggest, the clip player or anything
that edits a clip. Nothing existing is altered, backfilled or deleted;
hiding never touches the transcript, the clips, the jobs or the exports,
and deleting the row (unhide) brings all of it back as it was.

── Deleting ──────────────────────────────────────────────────────────────
`asset_id` is CASCADE: when purge_service deletes the asset, its hidden
marker goes with it. `project_id` is CASCADE for the same reason at project
level. `hidden_by` is SET NULL, matching user_hard_delete_fk_policy.

Revision ID: add_snippet_hidden_assets
Revises: add_snippet_edited_at
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "add_snippet_hidden_assets"
# Re-point this if another migration merges onto add_snippet_edited_at
# first: `alembic heads` must print exactly one head.
down_revision = "add_snippet_edited_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "snippet_hidden_assets",
        sa.Column(
            "asset_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True,
        ),
        sa.Column(
            "project_id", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column(
            "hidden_by", postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        ),
    )
    op.create_index(
        "ix_snippet_hidden_assets_project_id", "snippet_hidden_assets", ["project_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_snippet_hidden_assets_project_id", table_name="snippet_hidden_assets")
    op.drop_table("snippet_hidden_assets")
