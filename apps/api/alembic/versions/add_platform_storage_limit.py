"""add platform-wide total storage limit to site_settings

Revision ID: add_platform_storage_limit
Revises: user_hard_delete_fk_policy
Create Date: 2026-07-28

"""
from alembic import op
import sqlalchemy as sa


revision = 'add_platform_storage_limit'
down_revision = 'user_hard_delete_fk_policy'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('site_settings', sa.Column('total_storage_limit_bytes', sa.BigInteger(), nullable=True))


def downgrade() -> None:
    op.drop_column('site_settings', 'total_storage_limit_bytes')
