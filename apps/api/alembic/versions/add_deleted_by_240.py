"""assets/folders/asset_versions.deleted_by + deleted_by_name — who deleted it (§240).

Six nullable columns, two per table, NO backfill.

── Why two columns and not one ───────────────────────────────────────────
`deleted_by` is the FK, so the trash filter ("show me what Eddie deleted")
is an indexed equality on a uuid and the restore rule is an id comparison
rather than a name match. `deleted_by_name` is the denormalised snapshot,
set in the same transaction and never updated afterwards — exactly the
pattern `assets.created_by_name` and `projects.created_by_name` already
use, and for the same reason: `users.id` is retargeted to ON DELETE SET
NULL by user_hard_delete_fk_policy, so a hard-deleted account would
otherwise take the one readable fact about the deletion with it.

── Why no backfill ───────────────────────────────────────────────────────
Nothing in this schema records who deleted anything. There is no activity
row for a deletion (ActivityAction has no member for one — see §239's
note on that), so every candidate source would be a guess. A row deleted
before this migration therefore reads NULL, which the API presents as an
unknown deleter and which only a project owner or a superadmin may
restore (§240 C): a guessed name would hand the restore right to whoever
the guess named.

── Indexes ───────────────────────────────────────────────────────────────
None added. The trash listing is always scoped to ONE project and to
`deleted_at IS NOT NULL` first, which `ix_assets_project_folder_deleted`
and `ix_folders_project_deleted` already serve; `deleted_by` is applied
to that already-tiny row set, as is the editor visibility rule. A trash
with enough rows for an index on `deleted_by` to matter is a trash that
needs purging, not an index. `asset_versions` has no project-scoped index
to begin with and is reached through `asset_id`, which is indexed.

Revision ID: add_deleted_by_240
Revises: add_version_upload_completed_at
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_deleted_by_240'
down_revision = 'add_version_upload_completed_at'
branch_labels = None
depends_on = None

#: The three tables that carry a soft delete a user can perform and undo.
#: `projects`, `project_members`, `comments`, `luts` and the rest have a
#: `deleted_at` too, and are deliberately NOT touched here — none of them
#: appears in Recently Deleted and none has a restore rule to answer.
_TABLES = ("assets", "folders", "asset_versions")


def upgrade():
    for table in _TABLES:
        op.add_column(
            table,
            sa.Column('deleted_by', postgresql.UUID(as_uuid=True), nullable=True),
        )
        op.add_column(table, sa.Column('deleted_by_name', sa.String(255), nullable=True))
        # Named explicitly: b4623f8f4339_initial.py created this table's
        # other FKs unnamed, and an unnamed constraint cannot be dropped
        # by name in the downgrade below.
        op.create_foreign_key(
            f'fk_{table}_deleted_by_users',
            table,
            'users',
            ['deleted_by'],
            ['id'],
            ondelete='SET NULL',
        )


def downgrade():
    # Reversible and lossless in the only direction that matters: the two
    # columns hold nothing that is not also in the trash row itself, and
    # re-running the upgrade gives the same NULLs it gave the first time
    # (there was never a backfill to undo).
    for table in _TABLES:
        op.drop_constraint(f'fk_{table}_deleted_by_users', table, type_='foreignkey')
        op.drop_column(table, 'deleted_by_name')
        op.drop_column(table, 'deleted_by')
