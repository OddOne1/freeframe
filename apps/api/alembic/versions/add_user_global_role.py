"""replace User.is_superadmin with a 3-tier UserGlobalRole, add per-user storage_limit_bytes

Revision ID: add_user_global_role
Revises: add_project_admin_role
Create Date: 2026-07-20

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_user_global_role'
down_revision = 'add_project_admin_role'
branch_labels = None
depends_on = None

TWO_HUNDRED_GB = 200 * 1024 ** 3  # 214748364800


def upgrade():
    userglobalrole = sa.Enum('superadmin', 'superuser', 'user', name='userglobalrole')
    userglobalrole.create(op.get_bind())

    # server_default applies to every existing row too (not just new ones),
    # so this seeds everyone to 'user' first -- overridden by the backfill
    # below for accounts that actually held is_superadmin.
    op.add_column('users', sa.Column('role', userglobalrole, nullable=False, server_default='user'))

    op.execute("""
        UPDATE users
        SET role = CASE WHEN is_superadmin THEN 'superadmin' ELSE 'superuser' END
    """)

    op.drop_column('users', 'is_superadmin')

    op.add_column(
        'users',
        sa.Column('storage_limit_bytes', sa.BigInteger(), nullable=True, server_default=str(TWO_HUNDRED_GB)),
    )


def downgrade():
    op.drop_column('users', 'storage_limit_bytes')

    op.add_column('users', sa.Column('is_superadmin', sa.Boolean(), nullable=False, server_default='false'))
    op.execute("UPDATE users SET is_superadmin = (role = 'superadmin')")
    op.drop_column('users', 'role')

    sa.Enum(name='userglobalrole').drop(op.get_bind())
