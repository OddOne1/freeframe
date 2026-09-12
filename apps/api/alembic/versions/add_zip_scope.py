"""zip_exports.scope — name a batch download after its share link (§175).

"all" or "selection". Existing rows default to "selection": it is the
conservative label, claiming no completeness that was never recorded.

Revision ID: add_zip_scope
Revises: add_zip_finalize_fields
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_zip_scope"
down_revision: Union[str, Sequence[str], None] = "add_zip_finalize_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "zip_exports",
        sa.Column(
            "scope", sa.String(length=16), nullable=False, server_default="selection"
        ),
    )


def downgrade() -> None:
    op.drop_column("zip_exports", "scope")
