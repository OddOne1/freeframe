"""Add poster_thumb_s3_key to projects (CLAUDE.md §19c).

Project posters were stored exactly as uploaded -- up to 10MB of
full-resolution original -- and that same object was fetched everywhere a
poster renders, including a 32px table icon and a grid of small cards.
This column points at a downscaled derivative generated on upload.

Nullable with no backfill, deliberately: existing posters keep working
because _resolve_poster_thumb_url falls back to poster_s3_key whenever
this is NULL. Re-uploading a poster produces a thumbnail; nothing has to
be migrated, and nothing breaks if it never is. GIF posters keep a NULL
here permanently by design -- see _build_poster_thumbnail.

Revision ID: add_project_poster_thumb
Revises: add_project_storage_prefix
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_project_poster_thumb'
down_revision = 'add_project_storage_prefix'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'projects',
        sa.Column('poster_thumb_s3_key', sa.String(length=1024), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('projects', 'poster_thumb_s3_key')
