"""Allocating the next `version_number` for an asset (§236, §236b).

Two endpoints start a new version of an existing file:

* `POST /upload/initiate` with `asset_id` (routers/upload.py)
* `POST /assets/{asset_id}/versions` (routers/assets.py) — what the web
  app's own "upload a new version" button calls

They both have to answer the same question, "what number does the next
version of this asset get", and the answer has two halves that are easy to
get wrong separately:

1. **`max()` over ALL rows, soft-deleted ones included.**
   `uq_asset_versions_asset_version` spans every row in the table, so a
   number is retired when its version is deleted, not recycled. A query
   filtered to `deleted_at IS NULL` reuses the latest deleted version's
   number and dies on the insert.

2. **Computed under `SELECT … FOR UPDATE` on the asset row.** Otherwise
   two concurrent new versions of one file read the same highest number
   and one of them dies on the insert.

Either mistake is an `IntegrityError` the routers do not catch — a 500
after the user has already picked a file. §236 fixed both in
`/upload/initiate` and left `POST /assets/{id}/versions` out of scope,
where the same two lines of numbering sat untouched and still 500ed.
§236b did not fix it a second time: the logic lives here, once, and both
routers call it. A third copy is what this module exists to prevent.

`routers/upload.py` keeps `_next_version_number` / `_add_next_version`
bound as module-level aliases of these two functions, so §236's tests and
any `patch("…routers.upload._add_next_version")` keep working.
"""

from __future__ import annotations

import logging

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion, ProcessingStatus
from ..models.user import User

logger = logging.getLogger(__name__)


def next_version_number(db: Session, asset_id) -> int:
    """One more than the highest number this asset has EVER used (§236).

    Over ALL rows, soft-deleted ones included. The old query filtered
    `deleted_at IS NULL`, but the unique constraint
    (`uq_asset_versions_asset_version`) spans every row there is — so
    deleting the latest version made the next upload of that asset reuse
    its number and die on the insert. Reproduced against real Postgres on
    both endpoints: two versions, soft-delete v2, initiate -> `duplicate
    key value violates unique constraint "uq_asset_versions_asset_version"`,
    i.e. a 500 for the user.

    The numbers of deleted versions are therefore retired rather than
    recycled, which is also the better answer for a reader: "v3" in a
    comment keeps meaning the same upload after v2 is deleted.

    `max()` rather than ORDER BY ... LIMIT 1 because the number, not the
    row, is what is wanted; the index on asset_id serves both.
    """
    highest = (
        db.query(func.max(AssetVersion.version_number))
        .filter(AssetVersion.asset_id == asset_id)
        .scalar()
    )
    return int(highest or 0) + 1


def add_next_version(db: Session, asset, current_user: User, locked: bool) -> AssetVersion:
    """Insert the next `AssetVersion` for `asset`, flushed and ready.

    `locked` says whether the caller holds `FOR UPDATE` on the asset row.
    Both endpoints that add a version to an EXISTING asset do — §236b took
    the lock in `POST /assets/{id}/versions` too — and that lock is what
    makes two concurrent initiates of the same asset pick different
    numbers, whichever endpoint each of them arrived at.

    ── Why there is a retry at all ─────────────────────────────────────
    The lock covers the two endpoints against each other and nothing
    else. It cannot cover a writer that does not take it: a migration, a
    repair script, a future code path that inserts an `AssetVersion`
    directly, or any caller passing `locked=False`. It is also a no-op on
    SQLite. So this path absorbs a collision rather than pretending it
    cannot happen — and the whole point of §236/§236b is that a collision
    here must never reach the user as a 500.

    ONE retry, and it is cheap: the collision surfaces on this `flush`,
    which happens before `create_multipart_upload` is ever called, so a
    retry costs a rollback and two small queries and can never leave an
    orphaned multipart upload behind. Only the locked path retries — on
    the unlocked one the asset row itself is typically new and pending in
    this transaction, where a rollback would discard it.

    The rollback a retry performs drops everything pending in the
    transaction, which is why both callers commit the storage-prefix lock
    in its OWN transaction before they get here (§14/§27) rather than
    leaving it pending across this insert.
    """
    for attempt in (1, 2):
        version = AssetVersion(
            asset_id=asset.id,
            version_number=next_version_number(db, asset.id),
            processing_status=ProcessingStatus.uploading,
            created_by=current_user.id,
            created_by_name=current_user.name,
        )
        db.add(version)
        try:
            db.flush()
            return version
        except IntegrityError:
            db.rollback()
            if not locked or attempt == 2:
                logger.warning(
                    "version number collision on asset %s (locked=%s, attempt %d)",
                    asset.id, locked, attempt, exc_info=True,
                )
                raise HTTPException(
                    status_code=409,
                    detail="Another upload for this file just took the next version "
                           "number. Please try again.",
                )
            # The rollback dropped the row lock, so take it again before
            # reading the highest number a second time.
            asset = (
                db.query(Asset)
                .filter(Asset.id == asset.id, Asset.deleted_at.is_(None))
                .with_for_update()
                .first()
            )
            if asset is None:
                raise HTTPException(status_code=404, detail="Asset not found")
    raise AssertionError("unreachable")
