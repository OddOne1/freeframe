"""add ratings_visible_to_all to projects

Revision ID: add_ratings_visibility
Revises: add_site_settings
Create Date: 2026-07-06

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_ratings_visibility'
down_revision = 'add_site_settings'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column(
        'projects',
        sa.Column('ratings_visible_to_all', sa.Boolean(), nullable=False, server_default=sa.false()),
    )

def downgrade():
    op.drop_column('projects', 'ratings_visible_to_all')
