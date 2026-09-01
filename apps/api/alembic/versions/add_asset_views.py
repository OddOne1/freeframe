"""asset_views: which version each user has actually opened (CLAUDE.md §108).

One row per (user, asset), updated in place — the only question it answers is
"has this user seen the CURRENT latest version", which is what the asset
card's unseen-version badge needs.

No backfill. Every existing (user, asset) pair simply has no row, which reads
as "never seen" — so the badge appears once for assets that already have more
than one version. Backfilling "seen" would be a guess about what people have
looked at, and guessing the wrong way hides a new version from someone.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "add_asset_views"
down_revision = "add_new_version_notif"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "asset_views",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("asset_id", UUID(as_uuid=True), sa.ForeignKey("assets.id", ondelete="CASCADE"), nullable=False),
        # SET NULL, not CASCADE: deleting a version must not erase the record
        # that this user had seen up to that point.
        sa.Column("last_seen_version_id", UUID(as_uuid=True), sa.ForeignKey("asset_versions.id", ondelete="SET NULL"), nullable=True),
        sa.Column("last_seen_version_number", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("user_id", "asset_id", name="uq_asset_views_user_asset"),
    )
    op.create_index("ix_asset_views_user_id", "asset_views", ["user_id"])
    op.create_index("ix_asset_views_asset_id", "asset_views", ["asset_id"])


def downgrade() -> None:
    op.drop_index("ix_asset_views_asset_id", table_name="asset_views")
    op.drop_index("ix_asset_views_user_id", table_name="asset_views")
    op.drop_table("asset_views")
