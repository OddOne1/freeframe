"""Add share_links.fields_visibility (disabled/basic/full).

CLAUDE.md §33. How much asset metadata a share link exposes, independent
of the comments permission.

Backfill: every existing link gets `disabled`. Unlike §30's boolean-to-list
mapping there is no existing behaviour to preserve — page.tsx's Fields tab
was never gated by any setting, and the folder viewer's Fields tab never
rendered anything at all. Neither was a deliberately-shipped, configurable
feature, so defaulting to off is a decision rather than a regression.

Revision ID: add_share_fields_visibility
Revises: add_share_download_variants
"""
from alembic import op
import sqlalchemy as sa


revision = "add_share_fields_visibility"
down_revision = "add_share_download_variants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    fieldsvisibility = sa.Enum("disabled", "basic", "full", name="fieldsvisibility")
    fieldsvisibility.create(op.get_bind())

    # server_default seeds existing rows as well as new ones, which IS the
    # backfill here. Emitted by add_column as a typed DEFAULT rather than a
    # bare string, so the explicit ::fieldsvisibility cast the CLAUDE.md
    # hard rule warns about is not needed — any later raw-SQL UPDATE on this
    # column still would need it.
    op.add_column(
        "share_links",
        sa.Column(
            "fields_visibility",
            fieldsvisibility,
            nullable=False,
            server_default="disabled",
        ),
    )


def downgrade() -> None:
    op.drop_column("share_links", "fields_visibility")
    sa.Enum(name="fieldsvisibility").drop(op.get_bind())
