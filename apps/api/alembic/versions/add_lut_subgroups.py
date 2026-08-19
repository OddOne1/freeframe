"""Add lut_groups.parent_group_id -- one level of LUT sub-groups.

CLAUDE.md §45. Exactly the "cheap column later" the flat design
anticipated.

Backfill: every existing group gets NULL, i.e. stays a top-level Main
group. Purely additive — no existing behaviour changes.

SET NULL rather than CASCADE: deleting a Main group promotes its Sub
groups to top level rather than taking them and their LUTs with it, which
matches how luts.group_id already behaves.

The one-level cap is enforced in routers/luts.py, not here — Postgres
cannot express "at most one level of self-reference" as a constraint.

Revision ID: add_lut_subgroups
Revises: add_contact_requests
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "add_lut_subgroups"
down_revision = "add_contact_requests"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "lut_groups",
        sa.Column("parent_group_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_lut_groups_parent",
        "lut_groups",
        "lut_groups",
        ["parent_group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_lut_groups_parent_group_id", "lut_groups", ["parent_group_id"])


def downgrade() -> None:
    op.drop_index("ix_lut_groups_parent_group_id", table_name="lut_groups")
    op.drop_constraint("fk_lut_groups_parent", "lut_groups", type_="foreignkey")
    op.drop_column("lut_groups", "parent_group_id")
