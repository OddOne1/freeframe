"""asset_versions.processing_started_at — queued is not the same as running (§219).

One additive, nullable column. Nothing is rewritten and no existing row is
touched.

`processing_status` is set to `processing` at DISPATCH, by whoever queues the
work. On a busy `transcoding` queue (concurrency 2, `worker_prefetch_multiplier=1`)
a version can then sit at `processing` for hours before a worker frees up, with
nothing touching the row in the meantime — so `sweep_stuck_processing`, which
fails anything whose `updated_at` has not moved in 45 minutes, could not tell a
file waiting its turn from a file whose worker had died. Measured on the live
server during a 641 GiB import: two 95 GiB originals were relabelled `failed`
while they were still queued and perfectly healthy.

This column is the missing distinction. NULL means "queued, or never started";
a timestamp means a worker really did begin the work. Only `process_asset`
fills it in, and every dispatch path clears it back to NULL.

NULL for every existing row, which is both accurate (none of them recorded a
start) and the safe direction: a NULL row is treated as queued, so it can never
be swept by the 45-minute silence rule — only by the far longer
STUCK_QUEUED_HOURS backstop. The opposite default would have made every row in
the table instantly eligible for the short rule.

`server_default=None` deliberately: "no worker has started this" is genuinely
absent, not a zero time, and a default would make it indistinguishable from a
real start.

Revision ID: add_version_processing_started_at
Revises: add_account_security_gate
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_version_processing_started_at"
down_revision: Union[str, Sequence[str], None] = "add_account_security_gate"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "asset_versions",
        sa.Column("processing_started_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("asset_versions", "processing_started_at")
