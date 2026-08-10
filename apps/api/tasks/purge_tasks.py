"""Scheduled permanent deletion of expired Recently Deleted items.

Recently Deleted was soft-delete-only with no expiry at all: an item sat
in the trash forever, and its footage sat in S3 forever with it. This is
the job that gives that trash a floor.

The actual work lives in services/purge_service.py, shared with the
owner/admin immediate-purge endpoints — see the FK and S3 audit in that
module's docstring, which is the part of this feature that can silently go
wrong.
"""

import logging

from ..database import SessionLocal
from ..services.purge_service import RETENTION_DAYS, purge_expired
from .celery_app import celery_app

logger = logging.getLogger(__name__)


@celery_app.task(name="purge_expired_trash")
def purge_expired_trash():
    """Permanently delete everything soft-deleted more than 30 days ago.

    Assets and folders are queried independently by their own `deleted_at`.
    That is sufficient rather than lazy: `delete_folder` cascade-stamps the
    same timestamp onto every descendant folder and asset in one
    transaction (folders.py:319-329), so a folder's contents are already
    due at the same moment the folder is, with no tree to walk.

    Individual failures are contained per item inside purge_expired: one
    asset that can't be deleted must not prevent the other 200 from being.
    """
    db = SessionLocal()
    try:
        result = purge_expired(db)
        if result["assets"] or result["folders"] or result["failed"]:
            logger.info(
                "Trash purge (>%d days): %d asset(s), %d folder(s), %d S3 object(s), %d failure(s)",
                RETENTION_DAYS, result["assets"], result["folders"],
                result["objects"], result["failed"],
            )
        return result
    finally:
        db.close()
