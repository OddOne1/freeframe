"""add lut_groups, Lut.group_id, Lut.is_platform_wide

No enum types anywhere in this migration — is_platform_wide is a plain
Boolean and lut_groups has no enum column — so the double-CREATE-TYPE
failure that hit add_sidecar_files (explicit Enum.create() followed by
op.create_table() creating the same type again in one transaction) cannot
recur here. Nothing below calls .create() on a type.

Revision ID: add_lut_groups_and_platform_wide
Revises: add_sidecar_files
Create Date: 2026-07-30

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_lut_groups_and_platform_wide'
down_revision = 'add_sidecar_files'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'lut_groups',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        # CASCADE: a personal library's organization has no meaning without
        # its owner, same reasoning as Lut.owner_id.
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_lut_groups_owner_id', 'lut_groups', ['owner_id'])

    # server_default applies to existing rows too, so every LUT uploaded
    # before this migration is correctly non-platform-wide.
    op.add_column(
        'luts',
        sa.Column('is_platform_wide', sa.Boolean(), nullable=False, server_default='false'),
    )
    op.add_column('luts', sa.Column('group_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index('ix_luts_group_id', 'luts', ['group_id'])
    # SET NULL so deleting a group ungroups its LUTs instead of cascading
    # the LUTs away with it.
    op.create_foreign_key(
        'fk_luts_group_id', 'luts', 'lut_groups', ['group_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_luts_group_id', 'luts', type_='foreignkey')
    op.drop_index('ix_luts_group_id', table_name='luts')
    op.drop_column('luts', 'group_id')
    op.drop_column('luts', 'is_platform_wide')

    op.drop_index('ix_lut_groups_owner_id', table_name='lut_groups')
    op.drop_table('lut_groups')
