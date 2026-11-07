"""SocialSnippet: remember that a person edited a clip.

One nullable column, `snippets.user_edited_at`, set by PATCH /snippets/{id}
whenever a person changes a clip's title, topics or in/out points. Clip
detection never replaces or deletes a row that has it, and does not create a
new suggestion that overlaps one (tasks/transcribe_tasks.py,
`replaceable_snippets` and `drop_overlapping_kept`).

NULL means "never edited by a person", which is every row that exists when
this runs: there is no record of earlier edits to backfill from, so none is
attempted.

Revision ID: add_snippet_edited_at
Revises: add_snippet_exports
"""

from alembic import op
import sqlalchemy as sa

revision = "add_snippet_edited_at"
# Re-point this if another migration merges onto add_snippet_exports first:
# `alembic heads` must print exactly one head.
down_revision = "add_snippet_exports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "snippets",
        sa.Column("user_edited_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("snippets", "user_edited_at")
