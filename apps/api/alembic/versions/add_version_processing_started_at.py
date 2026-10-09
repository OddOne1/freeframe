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

**This migration also widens `alembic_version.version_num` to VARCHAR(64),
and that has to happen before anything else it does.** Its own revision id
is 33 characters; Alembic creates that column as VARCHAR(32), and it writes
the id into it immediately after this `upgrade()` returns. On the live server
the chain therefore crashed the api with `value too long for type character
varying(32)` and was recovered by running the ALTER by hand. Production is
already stamped at this revision, so the id must NOT be renamed -- renaming
it would orphan the live database -- and this widening is what lets a FRESH
database apply the same chain without the manual step.

Two of the existing ids (`add_lut_groups_and_platform_wide`,
`add_transcription_to_media_files`) are exactly 32 characters, so the limit
was already touching: the next descriptive slug anyone wrote was going to
hit this whether or not it was this one.

The widening is guarded on the column's current width rather than run
unconditionally, so it is idempotent -- safe on the production database where
it is already 64, and safe on a column someone has widened further, which an
unguarded `TYPE VARCHAR(64)` would silently NARROW.

`downgrade()` deliberately does not put the column back. Narrowing it is only
safe if no stamped id needs the width, which this revision's own id does --
so the downgrade would have to decide what to do about the row recording it.
A column that is wider than necessary costs nothing.

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


#: Alembic's own default for `alembic_version.version_num`, and the width
#: this chain outgrew.
_DEFAULT_VERSION_NUM_WIDTH = 32

#: What it is widened to. 64 is Alembic's own documented ceiling for a
#: revision id and leaves room for every descriptive slug this project uses.
_WIDENED_VERSION_NUM_WIDTH = 64


def upgrade() -> None:
    # FIRST, before any schema change of this migration's own: Alembic writes
    # this revision's 33-character id into alembic_version the moment this
    # function returns, and that INSERT/UPDATE is what fails on a VARCHAR(32)
    # column. Widening it here is therefore not housekeeping -- it is the
    # precondition for this migration being recordable at all on a fresh
    # database.
    #
    # Guarded on the current width, which makes it idempotent in both
    # directions that matter: a no-op where it has already been widened (the
    # production database, where it was run by hand), and a no-op rather than
    # a NARROWING where someone has made it wider still. A NULL
    # character_maximum_length means an unbounded text column, which also
    # needs nothing done to it.
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'alembic_version'
                  AND column_name = 'version_num'
                  AND character_maximum_length IS NOT NULL
                  AND character_maximum_length < {_WIDENED_VERSION_NUM_WIDTH}
            ) THEN
                ALTER TABLE alembic_version
                    ALTER COLUMN version_num TYPE VARCHAR({_WIDENED_VERSION_NUM_WIDTH});
            END IF;
        END $$;
        """
    )

    op.add_column(
        "asset_versions",
        sa.Column("processing_started_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    # The column width is deliberately left alone -- see the module docstring.
    op.drop_column("asset_versions", "processing_started_at")
