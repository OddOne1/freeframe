"""Recently Deleted as ONE list: the query behind `GET /projects/{id}/trash` (§240).

Before §240 that route ran two independent queries, applied `skip`/`limit`
to each of them separately (so "page 2" meant "the second page of folders
AND the second page of assets", and no page ever contained every row
exactly once), returned no size, no deleter, no expiry and no total, and
listed every deleted row — including the hundreds of assets that were
deleted only because somebody deleted the folder they were in.

What the owner asked for instead is a list a person can read: searchable,
filterable by kind and by who deleted, sortable four ways, and showing
only the ROOTS of each deletion with a count of what is inside. That is
one merged, sorted, paginated result over three different tables, which is
why this is a module and not a route body.

── Everything happens in SQL, in one statement ───────────────────────────
Three branches (folders, assets, versions) are `UNION ALL`'d into one
derived table, and the sort, the `LIMIT/OFFSET` and the `COUNT(*)` all run
over that. Nothing is loaded into Python and sorted there: the trash of a
busy project is the one listing whose row count grows without bound (it is
only emptied by the 30-day purge), and the page the user asked for has to
cost the same whether the trash holds ten rows or a hundred thousand.

Sizes and child counts come from three CTEs computed once per request
rather than per row:

  * `fsub`  — one recursive CTE mapping every deleted folder in the
              project to its whole subtree. Both the folder size and the
              folder child count read it, so the tree is walked once.
  * `asize` — bytes per asset: its LIVE versions only (a version the user
              deleted separately is its own trash row and must not be
              counted twice).
  * `vsize` — bytes per version.

A deleted folder's size counts every asset in its subtree regardless of
each asset's own `deleted_at` — they are deleted *because* the folder is,
so filtering them out would report every trashed folder as 0 bytes — but
still only versions that are not individually deleted, for the same
"never count the same bytes in two rows" reason.

── Visibility (owner decision, §240 B) ───────────────────────────────────
An editor sees ONLY what they deleted themselves, because `can_restore`
is the only thing they can do here and that is all they can restore. The
project owner and a superadmin see the whole project's trash, including
rows whose deleter is unknown (NULL — deleted before §240, see the
migration). This is applied inside the SQL, not to the page afterwards,
so `total`, the paging and the `deleters` list are all correct for the
caller asking.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta
from typing import Optional

from sqlalchemy import (
    Integer,
    String,
    and_,
    case,
    cast,
    distinct,
    exists,
    func,
    literal,
    literal_column,
    null,
    or_,
    select,
    union_all,
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Session, aliased

from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.folder import Folder
from .purge_service import RETENTION_DAYS
from .search import LIKE_ESCAPE, like_contains

#: The filter value that means "rows with no recorded deleter". A uuid
#: cannot collide with it, and it is the only way to reach pre-§240 rows
#: from the deleter dropdown.
UNKNOWN_DELETER = "unknown"

#: Which direction each sort means when the caller does not say. Newest
#: first and biggest first; alphabetical and soonest-to-expire ascending,
#: because "what am I about to lose" is the top of that list.
DEFAULT_ORDER: dict[str, str] = {
    "deleted_at": "desc",
    "size": "desc",
    "name": "asc",
    "expires_at": "asc",
}


def expires_at(deleted_at):
    """When this row stops being restorable: `deleted_at` + the retention
    window, read from `purge_service.RETENTION_DAYS` rather than restated
    (§240 requirement 4 — the API exposes that number, it does not own a
    second copy of it)."""
    if deleted_at is None:
        return None
    return deleted_at + timedelta(days=RETENTION_DAYS)


@dataclass
class TrashFilters:
    """Everything the request can vary, already validated by the route."""

    project_id: uuid.UUID
    user_id: uuid.UUID
    #: False for an editor: only their own deletions are visible to them.
    sees_whole_project: bool
    q: Optional[str] = None
    kind: str = "all"
    deleted_by: Optional[str] = None
    include_nested: bool = False
    sort: str = "deleted_at"
    order: Optional[str] = None
    limit: int = 50
    offset: int = 0

    @property
    def effective_order(self) -> str:
        return self.order or DEFAULT_ORDER[self.sort]


def _subtree_cte(project_id: uuid.UUID):
    """Every deleted folder in the project → every folder in its subtree.

    The root row maps a folder to itself, which is what makes the two
    aggregates below able to include the folder's own direct contents.
    Descendants are collected regardless of their own `deleted_at`: a
    folder deleted earlier, inside a folder deleted later, is still
    *inside* it, and its bytes are still what the user would get back.
    """
    roots = (
        select(Folder.id.label("root_id"), Folder.id.label("fid"))
        .where(Folder.project_id == project_id, Folder.deleted_at.isnot(None))
        .cte("fsub", recursive=True)
    )
    child = aliased(Folder)
    return roots.union_all(
        select(roots.c.root_id, child.id).where(child.parent_id == roots.c.fid)
    )


def _folder_size_cte(fsub):
    """Bytes inside each deleted folder, whole subtree, live versions only."""
    return (
        select(
            fsub.c.root_id.label("root_id"),
            func.coalesce(func.sum(MediaFile.file_size_bytes), 0).label("bytes"),
        )
        .select_from(
            fsub.join(Asset, Asset.folder_id == fsub.c.fid)
            .join(
                AssetVersion,
                and_(
                    AssetVersion.asset_id == Asset.id,
                    AssetVersion.deleted_at.is_(None),
                ),
            )
            .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        )
        .group_by(fsub.c.root_id)
        .cte("fsize")
    )


def _folder_count_cte(fsub):
    """How many items are inside each deleted folder — descendant folders
    plus every asset anywhere in the subtree.

    Recursive, not just the immediate children: this number exists to tell
    the user what the default (roots-only) view is hiding from them, and
    what it hides is the whole subtree.

    `COUNT(DISTINCT CASE …)` excludes the root's own self-row from the
    folder count, and the two `DISTINCT`s are what make the counts safe
    across the join fan-out.
    """
    return (
        select(
            fsub.c.root_id.label("root_id"),
            (
                func.count(distinct(case((fsub.c.fid != fsub.c.root_id, fsub.c.fid))))
                + func.count(distinct(Asset.id))
            ).label("n"),
        )
        .select_from(fsub.outerjoin(Asset, Asset.folder_id == fsub.c.fid))
        .group_by(fsub.c.root_id)
        .cte("fcount")
    )


def _asset_size_cte(project_id: uuid.UUID):
    """Bytes per asset in this project, counting only live versions."""
    return (
        select(
            Asset.id.label("aid"),
            func.coalesce(func.sum(MediaFile.file_size_bytes), 0).label("bytes"),
        )
        .select_from(
            Asset.__table__.join(
                AssetVersion.__table__,
                and_(
                    AssetVersion.asset_id == Asset.id,
                    AssetVersion.deleted_at.is_(None),
                ),
            ).join(MediaFile.__table__, MediaFile.version_id == AssetVersion.id)
        )
        .where(Asset.project_id == project_id)
        .group_by(Asset.id)
        .cte("asize")
    )


def _version_size_cte():
    return (
        select(
            MediaFile.version_id.label("vid"),
            func.coalesce(func.sum(MediaFile.file_size_bytes), 0).label("bytes"),
        )
        .group_by(MediaFile.version_id)
        .cte("vsize")
    )


def _deleter_clause(column, f: TrashFilters):
    """The visibility rule and the deleter filter, which are the same column.

    Both are returned together because getting one of them onto the page
    instead of into the query is exactly the bug §240 is fixing: a filter
    applied after `LIMIT` gives a short page, and a visibility rule applied
    after `COUNT(*)` gives a total for somebody else's trash.
    """
    clauses = []
    if not f.sees_whole_project:
        # An editor: their own deletions and nothing else. NULL never
        # equals an id, so unknown-deleter rows are invisible here, which
        # is correct — they cannot restore them either.
        clauses.append(column == f.user_id)
    if f.deleted_by == UNKNOWN_DELETER:
        clauses.append(column.is_(None))
    elif f.deleted_by:
        clauses.append(column == uuid.UUID(str(f.deleted_by)))
    return clauses


def _name_clause(column, f: TrashFilters, extra=None):
    """Case-insensitive substring search, with `%` and `_` taken literally.

    §233's `like_contains` + `escape=LIKE_ESCAPE`, not an f-string: a user
    searching for `_` must not match every single-character name, and a
    user searching for `%` must not be handed the whole trash.
    """
    if not f.q or not f.q.strip():
        return []
    pattern = like_contains(f.q.strip())
    clause = column.ilike(pattern, escape=LIKE_ESCAPE)
    if extra is not None:
        clause = or_(clause, extra.ilike(pattern, escape=LIKE_ESCAPE))
    return [clause]


def _folder_branch(db: Session, f: TrashFilters, fsize, fcount):
    parent = aliased(Folder)
    nested = exists(
        select(literal_column("1")).where(
            parent.id == Folder.parent_id, parent.deleted_at.isnot(None)
        )
    )
    where = [
        Folder.project_id == f.project_id,
        Folder.deleted_at.isnot(None),
        *_deleter_clause(Folder.deleted_by, f),
        *_name_clause(Folder.name, f),
    ]
    if not f.include_nested:
        where.append(~nested)
    return (
        select(
            literal("folder").label("kind"),
            Folder.id.label("id"),
            Folder.name.label("name"),
            Folder.deleted_at.label("deleted_at"),
            Folder.deleted_by.label("deleted_by"),
            Folder.deleted_by_name.label("deleted_by_name"),
            Folder.parent_id.label("original_folder_id"),
            func.coalesce(fsize.c.bytes, 0).label("size_bytes"),
            func.coalesce(fcount.c.n, 0).label("child_count"),
            cast(null(), String).label("asset_type"),
            cast(null(), PGUUID(as_uuid=True)).label("asset_id"),
            cast(null(), Integer).label("version_number"),
        )
        .select_from(
            Folder.__table__.outerjoin(fsize, fsize.c.root_id == Folder.id).outerjoin(
                fcount, fcount.c.root_id == Folder.id
            )
        )
        .where(*where)
    )


def _asset_branch(db: Session, f: TrashFilters, asize):
    holder = aliased(Folder)
    nested = exists(
        select(literal_column("1")).where(
            holder.id == Asset.folder_id, holder.deleted_at.isnot(None)
        )
    )
    where = [
        Asset.project_id == f.project_id,
        Asset.deleted_at.isnot(None),
        *_deleter_clause(Asset.deleted_by, f),
        *_name_clause(Asset.name, f),
    ]
    if not f.include_nested:
        where.append(~nested)
    return (
        select(
            literal("asset").label("kind"),
            Asset.id.label("id"),
            Asset.name.label("name"),
            Asset.deleted_at.label("deleted_at"),
            Asset.deleted_by.label("deleted_by"),
            Asset.deleted_by_name.label("deleted_by_name"),
            Asset.folder_id.label("original_folder_id"),
            func.coalesce(asize.c.bytes, 0).label("size_bytes"),
            literal(0).label("child_count"),
            cast(Asset.asset_type, String).label("asset_type"),
            cast(null(), PGUUID(as_uuid=True)).label("asset_id"),
            cast(null(), Integer).label("version_number"),
        )
        .select_from(Asset.__table__.outerjoin(asize, asize.c.aid == Asset.id))
        .where(*where)
    )


def _version_branch(db: Session, f: TrashFilters, vsize):
    """Deleted versions whose asset is still LIVE.

    A deleted version of a deleted asset is not its own trash row: the
    asset is the row, and restoring the asset brings its versions back
    with it. Listing both would offer the user two restores for one thing
    and count its bytes twice.
    """
    label = func.concat(literal("v"), cast(AssetVersion.version_number, String))
    where = [
        Asset.project_id == f.project_id,
        Asset.deleted_at.is_(None),
        AssetVersion.deleted_at.isnot(None),
        *_deleter_clause(AssetVersion.deleted_by, f),
        *_name_clause(Asset.name, f, extra=label),
    ]
    return (
        select(
            literal("version").label("kind"),
            AssetVersion.id.label("id"),
            Asset.name.label("name"),
            AssetVersion.deleted_at.label("deleted_at"),
            AssetVersion.deleted_by.label("deleted_by"),
            AssetVersion.deleted_by_name.label("deleted_by_name"),
            Asset.folder_id.label("original_folder_id"),
            func.coalesce(vsize.c.bytes, 0).label("size_bytes"),
            literal(0).label("child_count"),
            cast(Asset.asset_type, String).label("asset_type"),
            Asset.id.label("asset_id"),
            AssetVersion.version_number.label("version_number"),
        )
        .select_from(
            AssetVersion.__table__.join(
                Asset.__table__, Asset.id == AssetVersion.asset_id
            ).outerjoin(vsize, vsize.c.vid == AssetVersion.id)
        )
        .where(*where)
    )


def _merged(db: Session, f: TrashFilters):
    """The `UNION ALL` of whichever branches this `kind` asks for."""
    fsub = _subtree_cte(f.project_id)
    branches = []
    if f.kind in ("all", "folder"):
        branches.append(_folder_branch(db, f, _folder_size_cte(fsub), _folder_count_cte(fsub)))
    if f.kind in ("all", "asset"):
        branches.append(_asset_branch(db, f, _asset_size_cte(f.project_id)))
    if f.kind in ("all", "version"):
        branches.append(_version_branch(db, f, _version_size_cte()))
    if len(branches) == 1:
        return branches[0].subquery("trash")
    return union_all(*branches).subquery("trash")


def _order_by(merged, f: TrashFilters):
    """The sort, plus a total tie-break so paging cannot repeat or skip a row.

    `(deleted_at, id)` is unique in practice and `id` alone is unique
    absolutely, so appending it makes the order TOTAL — without that, two
    rows deleted in the same cascade (identical `deleted_at` by design)
    could swap places between page 1 and page 2 and a two-page walk would
    show one twice and the other never.
    """
    descending = f.effective_order == "desc"

    def direction(col):
        return col.desc() if descending else col.asc()

    if f.sort == "name":
        primary = direction(func.lower(merged.c.name))
    elif f.sort == "size":
        primary = direction(merged.c.size_bytes)
    else:
        # `expires_at` is `deleted_at` plus a constant, so it sorts
        # identically — only its default direction differs (see
        # DEFAULT_ORDER). No need to compute the sum to order by it.
        primary = direction(merged.c.deleted_at)
    return [primary, merged.c.id.desc() if descending else merged.c.id.asc()]


def list_trash(db: Session, f: TrashFilters) -> tuple[list[dict], int]:
    """One page of the merged trash, and the total number of matching rows.

    `total` counts every row the filters match for this caller, not the
    page — it is what the web shows as "47 items" and what tells it
    whether there is another page.
    """
    merged = _merged(db, f)
    total = db.execute(select(func.count()).select_from(merged)).scalar() or 0
    rows = db.execute(
        select(merged).order_by(*_order_by(merged, f)).limit(f.limit).offset(f.offset)
    ).mappings().all()
    return [dict(r) for r in rows], int(total)


def list_deleters(db: Session, f: TrashFilters) -> tuple[list[dict], bool]:
    """Distinct deleters in this caller's view of the project's trash, and
    whether that view also contains rows with no recorded deleter.

    Deliberately NOT narrowed by `q`, `kind`, `deleted_by` or
    `include_nested`: it populates a filter dropdown, so narrowing it by
    the filter it feeds would make options disappear as soon as they were
    used. It IS narrowed by the visibility rule — an editor's dropdown
    contains at most themselves.

    The unknown flag is returned separately rather than faked as a user,
    so the caller can offer `deleted_by=unknown` only when it would match
    something.
    """
    plain = TrashFilters(
        project_id=f.project_id,
        user_id=f.user_id,
        sees_whole_project=f.sees_whole_project,
        include_nested=True,
    )
    merged = _merged(db, plain)
    rows = db.execute(
        select(merged.c.deleted_by, merged.c.deleted_by_name).distinct()
    ).all()
    deleters: dict[uuid.UUID, str] = {}
    has_unknown = False
    for deleted_by, name in rows:
        if deleted_by is None:
            has_unknown = True
            continue
        # First non-null name wins; a user who was renamed between two
        # deletions appears once, under the name recorded at the time.
        deleters.setdefault(deleted_by, name or "")
    return (
        sorted(
            ({"id": str(k), "name": v} for k, v in deleters.items()),
            key=lambda d: (d["name"].lower(), d["id"]),
        ),
        has_unknown,
    )
