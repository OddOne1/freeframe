"""One definition of "which stored bytes count" (§239).

Every storage figure in this app is the same aggregate:

    SUM(media_files.file_size_bytes)
      FROM media_files JOIN asset_versions JOIN assets

and before §239 every one of the eight sites that computes it filtered
`assets.deleted_at IS NULL` and nothing else. That was *complete* only
because a single version could not be deleted on its own: the API had no
route for it, the web had no button, and nothing anywhere ever assigned
`asset_versions.deleted_at` (verified by grep across the whole repo — it
existed purely as a read filter).

§239 added that route, which turned one missing predicate into eight wrong
numbers at once: a version the user had deleted would keep counting
against the per-project limit, the platform limit, the project's own
storage figure, the folder tree's sizes and the admin list — so an owner
could delete a version to make room and find that it had freed nothing.

So the join and the predicate live here, once, and the sites call this.
A shared *query builder* rather than a shared *predicate*, deliberately:
the predicate alone still leaves each site to spell out two joins, and a
site that forgets to join `asset_versions` cannot apply a condition on it
at all. There is nothing left at the call sites for the next one to
forget. (Same reasoning, and the same shape, as
`services/asset_visibility.py`'s `usable_asset_filter`, which is why this
is a sibling module rather than a function bolted onto that one — that
one answers "is this asset showable", this one answers "do these bytes
count".)

`select_from(MediaFile)` is load-bearing. Four of the callers select
`Asset.project_id` or `Asset.folder_id` alongside the sum and SQLAlchemy
would otherwise take the leftmost entity as the FROM, leaving the first
`join()` with an ON clause naming a table that is not in the query yet.
Pinning the FROM to `media_files` makes one join order correct for every
caller regardless of what it groups by.

NOT used by `scripts/report_trash_backlog.py`, which asks the opposite
question — see the comment at its own aggregate.
"""

from __future__ import annotations

from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from ..models.asset import Asset, AssetVersion, MediaFile


def live_media_filter():
    """The condition that makes stored bytes count toward a figure.

    Both halves: the asset must not be in the trash, and the version must
    not have been deleted on its own (§239). Exposed separately for a
    caller that has already built the join itself.
    """
    return and_(Asset.deleted_at.is_(None), AssetVersion.deleted_at.is_(None))


def storage_bytes_query(db: Session, *columns):
    """`SUM(file_size_bytes)` over live versions of live assets.

    The sum is the LAST selected column, after any `columns` given — so a
    grouped caller passes its grouping column and reads `(key, size)`
    pairs, exactly as the hand-written queries did:

        storage_bytes_query(db, Asset.project_id)
            .filter(Asset.project_id.in_(ids))
            .group_by(Asset.project_id).all()

    and an ungrouped one passes nothing and calls `.scalar()`:

        storage_bytes_query(db).filter(Asset.project_id == pid).scalar()

    Returns a query, not a number: every caller narrows it differently
    (one project, a folder subtree, platform-wide, plus
    `usable_asset_filter()` in the folder sites) and that narrowing is
    theirs. What is NOT theirs any more is the join and the two
    `deleted_at` predicates.
    """
    return (
        db.query(*columns, func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
        .select_from(MediaFile)
        .join(AssetVersion, MediaFile.version_id == AssetVersion.id)
        .join(Asset, AssetVersion.asset_id == Asset.id)
        .filter(live_media_filter())
    )
