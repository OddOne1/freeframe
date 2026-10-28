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
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models.approval import Approval
from ..models.activity import AssetView
from ..models.asset import (
    Asset,
    AssetVersion,
    CarouselItem,
    MediaFile,
    ProcessingStatus,
)
from ..models.comment import Comment
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


def live_version(db: Session, asset_id, version_id) -> AssetVersion | None:
    """The live version of `asset_id` with this id, or None (§239).

    Three conditions, and all three are the SAME answer — None — on
    purpose: a version id that does not exist, one that belongs to a
    different asset, and one that has already been soft-deleted are
    indistinguishable to the caller. Anything else is an oracle: a client
    could tell a real id from an invented one, or learn that a version it
    may not see used to exist. `retry-processing` already had exactly this
    query inline and the share routes had it twice more; §239 needs it in
    four new places, so it lives here.

    Callers raise their own 404 — the message differs between "Version not
    found" and a share route's deliberately vaguer wording, and that is
    the caller's business.
    """
    return (
        db.query(AssetVersion)
        .filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        )
        .first()
    )


def live_version_count(db: Session, asset_id) -> int:
    """How many versions of this asset are not deleted (§239).

    Read under the asset's `FOR UPDATE` lock by the delete-version route:
    it is what "this is the last one" means, and two concurrent deletes of
    the last two versions must not both read 2.
    """
    return (
        db.query(func.count(AssetVersion.id))
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .scalar()
        or 0
    )


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


# ── §238 — the empty shell of an upload that never finished ──────────────
#
# A version row and its `media_files` row are created by
# `/upload/initiate`, BEFORE a single byte moves. If the upload is then
# cancelled or abandoned, what is left is a shell: a row that claims a
# version number, holds no object, and (correctly) shows as `failed`.
#
# §239 made a version deletable on its own, SOFT, with its number retired
# — which is right for a real version: "v3" in a comment has to keep
# meaning the same upload. It is wrong for a shell. The shell never was a
# version of anything, so retiring its number means the next upload of
# that file silently becomes v7 after a cancelled v6, forever.
#
# So a shell is HARD-deleted: the two rows go away and the number is free
# again. That is only safe when the row really is empty, which is what the
# three refusals below are for — the store is asked, not assumed.

#: `remove_upload_shell` outcomes. Each caller maps these to its own
#: answer: the delete route to a status code, /upload/abort to "then just
#: mark it failed as before".
SHELL_REMOVED = "removed"
#: An object exists at the version's own key: the bytes landed and only the
#: commit was lost (§215 calls this "needs a person"). NOT an empty shell,
#: so nothing is deleted.
SHELL_OBJECT_PRESENT = "object_present"
#: The store could not be asked. "No answer" is never "no object" — the
#: same rule services/s3_service.py's `object_exists` is written for.
SHELL_STORE_UNREACHABLE = "store_unreachable"
#: Something in the database hangs off this version after all, or it has
#: more than one media row, or processing derivatives are recorded on it.
#: Whatever the reason, it is not an empty shell.
SHELL_NOT_EMPTY = "not_empty"


def note_upload_completed(version: AssetVersion) -> None:
    """Record that this version's upload is finished, if nothing has (§238).

    `/upload/complete` stamps `upload_completed_at` itself on the path
    that does the work. This is for the two paths that move a version into
    `processing` WITHOUT passing through it:

      * a /complete retry arriving at a version that is already
        `processing` or `ready` (an idempotent 200 that dispatches
        nothing);
      * `POST …/retry-processing`, which only ever runs on a version whose
        upload is finished — that is now enforced rather than assumed.

    Both matter because of what happens LATER: a row that reaches
    `processing` with this column still NULL and then fails would read as
    `failure_stage == "upload"` and be offered a Delete instead of the
    Restart it deserves. Stamping it here closes that.

    The value is the same expression §238's migration backfills with —
    `processing_started_at`, else `updated_at` — rather than `now()`, so a
    row's own history stays readable. Never overwritten: a real completion
    time already recorded is the better answer.
    """
    if version.upload_completed_at is not None:
        return
    version.upload_completed_at = (
        version.processing_started_at
        or version.updated_at
        or datetime.now(timezone.utc)
    )


def shell_dependents(db: Session, version: AssetVersion) -> dict:
    """Everything in the database that would be orphaned by a hard delete.

    Every table with a foreign key to `asset_versions` (verified against
    the live schema, five of them) is accounted for:

      * `comments`, `approvals`, `carousel_items` — counted here. All
        three are NO ACTION, so a hard delete with any of them present
        would raise a ForeignKeyViolation; and all three mean the version
        was real enough for someone to act on. None can exist on a version
        that was never playable, which is exactly why they are counted
        rather than assumed: if one ever does, this falls back to §239's
        soft delete.
      * `media_files` — the shell's own row, deleted with it. More than
        ONE is counted as a dependent instead: a carousel's extra rows
        carry keys of their own that the single HEAD below would not have
        checked.
      * `asset_views.last_seen_version_id` — ON DELETE SET NULL, so it
        cannot block anything; `remove_upload_shell` rewinds those rows
        rather than leaving a number pointing past the end.

    Derivatives recorded on the media row (`s3_key_processed`,
    `s3_key_thumbnail`, `proxy_1080p_key`, the transcript keys) are
    counted too: a shell cannot have any, and if it does then processing
    ran and there are objects in the bucket this does not know about.
    Sidecars hang off the ASSET (`sidecar_files.asset_id`) and notifications
    off the asset and the comment, so neither can reference a version at
    all.
    """
    media_files = (
        db.query(MediaFile).filter(MediaFile.version_id == version.id).all()
    )
    derivatives = sum(
        1 for mf in media_files
        if mf.s3_key_processed or mf.s3_key_thumbnail or mf.proxy_1080p_key
        or mf.s3_key_transcript or mf.s3_key_captions
    )
    return {
        "comments": db.query(func.count(Comment.id))
        .filter(Comment.version_id == version.id).scalar() or 0,
        "approvals": db.query(func.count(Approval.id))
        .filter(Approval.version_id == version.id).scalar() or 0,
        "carousel_items": db.query(func.count(CarouselItem.id))
        .filter(CarouselItem.version_id == version.id).scalar() or 0,
        "extra_media_files": max(0, len(media_files) - 1),
        "derivatives": derivatives,
        "media_files": media_files,
    }


