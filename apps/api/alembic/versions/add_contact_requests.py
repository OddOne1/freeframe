"""Contact form: contact_requests table + email_settings.contact_target_email.

CLAUDE.md §47.

The table follows share_link_activity's shape (timestamped rows, descending
created_at index) because the only query it serves is a recency count.

No default for contact_target_email: null means "not configured", and the
form refuses to send rather than delivering somewhere arbitrary.

Revision ID: add_contact_requests
Revises: add_platform_lut_groups
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "add_contact_requests"
down_revision = "add_platform_lut_groups"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_settings",
        sa.Column("contact_target_email", sa.String(length=255), nullable=True),
    )

    op.create_table(
        "contact_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        # SET NULL, not CASCADE: a submission is a record of something that
        # happened, and hard-deleting the account should not rewrite history
        # or the 30-day count.
        sa.Column(
            "sender_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("sender_email", sa.String(length=255), nullable=False),
        sa.Column("sender_name", sa.String(length=255), nullable=True),
        sa.Column("subject", sa.String(length=255), nullable=True),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("target_email", sa.String(length=255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_contact_requests_sender_id", "contact_requests", ["sender_id"])
    op.create_index(
        "ix_contact_requests_created",
        "contact_requests",
        [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_contact_requests_created", table_name="contact_requests")
    op.drop_index("ix_contact_requests_sender_id", table_name="contact_requests")
    op.drop_table("contact_requests")
    op.drop_column("email_settings", "contact_target_email")
