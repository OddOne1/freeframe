"""add admin ProjectRole, split project creator from current owner

Revision ID: add_project_admin_role
Revises: add_logo_login_key
Create Date: 2026-07-16

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_project_admin_role'
down_revision = 'add_logo_login_key'
branch_labels = None
depends_on = None


def upgrade():
    # Postgres won't let a freshly-added enum value be used in the same
    # transaction it was added in, so this has to commit on its own before
    # the data backfill below (which assigns role='admin') can run.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE projectrole ADD VALUE IF NOT EXISTS 'admin'")

    op.add_column('projects', sa.Column('created_by_name', sa.String(length=255), nullable=True))
    op.add_column('projects', sa.Column('created_by_email', sa.String(length=255), nullable=True))

    # Snapshot creator identity for existing rows. CONCAT (not ||) treats a
    # NULL first_name as empty string, matching User.name's fallback to
    # last_name alone.
    op.execute("""
        UPDATE projects
        SET created_by_name = COALESCE(NULLIF(TRIM(CONCAT(users.first_name, ' ', users.last_name)), ''), users.last_name),
            created_by_email = users.email
        FROM users
        WHERE users.id = projects.created_by
    """)

    # Today role='owner' means "full access" and is held by any number of
    # members per project. Going forward it means the single current true
    # owner. Demote everyone except the project's recorded creator so the
    # unique index below doesn't reject existing data -- the creator's own
    # membership (if still role='owner') becomes the sole true owner;
    # everyone else who had full access keeps it under the new 'admin' role.
    op.execute("""
        UPDATE project_members
        SET role = 'admin'
        FROM projects
        WHERE project_members.project_id = projects.id
          AND project_members.role = 'owner'
          AND project_members.deleted_at IS NULL
          AND (projects.created_by IS NULL OR project_members.user_id != projects.created_by)
    """)

    op.alter_column('projects', 'created_by', nullable=True)
    op.drop_constraint('projects_created_by_fkey', 'projects', type_='foreignkey')
    op.create_foreign_key(
        'projects_created_by_fkey', 'projects', 'users', ['created_by'], ['id'], ondelete='SET NULL',
    )

    op.create_index(
        'uq_project_members_one_owner',
        'project_members',
        ['project_id'],
        unique=True,
        postgresql_where=sa.text("role = 'owner' AND deleted_at IS NULL"),
    )


def downgrade():
    op.drop_index('uq_project_members_one_owner', table_name='project_members')

    op.drop_constraint('projects_created_by_fkey', 'projects', type_='foreignkey')
    op.create_foreign_key(
        'projects_created_by_fkey', 'projects', 'users', ['created_by'], ['id'],
    )
    op.alter_column('projects', 'created_by', nullable=False)

    op.drop_column('projects', 'created_by_email')
    op.drop_column('projects', 'created_by_name')

    # Members demoted to 'admin' above are NOT restored to 'owner' -- that
    # data transformation isn't reversible without knowing which were
    # originally the crown. The 'admin' enum value itself also can't be
    # dropped from a Postgres enum type without recreating it; left in
    # place as a (henceforth unused, if this downgrade runs) valid value.
