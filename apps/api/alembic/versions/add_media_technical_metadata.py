"""add technical_metadata JSONB to media_files

Revision ID: add_media_technical_metadata
Revises: add_ratings_visibility
Create Date: 2026-07-06

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_media_technical_metadata'
down_revision = 'add_ratings_visibility'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'media_files',
        sa.Column('technical_metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade():
    op.drop_column('media_files', 'technical_metadata')
