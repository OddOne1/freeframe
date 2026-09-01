"""Add `new_version` to the notificationtype enum (CLAUDE.md §108).

`ALTER TYPE ... ADD VALUE` rather than recreating the type, matching
add_camera_sidecar_types.py and a11ce9b821a0 — recreating would need every
dependent column rewritten, and this only adds a value nothing yet stores.

IF NOT EXISTS makes the migration re-runnable, which this project has been
bitten by before: a migration that fails halfway and cannot be re-applied
turns into an api crash-loop.
"""
from alembic import op

revision = "add_new_version_notif"
down_revision = "add_media_proxy_1080p_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TYPE notificationtype ADD VALUE IF NOT EXISTS 'new_version'")


def downgrade() -> None:
    # Postgres cannot drop a value from an enum. Removing it would mean
    # recreating the type and rewriting every dependent column — far more
    # destructive than leaving an unused label in place.
    pass
