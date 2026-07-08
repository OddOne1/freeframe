# add theme_colors to site_settings
#
# Revision ID: add_theme_colors
# Revises: add_favicon
# Create Date: 2026-07-08

from alembic import op
from sqlalchemy.dialects import postgresql
import sqlalchemy as sa
revision = 'add_theme_colors'
down_revision = 'add_favicon'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('site_settings', sa.Column('theme_colors', postgresql.JSONB(), nullable=True))

def downgrade():
    op.drop_column('site_settings', 'theme_colors')