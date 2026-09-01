"""asset_versions.processing_progress — persisted transcode progress (§113).

The percent existed only as a Redis pub/sub event: if no client happened to be
subscribed at the moment it fired, it was gone, not merely delayed. Reloading
mid-transcode therefore had nothing to read, and the uploads panel fell back to
a hardcoded 0/100 guess.

Nullable with no backfill and no default. Null means "no progress has ever been
reported for this version", which is the truthful state for every row that
already exists, for images (whose processor has no progress callback), and for
anything queued but not started. Defaulting to 0 would make every historical
row claim to be a job sitting at 0%.
"""
import sqlalchemy as sa
from alembic import op

revision = "add_version_progress"
down_revision = "add_asset_views"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "asset_versions",
        sa.Column("processing_progress", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("asset_versions", "processing_progress")
