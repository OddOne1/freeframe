"""Rename totp_enabled -> two_factor_enabled, add two_factor_method (§194).

Email can now be the PRIMARY second factor rather than only a fallback for
a lost authenticator, which makes `totp_enabled` a misleading name: it reads
True for a user who has no authenticator at all. Renamed rather than left,
because the next person to read it would believe it.

`two_factor_method` records what the user actually chose ("totp"/"email"),
NULL when not enrolled. Stored rather than inferred from whether
`totp_secret_encrypted` is null — that inference works today and is an
implementation detail deciding what a login screen renders.

Backfill: every already-enrolled row is "totp", because until this migration
that was the only thing enrolment could produce. Rows that are not enrolled
stay NULL.

A rename rather than add+copy+drop: ALTER ... RENAME COLUMN preserves the
data and the NOT NULL/default in place, and there is no window where two
columns disagree.

Revision ID: add_two_factor_method
Revises: add_two_factor_auth
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_two_factor_method"
down_revision: Union[str, Sequence[str], None] = "add_two_factor_auth"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("users", "totp_enabled", new_column_name="two_factor_enabled")
    op.add_column(
        "users", sa.Column("two_factor_method", sa.String(length=16), nullable=True)
    )
    # Anyone enrolled before this migration enrolled with TOTP — it was the
    # only option. Leaving them NULL would make the login screen unable to
    # say which code to ask for.
    op.execute(
        "UPDATE users SET two_factor_method = 'totp' WHERE two_factor_enabled = true"
    )


def downgrade() -> None:
    op.drop_column("users", "two_factor_method")
    op.alter_column("users", "two_factor_enabled", new_column_name="totp_enabled")
