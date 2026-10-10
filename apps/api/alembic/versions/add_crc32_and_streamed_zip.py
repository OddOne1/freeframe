"""object_checksums, and the columns a streamed zip export needs (§217).

Revision ID: add_crc32_and_streamed_zip
Revises: add_version_processing_started_at

Three things, one revision, because they ship together and a half-applied
version of this is a download that answers `Range` against a layout it
cannot compute:

  1. `object_checksums` — one row per stored object, holding the CRC-32 a
     ZIP_STORED entry's header and central-directory record both require.
     See models/object_checksum.py for why this is a table rather than two
     columns on `media_files`.
  2. `zip_exports.is_streamed` / `archive_size` / `etag`.
  3. A `preparing` value on the `zipexportstatus` enum.

**NO BACKFILL HAPPENS HERE, deliberately.** The owner's library already
holds hundreds of GB with no CRC, and a single 105 GB original takes
minutes to read through `zlib.crc32`. Doing that inside a migration would
mean a deploy that appears to hang for hours with the api container not yet
started — and a failure partway through would roll the whole transaction
back and have read those bytes for nothing. The backfill is a throttled,
resumable Celery task instead:

    docker compose -f docker-compose.prod.yml --env-file .env.prod -p freeframe \
      exec worker celery -A apps.api.tasks.celery_app call backfill_object_crc32

Until it has run, an export containing un-CRC'd files simply reports
`preparing` with its per-file and per-byte progress, and the lazy
`compute_object_crc32` dispatch handles exactly the files someone asked
for.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "add_crc32_and_streamed_zip"
down_revision: Union[str, Sequence[str], None] = "add_version_processing_started_at"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── the enum value ──────────────────────────────────────────────────
    # Safe inside a transaction on PG12+ as long as the new value is not
    # USED in the same transaction, which nothing below does. Same shape as
    # add_in_progress_status.
    op.execute("ALTER TYPE zipexportstatus ADD VALUE IF NOT EXISTS 'preparing'")

    # ── object_checksums ────────────────────────────────────────────────
    op.create_table(
        "object_checksums",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("s3_key", sa.String(1024), nullable=False),
        # BigInteger, not Integer: a CRC-32 is UNSIGNED 32-bit, so 0xFFFFFFFF
        # does not fit a 4-byte signed column. The same mistake cost §147 a
        # whole finished build at the last statement.
        sa.Column("crc32", sa.BigInteger(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    # UNIQUE, not merely indexed: the whole promise of this table is "read
    # each object once", and two rows for one key would let two tasks both
    # believe they still had work to do.
    op.create_index(
        "ix_object_checksums_s3_key", "object_checksums", ["s3_key"], unique=True
    )

    # ── zip_exports ─────────────────────────────────────────────────────
    # server_default on is_streamed so every EXISTING row — which does have a
    # real archive in `zip-exports/` and must keep downloading until its TTL
    # — reads as not-streamed without an UPDATE.
    op.add_column(
        "zip_exports",
        sa.Column(
            "is_streamed", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
    )
    op.add_column("zip_exports", sa.Column("archive_size", sa.BigInteger(), nullable=True))
    op.add_column("zip_exports", sa.Column("etag", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("zip_exports", "etag")
    op.drop_column("zip_exports", "archive_size")
    op.drop_column("zip_exports", "is_streamed")
    op.drop_index("ix_object_checksums_s3_key", table_name="object_checksums")
    op.drop_table("object_checksums")
    # Postgres cannot remove a value from an enum type without recreating
    # it, and recreating `zipexportstatus` would have to decide what to do
    # with every row using the value. Any row still at `preparing` is moved
    # to `failed` — it describes an export whose layout was never computed,
    # so there is nothing to keep — and the member itself stays defined,
    # which is harmless. Same reasoning as add_in_progress_status.
    op.execute("UPDATE zip_exports SET status = 'failed' WHERE status = 'preparing'")
