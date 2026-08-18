"""Replace share_links.allow_download with a per-variant permission list.

CLAUDE.md §30/§30b. A share link no longer says merely "downloads on/off";
it says WHICH of the six renderings it permits.

Legacy mapping, stated in the spec and asserted here rather than assumed:

    allow_download = true   ->  all six variants
    allow_download = false  ->  none

That is the only translation that preserves what every existing link does
today. A `true` link could fetch the original and nothing stopped it going
further, and a `false` link could fetch nothing.

Revision ID: add_share_download_variants
Revises: add_camera_sidecar_types
"""
from alembic import op
import sqlalchemy as sa


revision = "add_share_download_variants"
down_revision = "add_camera_sidecar_types"
branch_labels = None
depends_on = None


ALL_VARIANTS = (
    '["raw","raw_lut","proxy_720p","proxy_720p_lut","proxy_1080p","proxy_1080p_lut"]'
)


def upgrade() -> None:
    op.add_column(
        "share_links",
        sa.Column(
            "allowed_download_variants",
            sa.JSON(),
            nullable=False,
            server_default="[]",
        ),
    )

    # Backfill from the column being replaced, before dropping it.
    #
    # Cast explicitly rather than relying on an implicit one — this project
    # has been bitten by Postgres refusing exactly that (see CLAUDE.md's
    # hard rule on enum columns in raw SQL). JSON has the same problem: a
    # string literal is `text` until told otherwise.
    op.execute(
        sa.text(
            "UPDATE share_links "
            "SET allowed_download_variants = (:all_variants)::json "
            "WHERE allow_download = true"
        ).bindparams(all_variants=ALL_VARIANTS)
    )

    op.drop_column("share_links", "allow_download")


def downgrade() -> None:
    op.add_column(
        "share_links",
        sa.Column(
            "allow_download",
            sa.Boolean(),
            nullable=False,
            server_default="false",
        ),
    )

    # A link permitting ANY variant could download something, so it maps
    # back to true. This is lossy in one direction only — which variants
    # were permitted cannot be recovered from a boolean — and that is
    # inherent to the old column, not a shortcut taken here.
    op.execute(
        "UPDATE share_links "
        "SET allow_download = true "
        "WHERE json_array_length(allowed_download_variants) > 0"
    )

    op.drop_column("share_links", "allowed_download_variants")
