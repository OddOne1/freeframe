import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset, AssetVersion, MediaFile
from ..models.folder import Folder
from ..models.project import ProjectRole
from ..models.user import User
from ..schemas.folder import (
    AssetMoveRequest,
    BulkMoveRequest,
    FolderCreate,
    FolderResponse,
    FolderTreeNode,
    FolderUpdate,
)
from ..services import trash_service
from ..services.asset_visibility import usable_asset_filter
from ..services.permissions import (
    can_delete_folder,
    can_restore_asset,
    can_restore_folder,
    get_project_member,
    is_project_owner_or_superadmin,
    is_public_project,
    require_project_role,
)
from ..services.purge_service import RETENTION_DAYS, purge_asset, purge_folder
from ..services.storage_usage import storage_bytes_query

router = APIRouter(tags=["folders"])

MAX_FOLDER_DEPTH = 10

#: The one answer every refused restore gets (§240 C). Deliberately
#: generic and identical for assets, folders and versions: it names the
#: rule, not who deleted the row, because "Eddie deleted this" is
#: information a caller who may not restore it has not been shown.
RESTORE_DENIED = (
    "Only the person who deleted this, the project owner, or an admin can restore it"
)

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _get_folder(db: Session, folder_id: uuid.UUID) -> Folder:
    folder = (
        db.query(Folder)
        .filter(Folder.id == folder_id, Folder.deleted_at.is_(None))
        .first()
    )
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder

