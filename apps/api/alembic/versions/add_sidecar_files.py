"""add sidecar_files (ASC CDL / ALE / camera XML)

Revision ID: add_sidecar_files
Revises: add_email_settings
Create Date: 2026-07-30

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_sidecar_files'
down_revision = 'add_email_settings'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Don't call sidecartype.create() here -- op.create_table() below already
    # creates the enum type as a side effect of the enum column (via
    # SQLAlchemy's Enum.create_type, on by default). Creating it explicitly
    # first and then reusing the same object in the column caused
    # `CREATE TYPE sidecartype` to run twice in one transaction and fail with
    # "type already exists" on every attempt, regardless of starting DB
    # state -- confirmed 2026-07-30 after it failed identically even
    # immediately following a clean DROP TYPE.
    sidecartype = sa.Enum('cdl', 'ale', 'camera_xml', name='sidecartype')

    op.create_table(
        'sidecar_files',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('asset_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('sidecar_type', sidecartype, nullable=False),
        sa.Column('original_filename', sa.String(length=500), nullable=False),
        sa.Column('s3_key', sa.String(length=1000), nullable=False),
        sa.Column('parsed_metadata', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('uploaded_by', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['asset_id'], ['assets.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['uploaded_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_sidecar_files_asset_id', 'sidecar_files', ['asset_id'])


def downgrade() -> None:
    op.drop_index('ix_sidecar_files_asset_id', table_name='sidecar_files')
    op.drop_table('sidecar_files')
    sa.Enum(name='sidecartype').drop(op.get_bind())
