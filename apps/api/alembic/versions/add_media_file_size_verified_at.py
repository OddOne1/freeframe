"""media_files.size_verified_at — reconciled file sizes (§180).

`file_size_bytes` came from the client and was never corrected, while both
storage quotas and every storage figure in the admin UI are sums of it. It
is now overwritten with the object's real size when an upload completes;
this column records when that happened.

NULL on every existing row, which is accurate: none of them has been
checked. That is deliberately the same state a failed check leaves behind,
so a backfill has one query to run rather than two.

Revision ID: add_media_file_size_verified
Revises: add_zip_scope_shapes
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_media_file_size_verified"
down_revision: Union[str, Sequence[str], None] = "add_zip_scope_shapes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "media_files",
        sa.Column("size_verified_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("media_files", "size_verified_at")
