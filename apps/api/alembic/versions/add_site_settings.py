"""add site_settings table

Revision ID: add_site_settings
Revises: add_vote_stars
Create Date: 2026-07-03

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
import uuid


revision = 'add_site_settings'
down_revision = 'add_vote_stars'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'site_settings',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('org_name', sa.String(), nullable=False, server_default='FreeFrame'),
        sa.Column('logo_dark_s3_key', sa.String(), nullable=True),
        sa.Column('logo_light_s3_key', sa.String(), nullable=True),
        sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.func.now()),
    )
    op.execute(
        f"INSERT INTO site_settings (id, org_name) VALUES ('{uuid.uuid4()}', 'FreeFrame')"
    )


def downgrade() -> None:
    op.drop_table('site_settings')
