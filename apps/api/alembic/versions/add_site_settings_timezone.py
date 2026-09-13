"""site_settings.timezone — admin-configurable wall clock (§182).

The daily maintenance jobs (purge_expired_trash, reconcile_file_sizes) used
to run at a fixed UTC hour, which meant "03:00" was only accidentally
out-of-hours for anyone. FreeFrame is self-hostable, so the zone belongs in
settings rather than in the code.

"UTC" for existing rows and as the column default: it is what the behaviour
already effectively was, so applying this migration changes nothing until
an admin actually picks a zone.

Celery's own `timezone` setting is NOT derived from this column and stays
"UTC" — see services/schedule_window.py for why.

Revision ID: add_site_settings_timezone
Revises: add_media_file_size_verified
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_site_settings_timezone"
down_revision: Union[str, Sequence[str], None] = "add_media_file_size_verified"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "site_settings",
        sa.Column(
            "timezone", sa.String(length=64), nullable=False, server_default="UTC"
        ),
    )


def downgrade() -> None:
    op.drop_column("site_settings", "timezone")
