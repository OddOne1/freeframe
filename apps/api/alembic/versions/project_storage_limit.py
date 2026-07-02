"""project storage limit

Revision ID: project_storage_limit
Revises: bigint_file_size
Create Date: 2026-07-02

"""
from alembic import op
import sqlalchemy as sa

revision = 'project_storage_limit'
down_revision = 'bigint_file_size'
branch_labels = None
depends_on = None

def upgrade():
    op.add_column('projects',
        sa.Column('storage_limit_bytes', sa.BigInteger(), nullable=True)
    )

def downgrade():
    op.drop_column('projects', 'storage_limit_bytes')
