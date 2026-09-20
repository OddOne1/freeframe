"""Add users.token_version — session invalidation on privilege change (§199).

Access and refresh tokens carried only `sub`, `type` and `exp`, and
/auth/refresh re-minted a pair after checking nothing but that the user
existed and was not deactivated. Deactivation therefore ended a session
immediately (both get_current_user and /auth/refresh re-read `status`), but
nothing short of it did: turning 2FA off and on, having an admin reset it,
regenerating backup codes, or changing a password all left every open
session alive and renewing itself for the whole refresh window.

`token_version` closes that. Every token is minted carrying the value this
column held at the time, as a `tv` claim; the two places that accept a token
compare the two and reject a mismatch.

**Why the default matters more than the column.** Every session alive at the
moment this migration runs holds a token with no `tv` claim at all, and the
code reads a missing claim as 0 — which is exactly what `server_default="0"`
gives every existing row. So the deploy invalidates nothing and nobody is
logged out. Choosing any other starting value, or making the column
nullable, would have thrown out every live session on deploy for no benefit.

Revision ID: add_user_token_version
Revises: add_two_factor_method
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_user_token_version"
down_revision: Union[str, Sequence[str], None] = "add_two_factor_method"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # server_default rather than a backfill UPDATE: it fills existing rows in
    # the same statement AND keeps covering any INSERT that reaches this
    # table without going through the ORM. Both defaults are declared on the
    # model too, matching how `role` and `storage_limit_bytes` are handled
    # there — at least one real row has been inserted with NULL despite a
    # schema-level default existing.
    op.add_column(
        "users",
        sa.Column(
            "token_version",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("users", "token_version")
