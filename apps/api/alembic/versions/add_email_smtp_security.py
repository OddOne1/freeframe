"""Add email_settings.smtp_security — three SMTP modes, not two (§199).

`_send_via_smtp` branched on a boolean: True meant SMTP + STARTTLS, and
False meant `SMTP_SSL` — implicit TLS, not "no TLS". So there was no way to
reach a plaintext SMTP server at all, and trying produced
"[SSL: WRONG_VERSION_NUMBER] wrong version number", which reads like a
certificate problem and is really the client speaking TLS to a server that
never offered it. Production is unaffected (Microsoft 365 is STARTTLS on
587), but the setting was a trap for any self-hoster with a relay on a
trusted network.

Nullable with no backfill, matching every other column in this table: null
means "not overridden", and the resolver then derives the mode from the
existing `smtp_use_tls` boolean — True → "starttls", False → "implicit_tls",
which is exactly what each of those DID before. Nobody's mail configuration
changes behaviour on this deploy, and the new "none" mode is reachable only
by an admin choosing it.

`smtp_use_tls` is deliberately kept rather than migrated away: it is still
what .env.prod holds, and dropping it would break an install that never
touches this table.

Revision ID: add_email_smtp_security
Revises: add_user_token_version
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_email_smtp_security"
down_revision: Union[str, Sequence[str], None] = "add_user_token_version"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "email_settings",
        sa.Column("smtp_security", sa.String(length=16), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("email_settings", "smtp_security")
