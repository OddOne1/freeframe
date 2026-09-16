"""Two-factor authentication: TOTP secret, enrolment flag, backup codes (§191).

Three columns on `users` and one on `site_settings`.

`require_2fa` defaults to FALSE, and that is the whole safety of this
migration: an already-deployed self-hosted install keeps logging in exactly
as it does today until an admin turns enforcement on. Nothing here can lock
anyone out — `totp_enabled` is false for every existing row too, so no
existing user is asked for a code they have never set up.

`totp_secret_encrypted` holds a Fernet token, never a plaintext secret; see
services/totp_service.py. `backup_codes_hashed` is JSON rather than a child
table, matching `share_links.allowed_download_variants`: a short fixed-size
list, read and rewritten whole, never queried into.

Revision ID: add_two_factor_auth
Revises: add_share_show_comments
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_two_factor_auth"
down_revision: Union[str, Sequence[str], None] = "add_share_show_comments"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("totp_secret_encrypted", sa.String(length=512), nullable=True)
    )
    op.add_column(
        "users",
        sa.Column(
            "totp_enabled", sa.Boolean(), nullable=False, server_default="false"
        ),
    )
    # JSON, not JSONB: this is never queried into, only read and rewritten as
    # a whole list, and JSON matches what `preferences` on the same table
    # already uses.
    op.add_column("users", sa.Column("backup_codes_hashed", sa.JSON(), nullable=True))

    op.add_column(
        "site_settings",
        sa.Column(
            "require_2fa", sa.Boolean(), nullable=False, server_default="false"
        ),
    )


def downgrade() -> None:
    op.drop_column("site_settings", "require_2fa")
    op.drop_column("users", "backup_codes_hashed")
    op.drop_column("users", "totp_enabled")
    op.drop_column("users", "totp_secret_encrypted")
