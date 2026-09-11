"""zip_exports.progress_at — staleness detection for stuck builds (§146).

Revision ID: add_zip_progress_at
Revises: add_zip_exports
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_zip_progress_at"
down_revision: Union[str, Sequence[str], None] = "add_zip_exports"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "zip_exports",
        sa.Column("progress_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("zip_exports", "progress_at")