def _get_descendant_ids(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    """Get all descendant folder IDs (BFS)."""
    descendants: list[uuid.UUID] = []
    queue = [folder_id]
    while queue:
        current = queue.pop(0)
        children = (
            db.query(Folder.id)
            .filter(Folder.parent_id == current, Folder.deleted_at.is_(None))
            .all()
        )
        for (child_id,) in children:
            descendants.append(child_id)
            queue.append(child_id)
    return descendants

def _get_depth(db: Session, folder_id: Optional[uuid.UUID]) -> int:
    """Count depth from root to folder_id."""
    depth = 0
    current_id = folder_id
    while current_id:
        depth += 1
        folder = db.query(Folder).filter(Folder.id == current_id).first()
        if not folder:
            break
        current_id = folder.parent_id
    return depth

def _compute_item_count(db: Session, folder_id: uuid.UUID) -> int:
    """Count immediate subfolders + assets in a folder."""
    subfolder_count = (
        db.query(func.count(Folder.id))
        .filter(Folder.parent_id == folder_id, Folder.deleted_at.is_(None))
        .scalar()
        or 0
    )
    asset_count = (
        db.query(func.count(Asset.id))
        .filter(
            Asset.folder_id == folder_id,
            Asset.deleted_at.is_(None),
            usable_asset_filter(),
        )
        .scalar()
        or 0
    )
    return subfolder_count + asset_count

def _compute_folder_total_size(db: Session, folder_id: uuid.UUID) -> int:
    """Recursively sum file sizes of every asset in this folder and all descendant folders."""
    all_folder_ids = [folder_id] + _get_descendant_ids(db, folder_id)
    # §239 — shared builder; `usable_asset_filter` still narrows on top of
    # it. The two answer different questions (see storage_usage.py's
    # docstring) and this site needs both.
    total = storage_bytes_query(db).filter(
        Asset.folder_id.in_(all_folder_ids),
        usable_asset_filter(),
    ).scalar() or 0
    return int(total)

def _folder_to_response(
    db: Session,
    folder: Folder,
    current_user: User | None = None,
    can_delete: bool | None = None,
) -> FolderResponse:
    """One folder, with its counts and §240's `can_delete`.

    `can_delete` is passed in by a caller that computed the whole
    project's map at once (`_can_delete_folder_map`); a single-folder
    caller leaves it out and pays for one recursive query via
    `can_delete_folder`. Default False when there is no caller.
    """
    resp = FolderResponse.model_validate(folder)
    resp.item_count = _compute_item_count(db, folder.id)
    resp.total_size_bytes = _compute_folder_total_size(db, folder.id)
    if can_delete is not None:
        resp.can_delete = can_delete
    elif current_user is not None:
        resp.can_delete = can_delete_folder(db, folder, current_user)
    return resp

def _get_descendant_ids_including_deleted(db: Session, folder_id: uuid.UUID) -> list[uuid.UUID]:
    """Get all descendant folder IDs including soft-deleted ones."""
    descendants: list[uuid.UUID] = []
    queue = [folder_id]
    while queue:
        current = queue.pop(0)
        children = db.query(Folder.id).filter(Folder.parent_id == current).all()
        for (child_id,) in children:
            if child_id not in descendants:
                descendants.append(child_id)
                queue.append(child_id)
    return descendants

def _max_subtree_depth(db: Session, folder_id: uuid.UUID) -> int:
    """Get the max depth of the subtree rooted at folder_id."""
    max_depth = 0
    queue: list[tuple[uuid.UUID, int]] = [(folder_id, 0)]
    while queue:
        current, depth = queue.pop(0)
        children = (
            db.query(Folder.id)
            .filter(Folder.parent_id == current, Folder.deleted_at.is_(None))
            .all()
        )
        for (child_id,) in children:
            child_depth = depth + 1
            if child_depth > max_depth:
                max_depth = child_depth
            queue.append((child_id, child_depth))
    return max_depth

# ─── CRUD ─────────────────────────────────────────────────────────────────────

@router.post(
    "/projects/{project_id}/folders",
    response_model=FolderResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_folder(
    project_id: uuid.UUID,
    body: FolderCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # Validate parent exists and belongs to project
    if body.parent_id:
        parent = _get_folder(db, body.parent_id)
        if parent.project_id != project_id:
            raise HTTPException(status_code=400, detail="Parent folder not in this project")
        # Check depth
        depth = _get_depth(db, body.parent_id)
        if depth >= MAX_FOLDER_DEPTH:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum folder depth of {MAX_FOLDER_DEPTH} exceeded",
            )

    folder = Folder(
        project_id=project_id,
        parent_id=body.parent_id,
        name=body.name,
        created_by=current_user.id,
    )
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return _folder_to_response(db, folder, current_user)

@router.get("/projects/{project_id}/folders", response_model=list[FolderResponse])
def list_folders(
    project_id: uuid.UUID,
    parent_id: Optional[str] = Query(None, description="Filter by parent_id. 'root' for root level."),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    query = db.query(Folder).filter(
        Folder.project_id == project_id,
        Folder.deleted_at.is_(None),
    )

    if parent_id == "root":
        query = query.filter(Folder.parent_id.is_(None))
    elif parent_id is not None:
        query = query.filter(Folder.parent_id == uuid.UUID(parent_id))

    folders = query.order_by(Folder.created_at.desc()).all()
    deletable = _can_delete_folder_map(db, project_id, current_user)
    return [
        _folder_to_response(db, f, can_delete=deletable.get(f.id, False))
        for f in folders
    ]

@router.get("/projects/{project_id}/folder-tree", response_model=list[FolderTreeNode])
def get_folder_tree(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Allow access if user is a project member OR the project is public
    member = get_project_member(db, project_id, current_user.id)
    if not member and not is_public_project(db, project_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")

    all_folders = (
        db.query(Folder)
        .filter(Folder.project_id == project_id, Folder.deleted_at.is_(None))
        .all()
    )

    # Batch-compute item counts (avoid N+1 queries)
    folder_ids = [f.id for f in all_folders]

    subfolder_counts = dict(
        db.query(Folder.parent_id, func.count(Folder.id))
        .filter(Folder.parent_id.in_(folder_ids), Folder.deleted_at.is_(None))
        .group_by(Folder.parent_id)
        .all()
    ) if folder_ids else {}

    asset_counts = dict(
        db.query(Asset.folder_id, func.count(Asset.id))
        .filter(
            Asset.folder_id.in_(folder_ids),
            Asset.deleted_at.is_(None),
            usable_asset_filter(),
        )
        .group_by(Asset.folder_id)
        .all()
    ) if folder_ids else {}

    # Batch-compute direct (non-recursive) file size per folder — recursive
    # rollup happens afterwards via _accumulate() once the tree is built.
    direct_sizes = dict(
        storage_bytes_query(db, Asset.folder_id)  # §239 — shared builder
        .filter(
            Asset.folder_id.in_(folder_ids),
            usable_asset_filter(),
        )
        .group_by(Asset.folder_id)
        .all()
    ) if folder_ids else {}

    # §240 C2 — one map for the whole tree, not one query per node.
    deletable = _can_delete_folder_map(db, project_id, current_user)

    # Build tree in Python
    folder_map: dict[uuid.UUID, FolderTreeNode] = {}
    for f in all_folders:
        folder_map[f.id] = FolderTreeNode(
            id=f.id,
            name=f.name,
            parent_id=f.parent_id,
            item_count=(subfolder_counts.get(f.id, 0) + asset_counts.get(f.id, 0)),
            total_size_bytes=int(direct_sizes.get(f.id, 0)),
            can_delete=deletable.get(f.id, False),
        )

    roots: list[FolderTreeNode] = []
    for node in folder_map.values():
        if node.parent_id and node.parent_id in folder_map:
            folder_map[node.parent_id].children.append(node)
        else:
            roots.append(node)

    # Bottom-up rollup: each node's total_size_bytes should include all descendants
    def _accumulate(node: FolderTreeNode) -> int:
        total = node.total_size_bytes
        for child in node.children:
            total += _accumulate(child)
        node.total_size_bytes = total
        return total

    for root in roots:
        _accumulate(root)

    return roots

@router.patch("/folders/{folder_id}", response_model=FolderResponse)
def update_folder(
    folder_id: uuid.UUID,
    body: FolderUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)

    if body.name is not None:
        folder.name = body.name

    # Handle parent_id move (only if explicitly set)
    if "parent_id" in body.model_fields_set:
        new_parent_id = body.parent_id
        if new_parent_id is not None:
            # Can't move into self or descendant
            descendants = _get_descendant_ids(db, folder_id)
            if new_parent_id == folder_id or new_parent_id in descendants:
                raise HTTPException(status_code=400, detail="Cannot move folder into itself or a subfolder")
            parent = _get_folder(db, new_parent_id)
            if parent.project_id != folder.project_id:
                raise HTTPException(status_code=400, detail="Target folder not in same project")
            # Check depth
            depth = _get_depth(db, new_parent_id)
            max_subtree = _max_subtree_depth(db, folder_id)
            if depth + max_subtree + 1 > MAX_FOLDER_DEPTH:
                raise HTTPException(
                    status_code=400,
                    detail=f"Move would exceed maximum folder depth of {MAX_FOLDER_DEPTH}",
                )
        folder.parent_id = new_parent_id

    db.commit()
    db.refresh(folder)
    return _folder_to_response(db, folder, current_user)

def _can_delete_folder_map(
    db: Session, project_id: uuid.UUID, user: User
) -> dict[uuid.UUID, bool]:
    """`can_delete` for EVERY live folder in the project, in two queries.

    §240 C2's folder rule is recursive ("and everything live inside it, at
    any depth, is theirs"), which is one query per folder if asked folder
    by folder — an N+1 on the folder tree, which the tree endpoint builds
    for the whole project at once. So the subtree test is done here
    instead: load the folders (one query) and the folders that hold
    somebody else's live asset (one grouped query), then settle every
    folder bottom-up in Python. `folder_subtree_is_all_mine` in
    services/permissions.py remains the single-folder answer and the two
    agree by construction — same two conditions, same NULL handling.

    An owner or superadmin short-circuits before either query: they may
    delete anything.
    """
    rows = (
        db.query(Folder.id, Folder.parent_id, Folder.created_by)
        .filter(Folder.project_id == project_id, Folder.deleted_at.is_(None))
        .all()
    )
    if is_project_owner_or_superadmin(db, project_id, user):
        return {r.id: True for r in rows}

    foreign_asset_folders = {
        fid for (fid,) in db.query(Asset.folder_id)
        .filter(
            Asset.project_id == project_id,
            Asset.deleted_at.is_(None),
            Asset.folder_id.isnot(None),
            Asset.created_by.is_distinct_from(user.id),
        )
        .distinct()
        .all()
    }

    children: dict = {}
    for r in rows:
        children.setdefault(r.parent_id, []).append(r)

    result: dict[uuid.UUID, bool] = {}

    def settle(row) -> bool:
        if row.id in result:
            return result[row.id]
        # Claimed before recursing: a corrupt parent cycle then resolves
        # to False instead of recursing forever.
        result[row.id] = False
        mine = (
            row.created_by is not None
            and row.created_by == user.id
            and row.id not in foreign_asset_folders
            and all(settle(child) for child in children.get(row.id, []))
        )
        result[row.id] = mine
        return mine

    # Every row is settled, not only the roots, so a folder whose parent
    # is missing from this project's live set is still answered.
    for row in rows:
        settle(row)
    return result

@router.delete("/folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_folder(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Move a folder and everything inside it to the trash.

    §240 C2 — the permission is no longer "any editor". It is the project
    owner or a superadmin, or the editor who created this folder AND
    uploaded everything live inside it (`can_delete_folder`). Checked
    BEFORE the cascade stamps anything: the check reads `created_by` on
    rows the cascade is about to mark deleted, so running it afterwards
    would be asking about a tree that has already changed.

    §240 A — the cascade stamps `deleted_by`/`deleted_by_name` as well as
    `deleted_at`, with the SAME deleter for every descendant: one click,
    one person.

    §240 — and it no longer touches rows that are ALREADY deleted. That
    was the quiet bug behind the folder-restore regression: re-stamping an
    asset somebody had trashed last week with today's timestamp made its
    own deletion indistinguishable from this one, restarted its 30-day
    clock, and overwrote whoever had deleted it. Leaving those rows alone
    is what lets `restore_folder` below bring back exactly what this call
    took away.
    """
    folder = _get_folder(db, folder_id)
    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)
    if not can_delete_folder(db, folder, current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Only the project owner can delete a folder that contains "
                "other people's files"
            ),
        )

    now = datetime.now(timezone.utc)
    stamp = {
        "deleted_at": now,
        "deleted_by": current_user.id,
        "deleted_by_name": current_user.name,
    }

    # Cascade soft-delete: folder + all descendants + their assets
    all_folder_ids = [folder_id] + _get_descendant_ids(db, folder_id)

    db.query(Folder).filter(
        Folder.id.in_(all_folder_ids), Folder.deleted_at.is_(None)
    ).update(stamp, synchronize_session="fetch")
    db.query(Asset).filter(
        Asset.folder_id.in_(all_folder_ids), Asset.deleted_at.is_(None)
    ).update(stamp, synchronize_session="fetch")

    db.commit()

# ─── Move ─────────────────────────────────────────────────────────────────────

@router.patch("/assets/{asset_id}/move", response_model=dict)
def move_asset(
    asset_id: uuid.UUID,
    body: AssetMoveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.folder_id is not None:
        target = _get_folder(db, body.folder_id)
        if target.project_id != asset.project_id:
            raise HTTPException(status_code=400, detail="Target folder not in same project")

    asset.folder_id = body.folder_id
    db.commit()
    return {"ok": True}

@router.post("/projects/{project_id}/bulk-move", response_model=dict)
def bulk_move(
    project_id: uuid.UUID,
    body: BulkMoveRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    # Validate target folder
    if body.target_folder_id is not None:
        target = _get_folder(db, body.target_folder_id)
        if target.project_id != project_id:
            raise HTTPException(status_code=400, detail="Target folder not in this project")

    # Move assets
    if body.asset_ids:
        assets = (
            db.query(Asset)
            .filter(
                Asset.id.in_(body.asset_ids),
                Asset.project_id == project_id,
                Asset.deleted_at.is_(None),
            )
            .all()
        )
        if len(assets) != len(body.asset_ids):
            raise HTTPException(status_code=400, detail="Some assets not found in this project")
        for a in assets:
            a.folder_id = body.target_folder_id

    # Move folders
    if body.folder_ids:
        descendants = set()
        if body.target_folder_id:
            descendants = set(_get_descendant_ids(db, body.target_folder_id))
            descendants.add(body.target_folder_id)

        folders = (
            db.query(Folder)
            .filter(
                Folder.id.in_(body.folder_ids),
                Folder.project_id == project_id,
                Folder.deleted_at.is_(None),
            )
            .all()
        )
        if len(folders) != len(body.folder_ids):
            raise HTTPException(status_code=400, detail="Some folders not found in this project")

        for f in folders:
            if f.id in descendants or f.id == body.target_folder_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"Cannot move folder '{f.name}' into itself or a subfolder",
                )
            f.parent_id = body.target_folder_id

    db.commit()
    return {"ok": True, "moved_assets": len(body.asset_ids), "moved_folders": len(body.folder_ids)}

# ─── Trash & Restore ─────────────────────────────────────────────────────────

def _trash_path(db: Session, folder_id, cache: dict) -> str:
    """Where a trashed row used to live: "Day 1 / Selects", or "" at the root.

    Walks `parent_id` INCLUDING deleted folders — the whole point is to
    describe a place that may not exist any more, so `_get_folder`'s
    live-only lookup is wrong here. `cache` is per request: a cascade puts
    hundreds of rows in the trash with the same handful of ancestors, and
    this is the only per-row query in the listing. `seen` makes a corrupt
    parent cycle end the walk rather than spin, matching
    `folder_chain_is_live` in services/permissions.py.
    """
    if folder_id is None:
        return ""
    if folder_id in cache:
        return cache[folder_id]
    names: list[str] = []
    current = folder_id
    seen = set()
    while current and current not in seen:
        seen.add(current)
        row = db.query(Folder.name, Folder.parent_id).filter(Folder.id == current).first()
        if row is None:
            break
        names.append(row.name)
        current = row.parent_id
    path = " / ".join(reversed(names))
    cache[folder_id] = path
    return path

@router.get("/projects/{project_id}/trash", response_model=dict)
def list_trash(
    project_id: uuid.UUID,
    q: Optional[str] = Query(None, max_length=255, description="Name search, case-insensitive substring"),
    kind: str = Query("all", pattern="^(all|asset|folder|version)$"),
    deleted_by: Optional[str] = Query(None, description="User uuid, or 'unknown' for rows with no recorded deleter"),
    sort: str = Query("deleted_at", pattern="^(deleted_at|name|size|expires_at)$"),
    order: Optional[str] = Query(None, pattern="^(asc|desc)$"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    include_nested: bool = Query(False, description="Also list rows that were deleted because their folder was"),
    skip: int = Query(0, ge=0, description="Deprecated alias for offset (pre-§240 callers)"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Recently Deleted: ONE merged, sorted, paginated list (§240 B).

    The gate is unchanged — editor or above on the project, which is what
    it was before §240 — but WHAT a caller sees now depends on who they
    are, because `can_restore` is the only action this list offers and
    §240 narrowed who may restore:

      * an editor sees only what THEY deleted, since that is all they can
        restore;
      * the project owner and a superadmin see the whole project's trash,
        including rows whose deleter is unknown (deleted before §240).

    That rule lives in the SQL (services/trash_service.py), not in a
    filter over the page, so `total`, the paging and the `deleters` list
    are all correct for the caller asking.

    `folders` and `assets` are kept, with their old shape, populated from
    the rows of this same page — the pre-§240 web hook and its vitest
    fixtures keep working unchanged. `skip` is kept as an alias for
    `offset` for the same reason; `limit` now applies to the MERGED list
    rather than separately to each kind, which is what made "page 2"
    wrong before.
    """
    require_project_role(db, project_id, current_user, ProjectRole.editor)

    if deleted_by and deleted_by != trash_service.UNKNOWN_DELETER:
        try:
            uuid.UUID(str(deleted_by))
        except ValueError:
            raise HTTPException(status_code=400, detail="deleted_by must be a user id or 'unknown'")

    sees_whole_project = is_project_owner_or_superadmin(db, project_id, current_user)
    filters = trash_service.TrashFilters(
        project_id=project_id,
        user_id=current_user.id,
        sees_whole_project=sees_whole_project,
        q=q,
        kind=kind,
        deleted_by=deleted_by,
        include_nested=include_nested,
        sort=sort,
        order=order,
        limit=limit,
        # `skip` is only honoured when `offset` was left at its default,
        # so a caller passing both does not get them added together.
        offset=offset or skip,
    )
    rows, total = trash_service.list_trash(db, filters)
    deleters, has_unknown = trash_service.list_deleters(db, filters)

    # Both flags are per-caller, not per-row, apart from `can_restore`'s
    # deleter clause and `can_purge`'s kind clause — so the role lookups
    # happen once here rather than once per item.
    #
    # `can_purge` mirrors the purge endpoints below EXACTLY, including
    # what they do not do: they are `require_project_role(admin)`, which
    # has no superadmin bypass and no membership-free path, so a
    # superadmin who is a member as an EDITOR is refused there and must
    # be told so here. Owner and admin ("Manager") rank equally in that
    # helper, which is why both are listed. And there is no purge route
    # for a VERSION at all (§239 frees no bytes; purging is assets and
    # folders only), so a version row never offers it.
    member = get_project_member(db, project_id, current_user.id)
    can_purge_here = member is not None and member.role in (
        ProjectRole.owner,
        ProjectRole.admin,
    )

    path_cache: dict = {}

    def _item(row: dict) -> dict:
        return {
            "id": str(row["id"]),
            "kind": row["kind"],
            "name": row["name"],
            "deleted_at": row["deleted_at"].isoformat() if row["deleted_at"] else None,
            "expires_at": (
                trash_service.expires_at(row["deleted_at"]).isoformat()
                if row["deleted_at"] else None
            ),
            "deleted_by": (
                {"id": str(row["deleted_by"]), "name": row["deleted_by_name"] or ""}
                if row["deleted_by"] else None
            ),
            "original_folder_id": (
                str(row["original_folder_id"]) if row["original_folder_id"] else None
            ),
            "original_path": _trash_path(db, row["original_folder_id"], path_cache),
            "size_bytes": int(row["size_bytes"] or 0),
            "can_restore": sees_whole_project or (
                row["deleted_by"] is not None and row["deleted_by"] == current_user.id
            ),
            "can_purge": can_purge_here and row["kind"] != "version",
            "child_count": int(row["child_count"] or 0),
            "asset_type": row["asset_type"],
            "asset_id": str(row["asset_id"]) if row["asset_id"] else None,
            "version_number": row["version_number"],
        }

    items = [_item(r) for r in rows]

    return {
        "items": items,
        "total": total,
        "retention_days": RETENTION_DAYS,
        "deleters": deleters,
        "unknown_deleter_present": has_unknown,
        # ── Legacy keys, unchanged shape, same page ──────────────────────
        "folders": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "type": "folder",
                "parent_id": (
                    str(r["original_folder_id"]) if r["original_folder_id"] else None
                ),
                "deleted_at": r["deleted_at"].isoformat() if r["deleted_at"] else None,
            }
            for r in rows if r["kind"] == "folder"
        ],
        "assets": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "type": r["asset_type"],
                "folder_id": (
                    str(r["original_folder_id"]) if r["original_folder_id"] else None
                ),
                "deleted_at": r["deleted_at"].isoformat() if r["deleted_at"] else None,
            }
            for r in rows if r["kind"] == "asset"
        ],
    }

@router.post("/assets/{asset_id}/restore", response_model=dict)
def restore_asset(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take an asset back out of the trash.

    §240 C — `can_restore_asset`, not `editor`: the person who deleted it,
    the project owner, or a superadmin. The same `can_restore_deleted`
    rule the folder restore below and the version restore in
    routers/assets.py use, so all three cannot drift. A row whose
    `deleted_by` is NULL (deleted before §240) is owner/superadmin only.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.isnot(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Deleted asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)
    if not can_restore_asset(db, asset, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=RESTORE_DENIED)

    # If parent folder is deleted, move to root
    if asset.folder_id:
        parent_folder = (
            db.query(Folder)
            .filter(Folder.id == asset.folder_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent_folder:
            asset.folder_id = None

    asset.deleted_at = None
    # §240 A — a live row must never carry a deleter: the trash listing
    # and the restore rule read nothing else, and a stale `deleted_by`
    # would hand the next deletion's restore right to the wrong person.
    asset.deleted_by = None
    asset.deleted_by_name = None
    db.commit()
    return {"ok": True}

@router.post("/folders/{folder_id}/restore", response_model=dict)
def restore_folder(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Take a folder, and what was deleted WITH it, back out of the trash.

    §240 C — `can_restore_folder`, the same rule as the asset restore
    above.

    §240 — and only what was deleted with it. This route used to clear
    `deleted_at` on EVERY deleted descendant and EVERY deleted asset
    underneath, so restoring a folder also resurrected an asset somebody
    had deliberately trashed a week earlier (verified against `main` with
    a test before changing it). It now restores only rows carrying this
    folder's own deletion stamp — the cascade in `delete_folder` writes
    one `deleted_at` value for everything it touches and no longer
    re-stamps rows that were already deleted, which is what makes that
    timestamp a reliable "deleted by the same click" marker, for old rows
    as well as new ones.
    """
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.isnot(None)).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Deleted folder not found")

    require_project_role(db, folder.project_id, current_user, ProjectRole.editor)
    if not can_restore_folder(db, folder, current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=RESTORE_DENIED)

    # If parent folder is deleted, restore to root
    if folder.parent_id:
        parent = (
            db.query(Folder)
            .filter(Folder.id == folder.parent_id, Folder.deleted_at.is_(None))
            .first()
        )
        if not parent:
            folder.parent_id = None

    # Read the stamp BEFORE clearing it — it is what identifies the rest
    # of this deletion.
    stamp = folder.deleted_at
    cleared = {"deleted_at": None, "deleted_by": None, "deleted_by_name": None}

    descendant_ids = _get_descendant_ids_including_deleted(db, folder_id)
    all_ids = [folder_id] + descendant_ids

    db.query(Folder).filter(
        Folder.id.in_(all_ids),
        or_(Folder.id == folder_id, Folder.deleted_at == stamp),
    ).update(cleared, synchronize_session="fetch")
    db.query(Asset).filter(
        Asset.folder_id.in_(all_ids),
        Asset.deleted_at == stamp,
    ).update(cleared, synchronize_session="fetch")

    db.commit()
    return {"ok": True}

# ─── Permanent delete (skip the 30-day wait) ─────────────────────────────────
#
# Owner/admin only, one level above the `editor` gate the rest of this
# router uses. `require_project_role` ranks owner and admin equally (4),
# above editor (3), so passing ProjectRole.admin means exactly "owner or
# manager" — which is what was asked for; there is no separate "manager"
# role, `admin` IS that role (models/project.py:17-22).
#
# Both endpoints only accept an *already soft-deleted* item. That keeps
# this strictly a trash operation rather than a way to skip the trash: you
# cannot destroy a live asset in one call, and the normal editor-level
# delete still has to happen first.

@router.post("/assets/{asset_id}/purge", status_code=status.HTTP_200_OK)
def purge_asset_now(
    asset_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete a soft-deleted asset now. Owner/admin only."""
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.isnot(None)).first()
    if not asset:
        # Deliberately the same 404 whether the asset is live or absent —
        # "this exists but isn't deleted" is the caller using the wrong
        # endpoint, and the trash view is the only legitimate entry point.
        raise HTTPException(status_code=404, detail="Deleted asset not found")

    require_project_role(db, asset.project_id, current_user, ProjectRole.admin)

    stats = purge_asset(db, asset)
    db.commit()
    return {"ok": True, **stats}


@router.post("/folders/{folder_id}/purge", status_code=status.HTTP_200_OK)
def purge_folder_now(
    folder_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Permanently delete a soft-deleted folder and its contents now.

    Owner/admin only. Unlike the scheduled sweep, this recurses into the
    folder's descendants: they were stamped deleted at the same moment but
    are not individually expired yet, and leaving them behind would strand
    rows nothing can ever list again.
    """
    folder = db.query(Folder).filter(Folder.id == folder_id, Folder.deleted_at.isnot(None)).first()
    if not folder:
        raise HTTPException(status_code=404, detail="Deleted folder not found")

    require_project_role(db, folder.project_id, current_user, ProjectRole.admin)

    stats = purge_folder(db, folder)
    db.commit()
    return {"ok": True, **stats}
