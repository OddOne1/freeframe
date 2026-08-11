"""Human-readable S3 key prefixes: projects.storage_slug + storage_date_prefix

New uploads key objects under
`raw/{YYMMDD}_{slug}_{project_id}/...` instead of `raw/{project_id}/...`
(CLAUDE.md §14).

**Existing objects are deliberately NOT migrated**, and neither are the
`s3_key_*` columns that point at them. They stay on the old UUID-only
format forever. Both columns are therefore nullable with no backfill: a
project only gets a slug when it next accepts an upload.

No enum types are created here -- `op.add_column` with plain String, which
is the combination that has always migrated cleanly in this project. (The
failure mode to avoid is `.create()` on an enum alongside `op.create_table`;
see add_sidecar_files.)

Revision ID: add_project_storage_prefix
Revises: add_lut_groups_and_platform_wide
Create Date: 2026-08-11

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_project_storage_prefix'
down_revision = 'add_lut_groups_and_platform_wide'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('storage_slug', sa.String(length=40), nullable=True))
    op.add_column('projects', sa.Column('storage_date_prefix', sa.String(length=6), nullable=True))

    # Enforced in the database, not just in the service layer: the app-side
    # check is a read-then-write and loses a concurrent race, and a
    # duplicated slug defeats the only thing this feature exists for.
    #
    # A plain UNIQUE index is right rather than a partial one -- Postgres
    # treats NULLs as distinct, so every not-yet-locked project (all of
    # them, immediately after this migration) coexists happily.
    op.create_index(
        'uq_projects_storage_slug', 'projects', ['storage_slug'], unique=True
    )


def downgrade() -> None:
    op.drop_index('uq_projects_storage_slug', table_name='projects')
    op.drop_column('projects', 'storage_date_prefix')
    op.drop_column('projects', 'storage_slug')
