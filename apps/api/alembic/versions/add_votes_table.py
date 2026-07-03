"""add votes table

Revision ID: add_votes_table
Revises: project_storage_limit
Create Date: 2026-07-02

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_votes_table'
down_revision = 'project_storage_limit'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'votes',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('asset_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
        sa.ForeignKeyConstraint(['asset_id'], ['assets.id']),
        sa.ForeignKeyConstraint(['user_id'], ['users.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('asset_id', 'user_id', name='uq_votes_asset_user'),
    )
    op.create_index('ix_votes_asset_id', 'votes', ['asset_id'], unique=False)
    op.create_index('ix_votes_user_id', 'votes', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_votes_user_id', table_name='votes')
    op.drop_index('ix_votes_asset_id', table_name='votes')
    op.drop_table('votes')
