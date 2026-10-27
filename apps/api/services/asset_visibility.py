"""One definition of "which assets does a viewer actually get to see".

An `Asset` row exists from the moment `POST /upload/initiate` runs, well
before any bytes arrive — the real status lives on `AssetVersion.processing_status`
(`uploading` -> `processing` -> `ready`, or `failed`). So a listing that
filters on `deleted_at IS NULL` alone counts and shows uploads that were
abandoned, are still in flight, or blew up in the transcoder.

`routers/assets.py`'s `list_assets` got this right and every other caller
got it wrong, each in its own way. This module is the single source of
truth so those cannot drift apart again — the same failure shape CLAUDE.md
records for §30's variant gate and §32's URL resolution.

Deliberately kept as a SQL expression rather than a post-query Python
filter: the share endpoint paginates and aggregates (COUNT, SUM), and those
cannot be corrected after the rows have already been sliced by LIMIT.
"""
from sqlalchemy import and_, literal_column, not_, or_, select

from ..models.asset import Asset, AssetVersion, ProcessingStatus

#: Statuses that mean "there is no usable file behind this row (yet)".
HIDDEN_PROCESSING_STATUSES = (ProcessingStatus.failed, ProcessingStatus.uploading)


def usable_asset_filter():
    """A SQL condition selecting only assets a viewer should be shown.

    An asset qualifies when it has at least one live version that is not
    `failed` and not `uploading`.

    The second clause is not defensive padding: an asset with NO live
    versions at all is also kept, matching `list_assets`'s own
    "Also include assets with no versions yet (just created)" branch. Drop
    it and a brand-new asset vanishes from its own project between the
    `Asset` insert and the `AssetVersion` insert — and, more damagingly,
    every asset whose versions were soft-deleted individually rather than
    through the asset would disappear from counts that still list it.
    """
    def _versions_where(*conditions):
        # select_from + correlate(Asset) is load-bearing, not ceremony. Some
        # callers (folders.py's size rollup) already JOIN AssetVersion in the
        # outer query; with a bare exists() SQLAlchemy auto-correlates that
        # join away too, and the subquery is left with no FROM clause at all
        # ("returned no FROM clauses due to auto-correlation"). Pinning the
        # correlation to Asset alone keeps AssetVersion inside the subquery
        # regardless of what the outer query happens to select from.
        return (
            select(literal_column("1"))
            .select_from(AssetVersion)
            .where(AssetVersion.asset_id == Asset.id, *conditions)
            .correlate(Asset)
            .exists()
        )

    has_usable_version = _versions_where(
        AssetVersion.deleted_at.is_(None),
        AssetVersion.processing_status.notin_(HIDDEN_PROCESSING_STATUSES),
    )
    has_any_version = _versions_where(AssetVersion.deleted_at.is_(None))
    return or_(has_usable_version, not_(has_any_version))


def version_is_live(version_id_column):
    """SQL condition: the version THIS row hangs off has not been deleted.

    §239 — a version can now be deleted on its own, and decision 4 is that
    its comments, approvals and annotations are left in the database
    untouched and go unreachable WITH it. "Unreachable" is not automatic:
    the listings that return them are scoped to the ASSET, not to a
    version, so without this they would keep answering with the deleted
    version's rows.

    Applied to the child's own `version_id` column rather than joined, so
    a caller does not have to restructure its query (and so the condition
    reads the same at every call site):

        query.filter(version_is_live(Comment.version_id))

    `correlate_except` pins `asset_versions` inside the subquery for the
    same reason `usable_asset_filter` does it: a caller that happens to
    have `AssetVersion` in its own FROM would otherwise have it correlated
    away, leaving a subquery with no FROM clause at all.
    """
    return (
        select(literal_column("1"))
        .select_from(AssetVersion)
        .where(AssetVersion.id == version_id_column, AssetVersion.deleted_at.is_(None))
        .correlate_except(AssetVersion)
        .exists()
    )


def visible_assets(query, include_failed: bool = False):
    """Apply :func:`usable_asset_filter` to an existing ``Asset`` query.

    ``include_failed=True`` is a pass-through, so callers that expose an
    opt-in flag (``list_assets``) can route through the same helper rather
    than branching around it.
    """
    if include_failed:
        return query
    return query.filter(usable_asset_filter())
