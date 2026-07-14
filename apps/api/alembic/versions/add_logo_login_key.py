"""add logo_login_s3_key to site_settings

Revision ID: add_logo_login_key
Revises: add_first_last_name
Create Date: 2026-07-14
"""
from alembic import op
import sqlalchemy as sa

revision = 'add_logo_login_key'
down_revision = 'add_first_last_name'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('site_settings', sa.Column('logo_login_s3_key', sa.String(), nullable=True))


def downgrade():
    op.drop_column('site_settings', 'logo_login_s3_key')
