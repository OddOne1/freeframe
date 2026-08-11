"""Permanent deletion of soft-deleted assets and folders.

Used by both the scheduled 30-day sweep (tasks/purge_tasks.py) and the
owner/admin "Delete Permanently" endpoints (routers/folders.py). One
implementation deliberately: the FK ordering below is fiddly enough that
two copies would drift, and a drifted copy fails as either a FK violation
or orphaned storage.

──────────────────────────────────────────────────────────────────────────
FK AUDIT
──────────────────────────────────────────────────────────────────────────

Every FK pointing at `assets.id` and `folders.id` was checked against the
migrations, not just the models, because the two can disagree. Result:
**only `sidecar_files.asset_id` has ON DELETE CASCADE** (added later, in
add_sidecar_files.py). Every other reference was created unnamed and
without an ondelete in b4623f8f4339_initial.py, so Postgres defaults them
to NO ACTION — meaning a bare `DELETE FROM assets` raises
ForeignKeyViolation on the first referencing row it meets.

So everything below is deleted explicitly, children first:

  assets.id is referenced by
    asset_versions            -> media_files -> carousel_items
    comments                  -> annotations, comment_attachments,
                                 comment_reactions, mentions, notifications
    approvals                 (also references asset_versions)
    votes
    asset_metadata
    notifications
    activity_logs
    sidecar_files             (CASCADE, but deleted here anyway so its S3
                               objects can be collected first)
    share_links               (direct single-asset share)
    share_link_items          (one entry of a multi-item share)
    asset_shares              (direct user-to-user share)

  share_link_activity.asset_id is a plain UUID column with NO foreign key
  (models/share.py:107) — nothing to violate, but the rows are cleaned up
  anyway so a purged asset leaves no audit rows pointing at an id that no
  longer resolves.

  folders.id is referenced by
    assets.folder_id, folders.parent_id (self), share_links.folder_id,
    share_link_items.folder_id, asset_shares.folder_id

The user_hard_delete_fk_policy migration solved this same problem for
users.id by retargeting the constraints. That is not repeated here on
purpose: retargeting to CASCADE would change what *any* asset delete does
process-wide, including a future accidental one, and would silently
swallow tables added later. Explicit deletion fails loudly instead — a new
table with an asset_id raises a FK violation the sweep reports, rather
than quietly discarding its rows.

──────────────────────────────────────────────────────────────────────────
S3 LAYOUT
──────────────────────────────────────────────────────────────────────────

Deleting the five key columns on media_files is **not** sufficient, and
this is the part most likely to look finished while leaking storage:

  * `s3_key_processed` holds an HLS *prefix* for video
    (transcode_tasks.py:127, `result.hls_prefix`), not an object key.
    Deleting it as a key is a silent no-op that strands every .m3u8 and
    .ts segment — which is the bulk of the footage.
  * `transcode_tasks` writes `thumbnail_keys` (plural) but only stores
    `[0]`, so the rest are unreachable from the DB entirely.
  * Sidecar files and comment attachments are separate objects that no
    media_files row mentions.

So derivatives are removed by **prefix**, which covers everything written
under an asset regardless of whether a column happens to point at it:

  raw/{project}/{asset_id}/...          original uploads, per version
  processed/{project}/{asset_id}/...    HLS, mp3, webp, thumbs,
                                        transcript.json, captions.vtt
  sidecars/{project}/{asset_id}/...     CDL / ALE / camera XML

**`{project}` is not just the project id.** Since §14 it is either
`{project_id}` (everything written before that change) or
`{YYMMDD}_{slug}_{project_id}` (everything after). Nothing was migrated,
so both formats coexist permanently — and they coexist *within a single
asset*, because an asset uploaded beforehand keeps its old-format v1 and
gets a new-format v2 the next time someone uploads to it.

That is why the segment is recovered from the keys stored on this asset's
own rows (`candidate_project_prefixes`), never recomputed from
`project_id`. Both computed candidates are included as a backstop for an
asset whose media rows are gone. Listing a prefix that holds nothing
costs one no-op call; missing one leaks storage silently and invisibly,
and that asymmetry is what this module exists to respect.

Comment attachments are keyed by comment, not asset
(`comment-attachments/{comment_id}/...`, routers/comments.py:401), so
those prefixes are derived from the comments being deleted.

The stored key columns are *also* deleted individually afterwards, as a
belt-and-braces pass for anything written outside those prefixes by an
older code path.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..config import settings
from ..models.activity import ActivityLog, Mention, Notification
from ..models.approval import Approval
from ..models.asset import Asset, AssetVersion, CarouselItem, MediaFile
from ..models.comment import Annotation, Comment, CommentAttachment, CommentReaction
from ..models.folder import Folder
from ..models.project import Project
from ..models.metadata import AssetMetadata
from ..models.share import AssetShare, ShareLink, ShareLinkActivity, ShareLinkItem
from ..models.sidecar import SidecarFile
from ..models.vote import Vote
from ..services import s3_service
from ..services.storage_prefix import candidate_project_prefixes

logger = logging.getLogger(__name__)

# How long a soft-deleted item stays restorable. Also the number the
# frontend counts down to, via deleted_at + this.
RETENTION_DAYS = 30


def retention_cutoff(now: datetime | None = None) -> datetime:
    """Anything soft-deleted before this instant is due for purging."""
    return (now or datetime.now(timezone.utc)) - timedelta(days=RETENTION_DAYS)


# ── S3 ───────────────────────────────────────────────────────────────────

def _delete_prefix(prefix: str) -> int:
    """Delete every object under `prefix`. Returns how many were removed.

    Never raises: losing a storage object is bad, but aborting the sweep
    and leaving the DB rows behind is worse — the item would then reappear
    on the next run and fail identically forever.
    """
    if not prefix:
        return 0
    if not prefix.endswith("/"):
        prefix += "/"

    removed = 0
    try:
        s3 = s3_service.get_s3_client()
        paginator = s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=settings.s3_bucket, Prefix=prefix):
            keys = [{"Key": o["Key"]} for o in page.get("Contents", []) or []]
            if not keys:
                continue
            # delete_objects takes 1000 per call; a page is already capped
            # at 1000, so one call per page is within the limit.
            s3.delete_objects(Bucket=settings.s3_bucket, Delete={"Objects": keys})
            removed += len(keys)
    except Exception:
        logger.warning("Purge could not clear S3 prefix %s", prefix, exc_info=True)
    return removed


def _delete_keys(keys) -> int:
    """Delete individual keys, ignoring blanks. Same never-raise policy."""
    removed = 0
    for key in keys:
        if not key:
            continue
        try:
            s3_service.delete_object(key)
            removed += 1
        except Exception:
            logger.warning("Purge could not delete S3 object %s", key, exc_info=True)
    return removed


# ── Asset ────────────────────────────────────────────────────────────────

def purge_asset(db: Session, asset: Asset) -> dict:
    """Permanently delete one asset: its storage, then its rows.

    Storage first, deliberately. If this process dies midway, an orphaned
    S3 object with no DB row is recoverable garbage; a DB row whose bytes
    are already gone is a broken asset the UI still offers to play.

    Does NOT commit — the caller decides the transaction boundary, so the
    sweep can commit per item while the endpoint commits once.
    """
    asset_id = asset.id
    project_id = asset.project_id

    version_ids = [v.id for v in db.query(AssetVersion.id).filter(AssetVersion.asset_id == asset_id).all()]
    media_ids = []
    stored_keys = []
    if version_ids:
        for mf in db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).all():
            media_ids.append(mf.id)
            stored_keys += [
                mf.s3_key_raw, mf.s3_key_processed, mf.s3_key_thumbnail,
                mf.s3_key_transcript, mf.s3_key_captions,
            ]

    comment_ids = [c.id for c in db.query(Comment.id).filter(Comment.asset_id == asset_id).all()]

    # Sidecar keys carry their own project prefix, chosen when the sidecar
    # was uploaded — which may differ from the media files' if this asset
    # straddles the §14 change.
    sidecar_keys = [
        row.s3_key for row in
        db.query(SidecarFile.s3_key).filter(SidecarFile.asset_id == asset_id).all()
    ]

    # ── Storage ──
    #
    # The project-level segment is NOT recomputed from project_id. Since
    # §14 it can be either `{project_id}` or
    # `{YYMMDD}_{slug}_{project_id}`, both formats coexist permanently
    # (nothing was migrated), and they coexist *within one asset* — an
    # asset uploaded before the change has an old-format v1 and gets a
    # new-format v2 the next time someone uploads to it.
    #
    # So the prefixes come from the keys actually stored on this asset's
    # rows, plus both computed candidates as a backstop for an asset whose
    # media rows are missing. Listing a prefix that holds nothing is a
    # cheap no-op; missing one leaks storage silently, and that asymmetry
    # is the whole lesson of this module's history.
    project = db.query(Project).filter(Project.id == project_id).first()
    project_prefixes = candidate_project_prefixes(project, stored_keys + sidecar_keys)

    objects = 0
    for project_prefix in project_prefixes:
        for area in ("raw", "processed", "sidecars"):
            objects += _delete_prefix(f"{area}/{project_prefix}/{asset_id}")
    for cid in comment_ids:
        objects += _delete_prefix(f"comment-attachments/{cid}")
    # Anything an older code path put outside those prefixes.
    objects += _delete_keys(stored_keys)

    # ── Rows, children first ──
    if comment_ids:
        # Before comments: notifications and mentions both point at them.
        db.query(Annotation).filter(Annotation.comment_id.in_(comment_ids)).delete(synchronize_session=False)
        db.query(CommentAttachment).filter(CommentAttachment.comment_id.in_(comment_ids)).delete(synchronize_session=False)
        db.query(CommentReaction).filter(CommentReaction.comment_id.in_(comment_ids)).delete(synchronize_session=False)
        db.query(Mention).filter(Mention.comment_id.in_(comment_ids)).delete(synchronize_session=False)

    # Matched on either column: a notification can reference a comment on
    # this asset while carrying a different asset_id, and either way it
    # would block the delete.
    notif_filter = Notification.asset_id == asset_id
    if comment_ids:
        notif_filter = notif_filter | Notification.comment_id.in_(comment_ids)
    db.query(Notification).filter(notif_filter).delete(synchronize_session=False)

    if comment_ids:
        db.query(Comment).filter(Comment.id.in_(comment_ids)).delete(synchronize_session=False)

    db.query(Approval).filter(Approval.asset_id == asset_id).delete(synchronize_session=False)
    db.query(Vote).filter(Vote.asset_id == asset_id).delete(synchronize_session=False)
    db.query(AssetMetadata).filter(AssetMetadata.asset_id == asset_id).delete(synchronize_session=False)
    db.query(SidecarFile).filter(SidecarFile.asset_id == asset_id).delete(synchronize_session=False)
    db.query(ActivityLog).filter(ActivityLog.asset_id == asset_id).delete(synchronize_session=False)
    db.query(AssetShare).filter(AssetShare.asset_id == asset_id).delete(synchronize_session=False)

    # A multi-item share link loses just this asset's entry — the link
    # itself may still carry other assets, and dropping it would revoke
    # access to those too. A link that targets this asset *directly* has
    # nothing left to point at, so it goes entirely.
    db.query(ShareLinkItem).filter(ShareLinkItem.asset_id == asset_id).delete(synchronize_session=False)
    _delete_share_links(db, ShareLink.asset_id == asset_id)

    if media_ids:
        db.query(CarouselItem).filter(CarouselItem.media_file_id.in_(media_ids)).delete(synchronize_session=False)
    if version_ids:
        db.query(CarouselItem).filter(CarouselItem.version_id.in_(version_ids)).delete(synchronize_session=False)
        db.query(MediaFile).filter(MediaFile.version_id.in_(version_ids)).delete(synchronize_session=False)
        db.query(AssetVersion).filter(AssetVersion.id.in_(version_ids)).delete(synchronize_session=False)

    db.query(ShareLinkActivity).filter(ShareLinkActivity.asset_id == asset_id).delete(synchronize_session=False)
    db.delete(asset)

    return {"asset_id": str(asset_id), "objects": objects, "versions": len(version_ids)}


def _delete_share_links(db: Session, where) -> None:
    """Delete share links matching `where`, plus their own children."""
    link_ids = [r.id for r in db.query(ShareLink.id).filter(where).all()]
    if not link_ids:
        return
    db.query(ShareLinkActivity).filter(ShareLinkActivity.share_link_id.in_(link_ids)).delete(synchronize_session=False)
    db.query(ShareLinkItem).filter(ShareLinkItem.share_link_id.in_(link_ids)).delete(synchronize_session=False)
    db.query(ShareLink).filter(ShareLink.id.in_(link_ids)).delete(synchronize_session=False)


# ── Folder ───────────────────────────────────────────────────────────────

def purge_folder(db: Session, folder: Folder) -> dict:
    """Permanently delete one folder and everything still inside it.

    `delete_folder` already stamps the same `deleted_at` onto every
    descendant folder and asset in one transaction, so the scheduled sweep
    finds them independently and does not need this to recurse. It recurses
    anyway, because the immediate-purge endpoint targets a single folder
    and its contents must not be left behind as unreachable rows — nothing
    would ever list them again.
    """
    folder_ids = [folder.id] + _descendant_folder_ids(db, folder.id)

    contained = db.query(Asset).filter(Asset.folder_id.in_(folder_ids)).all()

    # Only what is actually in the trash gets destroyed. A *live* asset in
    # a deleted folder shouldn't normally exist — restore_asset detaches to
    # the root when the parent is deleted (folders.py:483-491) — but
    # uploading into an already-deleted folder isn't validated against, and
    # "we permanently deleted a file you never deleted" is not a failure
    # mode worth risking. Those are moved to the project root instead,
    # which is exactly what restore already does.
    assets = [a for a in contained if a.deleted_at is not None]
    rescued = [a for a in contained if a.deleted_at is None]
    for asset in rescued:
        asset.folder_id = None
    if rescued:
        logger.warning(
            "Purge of folder %s moved %d live asset(s) to the project root instead of deleting them",
            folder.id, len(rescued),
        )

    objects = 0
    for asset in assets:
        objects += purge_asset(db, asset)["objects"]
    # Flush so the asset deletes and detaches land before the folders they
    # point at are removed.
    db.flush()

    for fid in folder_ids:
        db.query(ShareLinkItem).filter(ShareLinkItem.folder_id == fid).delete(synchronize_session=False)
        db.query(AssetShare).filter(AssetShare.folder_id == fid).delete(synchronize_session=False)
        _delete_share_links(db, ShareLink.folder_id == fid)

    # Deepest first: folders.parent_id is a plain FK with no ondelete, so a
    # parent cannot go before its children.
    for fid in reversed(folder_ids):
        db.query(Folder).filter(Folder.id == fid).delete(synchronize_session=False)

    return {"folder_id": str(folder.id), "folders": len(folder_ids), "assets": len(assets), "objects": objects}


def _descendant_folder_ids(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    """Descendants breadth-first, so the caller can delete in reverse and
    always remove children before parents. Ignores deleted_at: a purge has
    to reach every row, including any that were never soft-deleted."""
    out: list[uuid.UUID] = []
    frontier = [folder_id]
    seen = {folder_id}
    while frontier:
        rows = db.query(Folder.id).filter(Folder.parent_id.in_(frontier)).all()
        nxt = [r.id for r in rows if r.id not in seen]
        for fid in nxt:
            seen.add(fid)
        out += nxt
        frontier = nxt
    return out


# ── Sweep ────────────────────────────────────────────────────────────────

def purge_expired(db: Session, now: datetime | None = None) -> dict:
    """Purge everything past the retention window.

    Assets and folders are queried independently by their own `deleted_at`,
    which is correct because folder deletion cascade-stamps the same
    timestamp onto every descendant — there is no tree to walk.

    Each item commits on its own. One asset that fails (a FK from a table
    added since this audit, say) then costs only itself, instead of rolling
    back every successful purge in the batch.
    """
    cutoff = retention_cutoff(now)
    result = {"assets": 0, "folders": 0, "objects": 0, "failed": 0, "cutoff": cutoff.isoformat()}

    # Assets first: purge_folder would otherwise re-delete them, and an
    # asset inside an expired folder carries the same timestamp anyway.
    # Same id-then-refetch shape as the folder loop below, for the same
    # reason: instances must not be held across a commit that may have
    # deleted them.
    asset_ids = [
        row.id for row in
        db.query(Asset.id).filter(Asset.deleted_at.isnot(None), Asset.deleted_at < cutoff).all()
    ]
    for asset_id in asset_ids:
        asset = db.query(Asset).filter(Asset.id == asset_id).first()
        if asset is None:
            continue
        try:
            stats = purge_asset(db, asset)
            db.commit()
            result["assets"] += 1
            result["objects"] += stats["objects"]
        except Exception:
            db.rollback()
            result["failed"] += 1
            logger.exception("Failed to purge asset %s", asset_id)

    # Ids first, then re-fetch one at a time. A nested tree puts both the
    # parent and its children in this result set, and purging the parent
    # already removed the children — holding ORM instances across that
    # commit and then touching one raises ObjectDeletedError, which would
    # abort the rest of the sweep. Re-fetching turns "already gone" into a
    # skip, which is what it means.
    folder_ids = [
        row.id for row in
        db.query(Folder.id).filter(Folder.deleted_at.isnot(None), Folder.deleted_at < cutoff).all()
    ]
    for folder_id in folder_ids:
        folder = db.query(Folder).filter(Folder.id == folder_id).first()
        if folder is None:
            continue  # removed as a descendant of a folder purged earlier
        try:
            stats = purge_folder(db, folder)
            db.commit()
            result["folders"] += stats["folders"]
            result["objects"] += stats["objects"]
        except Exception:
            db.rollback()
            result["failed"] += 1
            logger.exception("Failed to purge folder %s", folder_id)

    return result
