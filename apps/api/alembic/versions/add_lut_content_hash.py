"""Add luts.content_hash -- duplicate detection (CLAUDE.md §44).

Nullable, with NO backfill in the migration: computing it requires reading
every .cube back out of object storage, which a migration has no business
doing (it would turn a schema change into a long, failure-prone network
operation, inside a transaction, on a deploy).

Existing rows therefore start null, and a null hash matches nothing -- it
can neither block a new upload nor be blocked by one. Run
`apps/api/scripts/backfill_lut_hashes.py` afterwards to fill them in; until
then, duplicate detection covers everything uploaded from now on.

Indexed rather than uniquely constrained: uniqueness here is scoped (per
owner for personal, across is_platform_wide for platform), which a single
column constraint cannot express, and a partial unique index would reject
the pre-existing duplicates §43 exists to clean up by hand.

Revision ID: add_lut_content_hash
Revises: add_lut_subgroups
"""
from alembic import op
import sqlalchemy as sa


revision = "add_lut_content_hash"
down_revision = "add_lut_subgroups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("luts", sa.Column("content_hash", sa.String(length=64), nullable=True))
    op.create_index("ix_luts_content_hash", "luts", ["content_hash"])


def downgrade() -> None:
    op.drop_index("ix_luts_content_hash", table_name="luts")
    op.drop_column("luts", "content_hash")
