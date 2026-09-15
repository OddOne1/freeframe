"""Add share_links.show_comments — reading comments, separate from posting.

§188. `permission` (view/comment/approve) was doing two jobs: it decided
both whether a viewer may POST a comment and, through the frontend's
`use-share-sidebar`, whether the comments panel existed at all. So a
view-only link hid the team's existing discussion outright, with no way to
show a client the conversation without also letting them join it.

The server always treated these as separate operations — GET
/share/{token}/comments has never had a permission gate, only POST does —
so this column adds the missing half rather than new authorization.

Backfill preserves today's behaviour exactly, which the column default
alone would NOT: `server_default="true"` would switch comments ON for every
existing view-only link the moment this deploys, exposing internal
discussion on links already in clients' hands. So existing rows are set
from what the frontend currently derives, `permission != 'view'`, and
nothing visibly changes until an owner flips the new toggle.

`'view'::sharepermission` is cast explicitly for clarity, not necessity:
verified against Postgres 15 that the uncast comparison also works, because
an unknown literal takes its type from the comparison. CLAUDE.md's hard rule
covers ASSIGNING a literal to an enum column, which genuinely does raise
DatatypeMismatch and crash-looped a deploy here (add_user_global_role.py,
2026-07-20). This is the neighbouring case; the cast costs nothing and says
which type is meant.

Revision ID: add_share_show_comments
Revises: add_site_settings_timezone
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "add_share_show_comments"
down_revision: Union[str, Sequence[str], None] = "add_site_settings_timezone"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "share_links",
        sa.Column(
            "show_comments", sa.Boolean(), nullable=False, server_default="true"
        ),
    )
    # The backfill the default cannot do. New links get true; existing ones
    # keep exactly what they show today.
    op.execute(
        "UPDATE share_links SET show_comments = (permission != 'view'::sharepermission)"
    )


def downgrade() -> None:
    op.drop_column("share_links", "show_comments")
