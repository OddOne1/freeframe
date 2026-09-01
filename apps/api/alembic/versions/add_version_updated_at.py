"""Add AssetVersion.updated_at as a heartbeat for the stuck-processing sweeper (§114).

Revision ID: add_version_updated_at
Revises: add_version_progress
Create Date: 2026-09-01

Backfill: existing rows get created_at, which is the most truthful value
available -- nothing older is known about them. The practical effect is that
any version already sitting at `processing` when this deploys looks stale
immediately and is swept on the next run, which is correct: those are exactly
the orphaned rows this whole change exists to clear.

NOT NULL with a server_default, so the column is populated for every existing
row in the same statement and there is no window where a reader sees null.
"""
from alembic import op
import sqlalchemy as sa

revision = "add_version_updated_at"
down_revision = "add_version_progress"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "asset_versions",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )
    # Existing rows: seed from created_at rather than leaving them all at the
    # migration's own timestamp, which would make every historical version
    # look freshly touched.
    op.execute("UPDATE asset_versions SET updated_at = created_at WHERE created_at IS NOT NULL")
    # The sweeper's query is (processing_status IN (...) AND updated_at < cutoff),
    # run every 15 minutes forever. Index it rather than scanning the table.
    op.create_index(
        "ix_asset_versions_status_updated_at",
        "asset_versions",
        ["processing_status", "updated_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_asset_versions_status_updated_at", table_name="asset_versions")
    op.drop_column("asset_versions", "updated_at")
