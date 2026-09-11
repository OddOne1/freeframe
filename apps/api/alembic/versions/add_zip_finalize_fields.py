"""zip_exports: widen total_bytes, add bytes_done and phase (§147).

`total_bytes` was a 4-byte Integer, so any archive past 2.1GB raised
NumericValueOutOfRange on the very last commit of an otherwise successful
build. Widened to BigInteger. `bytes_done` and `phase` make the upload half
of a build observable at all — previously it reported nothing.

Revision ID: add_zip_finalize_fields
Revises: add_zip_progress_at
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_zip_finalize_fields"
down_revision: Union[str, Sequence[str], None] = "add_zip_progress_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # No USING clause needed: every existing value already fits, this only
    # widens the range.
    op.alter_column(
        "zip_exports",
        "total_bytes",
        existing_type=sa.Integer(),
        type_=sa.BigInteger(),
        existing_nullable=False,
        existing_server_default="0",
    )
    op.add_column(
        "zip_exports",
        sa.Column(
            "bytes_done", sa.BigInteger(), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "zip_exports",
        sa.Column("phase", sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("zip_exports", "phase")
    op.drop_column("zip_exports", "bytes_done")
    # Narrowing back would fail on any row holding a real multi-GB size, which
    # is the entire point of the upgrade. USING clamps rather than erroring, so
    # a downgrade stays possible; the clamped rows are cache entries that
    # rebuild on demand.
    op.execute(
        "ALTER TABLE zip_exports ALTER COLUMN total_bytes TYPE integer "
        "USING least(total_bytes, 2147483647)::integer"
    )
