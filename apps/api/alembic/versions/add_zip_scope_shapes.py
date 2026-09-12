"""zip_exports: wider scope + folder_name — the §177 naming scheme.

§175 stored "all" or "selection" in a VARCHAR(16). §177 replaces that with
the shape of the selection — "all", "selected", "single_folder",
"multiple_folders" — plus the folder's own name for the single-folder case,
which the server cannot look up: a batch request arrives already flattened
to asset ids, with no folder id in it.

Existing "selection" rows are rewritten to "selected", the same meaning
under §177's spelling. Nothing is lost: the column only ever fed the
served filename.

Revision ID: add_zip_scope_shapes
Revises: add_zip_scope
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_zip_scope_shapes"
down_revision: Union[str, Sequence[str], None] = "add_zip_scope"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 16 characters was exactly the length of "multiple_folders", with no
    # headroom — widen before writing any of the new values.
    op.alter_column(
        "zip_exports",
        "scope",
        existing_type=sa.String(length=16),
        type_=sa.String(length=32),
        existing_nullable=False,
        server_default="selected",
    )
    op.execute("UPDATE zip_exports SET scope = 'selected' WHERE scope = 'selection'")
    op.add_column(
        "zip_exports", sa.Column("folder_name", sa.String(length=255), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("zip_exports", "folder_name")
    # Back inside 16 characters before narrowing the column, or the ALTER
    # fails on any row §177 wrote.
    op.execute(
        "UPDATE zip_exports SET scope = 'selection' "
        "WHERE scope IN ('selected', 'single_folder', 'multiple_folders')"
    )
    op.alter_column(
        "zip_exports",
        "scope",
        existing_type=sa.String(length=32),
        type_=sa.String(length=16),
        existing_nullable=False,
        server_default="selection",
    )
