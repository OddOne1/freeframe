"""add archived_at and archived_by to projects

Revision ID: add_project_archiving
Revises: add_media_technical_metadata
Create Date: 2026-07-07

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_project_archiving'
down_revision = 'add_media_technical_metadata'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('projects', sa.Column('archived_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        'projects',
        sa.Column('archived_by', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=True),
    )


def downgrade():
    op.drop_column('projects', 'archived_by')
    op.drop_column('projects', 'archived_at')
