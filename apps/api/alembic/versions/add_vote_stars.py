"""add stars rating to votes

Revision ID: add_vote_stars
Revises: add_in_progress_status
Create Date: 2026-07-03

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_vote_stars'
down_revision = 'add_in_progress_status'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('votes', sa.Column('stars', sa.Integer(), nullable=True))
    op.execute("UPDATE votes SET stars = 5 WHERE stars IS NULL")
    op.alter_column('votes', 'stars', nullable=False)
    op.create_check_constraint('ck_votes_stars_range', 'votes', 'stars >= 1 AND stars <= 5')


def downgrade() -> None:
    op.drop_constraint('ck_votes_stars_range', 'votes', type_='check')
    op.drop_column('votes', 'stars')
