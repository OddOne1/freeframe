"""add in_progress value to assetstatus enum

Revision ID: add_in_progress_status
Revises: add_votes_table
Create Date: 2026-07-03

"""
from alembic import op

revision = 'add_in_progress_status'
down_revision = 'add_votes_table'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Adding a value to an existing Postgres enum type. Safe within a transaction
    # on PG12+ as long as the new value isn't *used* in the same transaction.
    op.execute("ALTER TYPE assetstatus ADD VALUE IF NOT EXISTS 'in_progress'")


def downgrade() -> None:
    # Postgres does not support removing a value from an enum type without
    # recreating it. Reassign any rows using it back to 'draft' so the value
    # becomes unused; the enum member itself remains defined (harmless).
    op.execute("UPDATE assets SET status = 'draft' WHERE status = 'in_progress'")
