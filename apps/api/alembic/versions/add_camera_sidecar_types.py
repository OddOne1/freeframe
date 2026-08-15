"""add camera-native sidecar types to sidecartype

Revision ID: add_camera_sidecar_types
Revises: add_project_poster_thumb
Create Date: 2026-08-15

Adds six values to the existing `sidecartype` enum (§23b/§23c): DJI flight
telemetry .SRT plus five camera-native clip-metadata formats.

`ALTER TYPE ... ADD VALUE` is used rather than recreating the type, matching
the three existing precedents in this directory (add_in_progress_status,
add_project_admin_role, a11ce9b821a0). Postgres 12+ permits ADD VALUE inside a
transaction block as long as the new value is not *used* in that same
transaction — nothing here inserts rows, so the migration is transaction-safe
on this project's PG 15.

IF NOT EXISTS keeps a re-run harmless, which matters because ADD VALUE cannot
be reversed: downgrade() deliberately does nothing rather than attempting the
drop-and-recreate dance, which would fail on any row already using a new value.
"""
from alembic import op

revision = 'add_camera_sidecar_types'
down_revision = 'add_project_poster_thumb'
branch_labels = None
depends_on = None


NEW_VALUES = (
    'dji_srt',
    'panasonic_clipinfo',
    'nikon_nksc',
    'red_rmd',
    'sony_bim',
    'canon_cif',
)


def upgrade() -> None:
    for value in NEW_VALUES:
        op.execute(f"ALTER TYPE sidecartype ADD VALUE IF NOT EXISTS '{value}'")


def downgrade() -> None:
    # Postgres has no DROP VALUE. Removing these would mean recreating the type
    # and rewriting every sidecar_files row, which would destroy any sidecar
    # already stored under one of the new types. Leaving the values in place is
    # harmless: nothing reads them unless a row uses them.
    pass
