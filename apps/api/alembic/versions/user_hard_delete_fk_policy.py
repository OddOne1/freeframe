"""per-table FK ondelete policy for users.id, so a hard user-delete doesn't
throw an FK violation on the first referencing row it hits. Three policies:

- CASCADE: rows that are meaningless without the user (memberships, votes,
  approvals, reactions, mentions, notifications, direct shares) disappear
  with them.
- SET NULL: rows that stay meaningful with an anonymous actor (archived_by,
  invited_by, assignee_id, actor-side activity log, folder/collection/
  share creator) just lose the pointer.
- SNAPSHOT-AND-NULLIFY: rows where the *name* still matters for display
  (assets, asset_versions, comments) get a frozen `*_name` snapshot column
  (set once at creation, never updated -- same pattern as
  projects.created_by_name from task 8) alongside SET NULL, so the byline
  survives even though the FK doesn't.

Revision ID: user_hard_delete_fk_policy
Revises: add_user_global_role
Create Date: 2026-07-23

"""
from alembic import op
import sqlalchemy as sa

revision = 'user_hard_delete_fk_policy'
down_revision = 'add_user_global_role'
branch_labels = None
depends_on = None


# Every FK below was created unnamed in its origin migration (confirmed by
# grepping every create_table call across alembic/versions/ before writing
# this), so Postgres auto-named them <table>_<column>_fkey -- the default
# it applies to any unnamed FK constraint.
CASCADE_FKS = [
    ('approvals', 'user_id'),
    ('mentions', 'mentioned_user_id'),
    ('notifications', 'user_id'),
    ('project_members', 'user_id'),
    ('comment_reactions', 'user_id'),
    ('asset_shares', 'shared_with_user_id'),
    ('votes', 'user_id'),
]

# (table, column, was_not_null) -- was_not_null drives both whether upgrade()
# needs an ALTER COLUMN and whether downgrade() should undo it.
SET_NULL_FKS = [
    ('activity_logs', 'user_id', False),
    ('assets', 'assignee_id', False),
    ('folders', 'created_by', True),
    ('projects', 'archived_by', False),
    ('project_members', 'invited_by', False),
    ('collections', 'created_by', True),
    ('collection_shares', 'created_by', True),
    ('share_links', 'created_by', True),
    ('asset_shares', 'shared_by', True),
]

# (table, column, snapshot_name_column) -- all three were NOT NULL.
SNAPSHOT_FKS = [
    ('assets', 'created_by', 'created_by_name'),
    ('asset_versions', 'created_by', 'created_by_name'),
    ('comments', 'author_id', 'author_name'),  # already nullable pre-migration
]


def _fk_name(table: str, column: str) -> str:
    return f"{table}_{column}_fkey"


def _retarget(table: str, column: str, ondelete: str):
    name = _fk_name(table, column)
    op.drop_constraint(name, table, type_='foreignkey')
    op.create_foreign_key(name, table, 'users', [column], ['id'], ondelete=ondelete)


def _backfill_name(table: str, column: str, name_col: str):
    # CONCAT (not ||) treats a NULL first_name as empty string, matching
    # User.name's fallback to last_name alone.
    op.execute(f"""
        UPDATE {table}
        SET {name_col} = COALESCE(NULLIF(TRIM(CONCAT(users.first_name, ' ', users.last_name)), ''), users.last_name)
        FROM users
        WHERE users.id = {table}.{column}
    """)


def upgrade():
    for table, column in CASCADE_FKS:
        _retarget(table, column, 'CASCADE')

    for table, column, was_not_null in SET_NULL_FKS:
        if was_not_null:
            op.alter_column(table, column, nullable=True)
        _retarget(table, column, 'SET NULL')

    for table, column, name_col in SNAPSHOT_FKS:
        op.add_column(table, sa.Column(name_col, sa.String(length=255), nullable=True))
        _backfill_name(table, column, name_col)
        if table != 'comments':  # comments.author_id was already nullable
            op.alter_column(table, column, nullable=True)
        _retarget(table, column, 'SET NULL')


def downgrade():
    for table, column, name_col in SNAPSHOT_FKS:
        op.drop_constraint(_fk_name(table, column), table, type_='foreignkey')
        op.create_foreign_key(_fk_name(table, column), table, 'users', [column], ['id'])
        if table != 'comments':
            op.alter_column(table, column, nullable=False)
        op.drop_column(table, name_col)

    for table, column, was_not_null in SET_NULL_FKS:
        op.drop_constraint(_fk_name(table, column), table, type_='foreignkey')
        op.create_foreign_key(_fk_name(table, column), table, 'users', [column], ['id'])
        if was_not_null:
            op.alter_column(table, column, nullable=False)

    for table, column in CASCADE_FKS:
        op.drop_constraint(_fk_name(table, column), table, type_='foreignkey')
        op.create_foreign_key(_fk_name(table, column), table, 'users', [column], ['id'])
