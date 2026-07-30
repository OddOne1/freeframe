"""add luts, project_lut_shares, and assets.applied_lut_id

Revision ID: add_luts
Revises: add_transcription_to_media_files
Create Date: 2026-07-30

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_luts'
down_revision = 'add_transcription_to_media_files'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'luts',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        # CASCADE: a personal library has no meaning without its owner.
        sa.Column('owner_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('s3_key', sa.String(length=1000), nullable=False),
        sa.Column('lut_size', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_luts_owner_id', 'luts', ['owner_id'])

    op.create_table(
        'project_lut_shares',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('project_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('lut_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('shared_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(['project_id'], ['projects.id']),
        sa.ForeignKeyConstraint(['lut_id'], ['luts.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['shared_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        # Prevents the same LUT being shared into one project twice.
        sa.UniqueConstraint('project_id', 'lut_id', name='uq_project_lut_shares_project_lut'),
    )
    op.create_index('ix_project_lut_shares_project_id', 'project_lut_shares', ['project_id'])
    op.create_index('ix_project_lut_shares_lut_id', 'project_lut_shares', ['lut_id'])

    op.add_column('assets', sa.Column('applied_lut_id', postgresql.UUID(as_uuid=True), nullable=True))
    op.create_foreign_key(
        'fk_assets_applied_lut_id', 'assets', 'luts', ['applied_lut_id'], ['id'], ondelete='SET NULL',
    )


def downgrade() -> None:
    op.drop_constraint('fk_assets_applied_lut_id', 'assets', type_='foreignkey')
    op.drop_column('assets', 'applied_lut_id')

    op.drop_index('ix_project_lut_shares_lut_id', table_name='project_lut_shares')
    op.drop_index('ix_project_lut_shares_project_id', table_name='project_lut_shares')
    op.drop_table('project_lut_shares')

    op.drop_index('ix_luts_owner_id', table_name='luts')
    op.drop_table('luts')
