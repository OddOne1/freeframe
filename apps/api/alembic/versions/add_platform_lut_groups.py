"""Add lut_groups.is_platform -- shared, global LUT groups.

CLAUDE.md §39. Platform LUT groups are one shared set that any superadmin
can create, rename, delete and file into, visible identically to everyone.

Mirrors luts.is_platform_wide rather than making lut_groups.owner_id
nullable: a flag alongside unchanged ownership, so owner_id stays NOT NULL
and keeps recording who created the group.

Backfill: every existing group is personal, which is what they all are --
this column is the first way to express anything else.

Revision ID: add_platform_lut_groups
Revises: add_share_fields_visibility
"""
from alembic import op
import sqlalchemy as sa


revision = "add_platform_lut_groups"
down_revision = "add_share_fields_visibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "lut_groups",
        sa.Column("is_platform", sa.Boolean(), nullable=False, server_default="false"),
    )
    # Platform groups are listed on their own; the personal listing filters
    # by owner and this flag together.
    op.create_index("ix_lut_groups_is_platform", "lut_groups", ["is_platform"])


def downgrade() -> None:
    op.drop_index("ix_lut_groups_is_platform", table_name="lut_groups")
    op.drop_column("lut_groups", "is_platform")
