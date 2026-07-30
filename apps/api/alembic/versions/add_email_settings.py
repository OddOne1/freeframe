"""add admin-editable email/SMTP settings

Deliberately its own table rather than columns on site_settings — the
site_settings GET endpoint is public, and mail credentials must never be
reachable from it. See models/email_settings.py.

Revision ID: add_email_settings
Revises: add_luts
Create Date: 2026-07-30

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_email_settings'
down_revision = 'add_luts'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'email_settings',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('mail_provider', sa.String(length=20), nullable=True),
        sa.Column('mail_from_address', sa.String(length=255), nullable=True),
        sa.Column('mail_from_name', sa.String(length=255), nullable=True),
        sa.Column('aws_mail_access_key_id', sa.String(length=255), nullable=True),
        # Fernet ciphertext — base64, materially longer than the plaintext.
        sa.Column('aws_mail_secret_access_key_encrypted', sa.String(length=2000), nullable=True),
        sa.Column('aws_mail_region', sa.String(length=64), nullable=True),
        sa.Column('smtp_host', sa.String(length=255), nullable=True),
        sa.Column('smtp_port', sa.Integer(), nullable=True),
        sa.Column('smtp_user', sa.String(length=255), nullable=True),
        sa.Column('smtp_password_encrypted', sa.String(length=2000), nullable=True),
        sa.Column('smtp_use_tls', sa.Boolean(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    # No backfill: every column null means "fall back to the env vars", so
    # an install that has never touched the new UI keeps behaving exactly as
    # it does today.


def downgrade() -> None:
    op.drop_table('email_settings')