def remove_upload_shell(db: Session, version: AssetVersion) -> str:
    """Free an incomplete upload's row and its number, or refuse (§238).

    MUST be called with the asset row held under `SELECT … FOR UPDATE` —
    the same lock `add_next_version` and §239's delete take, in the same
    order — because the number this frees is the number a concurrent
    `/upload/initiate` for the same asset is about to read.

    Does NOT commit: the caller owns the transaction, and both callers
    have other things in it (a status write, an audit log line).

    In order:

    1. **Abort any open multipart upload for this key**, best-effort. The
       upload id is not stored anywhere, so it is found the way §215's
       sweeper finds one: by listing the store under the key as a prefix.
       Every failure here is logged and swallowed — leftover parts are
       §215's job and are not a reason to keep a dead row (an abort that
       did not happen leaves parts §215 will reap; a row left behind
       burns a version number forever).
    2. **HEAD the version's own key.** This is the guard, and it is the
       one step that may not be skipped or guessed: an object there means
       the upload actually completed at the store and only the commit was
       lost, which is a recoverable asset and not an empty shell. A store
       that does not answer is not an answer.
    3. **Count what hangs off the row** (see `shell_dependents`). Anything
       at all, and the caller soft-deletes instead.
    4. **Rewind `asset_views`** that point at this version. The FK is SET
       NULL so the delete would succeed either way, but
       `last_seen_version_number` is a plain integer the unseen badge
       compares against: left at the shell's number it would suppress the
       badge for the NEXT upload, which gets that same number back.
    5. Delete the media row, then the version row.
    """
    from .s3_service import (
        abort_multipart_upload,
        list_multipart_uploads_all,
        object_exists,
    )

    dependents = shell_dependents(db, version)
    media_files = dependents.pop("media_files")
    key = media_files[0].s3_key_raw if media_files else None

    # ── 1. the store's open sessions for this key ───────────────────────
    if key:
        try:
            # The exact key as the prefix: one key can hold several open
            # uploads (a resumed file that was initiated twice), and all
            # of them are this version's.
            for upload in list_multipart_uploads_all(prefix=key):
                if upload["Key"] != key:
                    continue
                try:
                    abort_multipart_upload(key, upload["UploadId"])
                except Exception:  # noqa: BLE001 — NoSuchUpload included
                    logger.warning(
                        "§238: could not abort leftover upload %s at %s while "
                        "removing version %s; leaving it to §215",
                        upload["UploadId"], key, version.id, exc_info=True,
                    )
        except Exception:  # noqa: BLE001 — a listing we could not walk
            logger.warning(
                "§238: could not list open uploads at %s while removing "
                "version %s; leaving them to §215", key, version.id,
                exc_info=True,
            )

    # ── 2. is the key really empty? ─────────────────────────────────────
    if key:
        try:
            if object_exists(key):
                logger.warning(
                    "§238: refusing to remove version %s (asset %s): an object "
                    "exists at %s, so this upload completed at the store and "
                    "only the commit was lost",
                    version.id, version.asset_id, key,
                )
                return SHELL_OBJECT_PRESENT
        except Exception:  # noqa: BLE001 — every store failure, one decision
            logger.warning(
                "§238: could not check whether %s holds an object; leaving "
                "version %s alone", key, version.id, exc_info=True,
            )
            return SHELL_STORE_UNREACHABLE

    # ── 3. anything hanging off it? ─────────────────────────────────────
    if any(dependents.values()):
        logger.warning(
            "§238: version %s (asset %s) looked like an empty shell but is "
            "not: %s — soft-deleting instead",
            version.id, version.asset_id,
            ", ".join(f"{k}={v}" for k, v in dependents.items() if v),
        )
        return SHELL_NOT_EMPTY

    # ── 4. the unseen badge's memory of it ──────────────────────────────
    highest_remaining = (
        db.query(func.max(AssetVersion.version_number))
        .filter(
            AssetVersion.asset_id == version.asset_id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.id != version.id,
        )
        .scalar()
    )
    (
        db.query(AssetView)
        .filter(AssetView.last_seen_version_id == version.id)
        .update(
            {
                AssetView.last_seen_version_id: None,
                AssetView.last_seen_version_number: int(highest_remaining or 0),
            },
            synchronize_session=False,
        )
    )

    # ── 5. the rows themselves ──────────────────────────────────────────
    for media_file in media_files:
        db.delete(media_file)
    # Flushed before the parent goes, rather than trusting the unit of
    # work to order two deletes it was told nothing about: these models
    # declare no `relationship()`, only the raw foreign key.
    db.flush()
    db.delete(version)
    db.flush()
    logger.warning(
        "§238: version %s (v%s) of asset %s removed as an incomplete upload "
        "— row and media row hard-deleted, version number %s free again",
        version.id, version.version_number, version.asset_id,
        version.version_number,
    )
    return SHELL_REMOVED
