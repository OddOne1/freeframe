"""Per-file transcription toggle, cancellation handle and live progress (§127).

Revision ID: add_transcription_ctl
Revises: add_version_updated_at
Create Date: 2026-09-07

Backfill, stated explicitly because it is a behaviour decision and not a
formality: assets.transcription_enabled lands as TRUE for every existing row.
That is what the app already did — process_asset dispatched transcription for
every video and audio upload unconditionally — so defaulting to false would
silently switch off a feature people already have.

projects.transcription_default is nullable and is left NULL: "nobody has
chosen" is a different thing from "chosen false", and only the former should
fall through to the app-wide default.
"""
from alembic import op
import sqlalchemy as sa

revision = "add_transcription_ctl"
down_revision = "add_version_updated_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assets",
        sa.Column(
            "transcription_enabled",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
    )
    # 155 chars: Celery ids are UUID4 strings, with generous headroom for the
    # prefixed forms some result backends produce.
    op.add_column("media_files", sa.Column("transcription_task_id", sa.String(155), nullable=True))
    op.add_column("media_files", sa.Column("transcription_progress", sa.Integer(), nullable=True))
    op.add_column("projects", sa.Column("transcription_default", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("projects", "transcription_default")
    op.drop_column("media_files", "transcription_progress")
    op.drop_column("media_files", "transcription_task_id")
    op.drop_column("assets", "transcription_enabled")
