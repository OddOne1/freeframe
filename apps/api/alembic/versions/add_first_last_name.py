# split users.name into first_name / last_name
#
# Revision ID: add_first_last_name
# Revises: add_theme_colors
# Create Date: 2026-07-14

from alembic import op
import sqlalchemy as sa

revision = 'add_first_last_name'
down_revision = 'add_theme_colors'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('first_name', sa.String(length=255), nullable=True))
    op.add_column('users', sa.Column('last_name', sa.String(length=255), nullable=True))

    # Backfill from the existing name column: split on the first space.
    # "John Smith" -> first_name=John, last_name=Smith
    # "Madonna"    -> first_name=NULL, last_name=Madonna
    op.execute("""
        UPDATE users
        SET
            first_name = CASE
                WHEN position(' ' in name) > 0 THEN split_part(name, ' ', 1)
                ELSE NULL
            END,
            last_name = CASE
                WHEN position(' ' in name) > 0 THEN substring(name from position(' ' in name) + 1)
                ELSE name
            END
    """)

    op.alter_column('users', 'last_name', nullable=False)
    op.drop_column('users', 'name')


def downgrade():
    op.add_column('users', sa.Column('name', sa.String(length=255), nullable=True))
    op.execute("""
        UPDATE users
        SET name = COALESCE(first_name || ' ' || last_name, last_name)
    """)
    op.alter_column('users', 'name', nullable=False)
    op.drop_column('users', 'first_name')
    op.drop_column('users', 'last_name')
