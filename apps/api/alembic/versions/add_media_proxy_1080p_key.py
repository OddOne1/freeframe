"""Add media_files.proxy_1080p_key -- persisted download proxy for heavy sources.

CLAUDE.md §57. Nullable, no backfill: an asset without one behaves exactly
as it does today (every download re-encodes from the original), so existing
rows need nothing. Sources uploaded from here on get one only if they are
heavy enough to be worth it.

Not indexed: it is only ever read via a MediaFile already fetched by
version_id, never searched on.

Revision ID: add_media_proxy_1080p_key
Revises: add_lut_content_hash
"""
from alembic import op
import sqlalchemy as sa


revision = "add_media_proxy_1080p_key"
down_revision = "add_lut_content_hash"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "media_files",
        sa.Column("proxy_1080p_key", sa.String(length=1000), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("media_files", "proxy_1080p_key")
