"""bigint file size

Revision ID: bigint_file_size
Revises: 8ca3dffea55f
Create Date: 2026-07-01

"""
from alembic import op
import sqlalchemy as sa

revision = 'bigint_file_size'
down_revision = '8ca3dffea55f'
branch_labels = None
depends_on = None

def upgrade():
    op.alter_column('media_files', 'file_size_bytes',
              existing_type=sa.Integer(),
              type_=sa.BigInteger(),
              existing_nullable=False)
    op.alter_column('comment_attachments', 'file_size_bytes',
              existing_type=sa.Integer(),
              type_=sa.BigInteger(),
              existing_nullable=False)

def downgrade():
    op.alter_column('media_files', 'file_size_bytes',
              existing_type=sa.BigInteger(),
              type_=sa.Integer(),
              existing_nullable=False)
    op.alter_column('comment_attachments', 'file_size_bytes',
              existing_type=sa.BigInteger(),
              type_=sa.Integer(),
              existing_nullable=False)
