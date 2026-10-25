"""Add share_links.show_internal_comments — internal comments on a link are an option (§234 F1).

Additive and off by default. `server_default='false'` is what makes that
true for rows that already exist: every link created before this migration
keeps the behaviour it had, which for an internal comment is "it never left
the team". The column is NOT NULL so no route has to treat NULL as a third
state.

Nothing is backfilled and nothing else changes, so the downgrade is the
column going away again.

Revision ID: share_internal_comments
Revises: add_crc32_and_streamed_zip
"""
from alembic import op
import sqlalchemy as sa

revision = 'share_internal_comments'
down_revision = 'null_unowned_brand_keys'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'share_links',
        sa.Column(
            'show_internal_comments',
            sa.Boolean(),
            nullable=False,
            server_default=sa.text('false'),
        ),
    )


def downgrade():
    op.drop_column('share_links', 'show_internal_comments')
