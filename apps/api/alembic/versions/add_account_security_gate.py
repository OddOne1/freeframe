"""Backup address, the onboarding-gate waiver, and the passwordless cut-off (§200).

Four columns, no data rewritten, no existing session touched.

**users.backup_email / users.backup_email_verified_at** — the second address.
Both NULL for every existing row, which is exactly the state the onboarding
gate exists to resolve: everyone is gated on their next request, nobody has
anything taken away, and no guess is made on a user's behalf about which of
their addresses should receive password resets. Guessing would be the one
genuinely dangerous option here — seeding `backup_email = email` would satisfy
the gate for everybody while leaving the single-mailbox problem this whole
change exists to fix completely intact, and it would do it silently.

**users.account_gate_waived_at** — the escape hatch. A gate on an undeliverable
address is a lockout, so a superadmin (or `scripts/clear_account_gate.py`) can
set this and let one user back in. NULL everywhere at migration time; nothing
in the deploy writes it.

**site_settings.password_required_after** — when magic-code sign-in closes for
accounts that have no password at all. Filled with `now() + 30 days` for the
one existing row, so the window is measured from THIS instance's deploy rather
than from a date compiled into the code. A fresh install that has no
site_settings row yet gets NULL from the column default, which reads as "never"
— see the column's comment.

`server_default=None` on all four: these are genuinely absent, not zero, and a
default would make "this user has not chosen a backup address" and "this user
chose nothing" indistinguishable.

Revision ID: add_account_security_gate
Revises: add_email_smtp_security
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_account_security_gate"
down_revision: Union[str, Sequence[str], None] = "add_email_smtp_security"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("backup_email", sa.String(length=255), nullable=True))
    op.add_column(
        "users",
        sa.Column("backup_email_verified_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("account_gate_waived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "site_settings",
        sa.Column("password_required_after", sa.DateTime(timezone=True), nullable=True),
    )

    # Thirty days from the moment this migration runs, for the singleton row
    # if one exists. `now()` is the database's clock rather than the
    # migration process's, matching how every other timestamp in this schema
    # is produced.
    #
    # Guarded on IS NULL so re-running against a partially-migrated database
    # cannot quietly extend a window an operator has already shortened.
    op.execute(
        "UPDATE site_settings "
        "SET password_required_after = now() + interval '30 days' "
        "WHERE password_required_after IS NULL"
    )


def downgrade() -> None:
    op.drop_column("site_settings", "password_required_after")
    op.drop_column("users", "account_gate_waived_at")
    op.drop_column("users", "backup_email_verified_at")
    op.drop_column("users", "backup_email")
