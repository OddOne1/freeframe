# add favicon to site_settings
#
# Revision ID: add_favicon
# Revises: add_project_archiving
# Create Date: 2026-07-08

from alembic import op
import sqlalchemy as sa
revision = 'add_favicon'
down_revision = 'add_project_archiving'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('site_settings', sa.Column('favicon_s3_key', sa.String(), nullable=True))

def downgrade():
    op.drop_column('site_settings', 'favicon_s3_key')