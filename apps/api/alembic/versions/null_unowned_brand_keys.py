"""Clear every brand-image key and avatar the server did not issue (§235).

Revision ID: null_unowned_brand_keys
Revises: add_crc32_and_streamed_zip

The routers now refuse an unowned key on the way in and refuse to sign one on
the way out (routers/branding.py, routers/site_settings.py, schemas/auth.py,
all via services/owned_keys.py). This clears what is already stored, because
until today three columns accepted any string a client sent:

  * `project_brandings.logo_s3_key` — any project editor could set it, and the
    response signed it with a token scoped to that key's whole S3 prefix.
    This is the one that was really exploitable.
  * `users.avatar_url` — PATCH /users/{user_id} copied any string from the
    body into it, and every response renders it as an <img src> for other
    users.
  * `site_settings.logo_*_s3_key` / `favicon_s3_key` — superadmin-only to
    write, but GET /site-settings is unauthenticated and signs them, and
    GET /site-settings/logo-image serves the light logo's raw bytes with no
    token and no expiry at all.

**The rule is NOT restated in SQL here.** It imports the same predicates the
routers use, reads the candidate rows, and decides in Python. A LIKE-based
WHERE clause would be a second copy of the rule that agrees with the first one
only on the day it is written — and this migration is the one place where
disagreeing is irreversible. The three tables are tiny (one branding row per
project, one settings row per instance, one row per user), so the row-by-row
pass costs nothing.

What is deliberately NOT touched:

  * Keys that pass. A real logo, a real avatar and a real instance logo are
    all left exactly as they are — that is the whole point of validating
    rather than truncating.
  * `users.avatar_url` values that have the shape POST /users/me/avatar
    stores. That route does NOT store an object key: it stores the finished
    proxy URL it minted, `/stream/hls/<file>?token=<jwt>`, with a ~5-year
    expiry (routers/users.py::upload_avatar). So the test here is that URL
    shape, not an `avatars/<user id>/` prefix, and it is a shape test rather
    than a signature check: verifying the JWT would mean that rotating
    `JWT_SECRET` turns this migration into one that erases every avatar on
    the instance.
  * Any other `*_s3_key` column in the schema. `assets`/`media_files`/
    `projects.poster_s3_key` and the LUT keys are written server-side from
    the upload pipeline and are not settable through a request body, so
    there is nothing here to clear — see §235's report for the read of each.

Count first, on production, before running this. Per-table SELECTs are in the
task report; the whole set is also this migration's own dry run, since
`upgrade()` logs the number it changed per table.
"""
import logging
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

try:  # alembic runs with apps/api on sys.path (see alembic/env.py)
    from services.owned_keys import (
        SITE_BRAND_IMAGE_COLUMNS,
        is_issued_avatar_url,
        is_owned_project_logo_key,
        is_owned_site_brand_image_key,
    )
except ImportError:  # imported as a package (tests, tooling)
    from apps.api.services.owned_keys import (
        SITE_BRAND_IMAGE_COLUMNS,
        is_issued_avatar_url,
        is_owned_project_logo_key,
        is_owned_site_brand_image_key,
    )

revision: str = "null_unowned_brand_keys"
down_revision: Union[str, Sequence[str], None] = "add_crc32_and_streamed_zip"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

logger = logging.getLogger("alembic.runtime.migration")


def _null_project_logos(bind) -> int:
    rows = bind.execute(
        sa.text(
            "SELECT id, project_id, logo_s3_key FROM project_brandings "
            "WHERE logo_s3_key IS NOT NULL AND logo_s3_key <> ''"
        )
    ).fetchall()
    unowned = [
        row.id
        for row in rows
        if not is_owned_project_logo_key(row.project_id, row.logo_s3_key)
    ]
    for row_id in unowned:
        bind.execute(
            sa.text("UPDATE project_brandings SET logo_s3_key = NULL WHERE id = :id"),
            {"id": row_id},
        )
    return len(unowned)


def _null_avatars(bind) -> int:
    rows = bind.execute(
        sa.text(
            "SELECT id, avatar_url FROM users "
            "WHERE avatar_url IS NOT NULL AND avatar_url <> ''"
        )
    ).fetchall()
    unowned = [row.id for row in rows if not is_issued_avatar_url(row.avatar_url)]
    for row_id in unowned:
        bind.execute(
            sa.text("UPDATE users SET avatar_url = NULL WHERE id = :id"),
            {"id": row_id},
        )
    return len(unowned)


def _null_site_brand_images(bind) -> int:
    columns = ", ".join(SITE_BRAND_IMAGE_COLUMNS)
    rows = bind.execute(sa.text(f"SELECT id, {columns} FROM site_settings")).fetchall()
    cleared = 0
    for row in rows:
        for column in SITE_BRAND_IMAGE_COLUMNS:
            value = getattr(row, column)
            if not value:
                continue
            if is_owned_site_brand_image_key(column, value):
                continue
            bind.execute(
                sa.text(f"UPDATE site_settings SET {column} = NULL WHERE id = :id"),
                {"id": row.id},
            )
            cleared += 1
    return cleared


def upgrade() -> None:
    bind = op.get_bind()
    logos = _null_project_logos(bind)
    avatars = _null_avatars(bind)
    site = _null_site_brand_images(bind)
    # Logged at INFO, like alembic's own per-revision lines, so the deploy's
    # output records what this actually changed on THIS database. A dry run
    # beforehand is the SELECTs in the §235 report.
    logger.info(
        "§235 cleared unowned keys: %s project logo(s), %s avatar(s), "
        "%s site brand image column(s)",
        logos,
        avatars,
        site,
    )


def downgrade() -> None:
    """A no-op, and it cannot be anything else.

    The nulled values are gone: this migration records nowhere what any
    column used to hold, because every value it clears is one no part of the
    server would ever have written, and keeping a copy would mean keeping the
    attacker-supplied strings this revision exists to remove. Downgrading
    restores the OLD CODE's permissiveness, not the old data — a logo, an
    avatar or an instance logo cleared here has to be uploaded again.
    """
