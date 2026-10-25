from fastapi import HTTPException, status
from sqlalchemy.orm import Session
import uuid
from ..models.user import User, UserGlobalRole
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset
from ..models.folder import Folder
from ..models.share import AssetShare, ShareLink, ShareLinkItem, SharePermission
from ..services.redis_service import verify_share_session


# ── Project-level ──────────────────────────────────────────────────────────────

def get_project_member(db: Session, project_id: uuid.UUID, user_id: uuid.UUID) -> ProjectMember | None:
    return db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    ).first()


def require_project_role(
    db: Session,
    project_id: uuid.UUID,
    user: User,
    minimum_role: ProjectRole,
) -> ProjectMember:
    """Require the user to have at least `minimum_role` on the project.

    Role hierarchy (descending): owner == admin > editor > reviewer > viewer.
    admin ("Manager") ranks equal to owner here -- no caller of this helper
    ever requires ProjectRole.owner specifically (verified across
    approvals.py, branding.py, folders.py, assets.py, upload.py,
    metadata.py, share.py: every call site requires editor/reviewer/viewer
    only), so this can't leak an owner-exclusive capability. Delete/transfer
    stay owner-only via the separate _require_true_owner_or_superadmin
    check in routers/projects.py, untouched by this.
    """
    ROLE_RANK = {
        ProjectRole.owner: 4,
        ProjectRole.admin: 4,
        ProjectRole.editor: 3,
        ProjectRole.reviewer: 2,
        ProjectRole.viewer: 1,
    }
    member = get_project_member(db, project_id, user.id)
    if not member:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a project member")
    if ROLE_RANK[member.role] < ROLE_RANK[minimum_role]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Requires {minimum_role.value} role or higher",
        )
    return member


def can_see_rating_aggregate(db: Session, project_id: uuid.UUID, user: User) -> bool:
    """Whether `user` can see the aggregate rating (average, vote count, and the
    per-voter breakdown) for assets in this project, as opposed to only their
    own vote.

    - Global superadmins: always.
    - Project owner ("Full Access"): always.
    - Editor ("Edit & Share"): only once the owner opts in via
      `Project.ratings_visible_to_all`.
    - Reviewer ("Comment Only") / viewer ("View Only") / non-members: never —
      they only ever see their own vote, regardless of the toggle.
    """
    if user.role == UserGlobalRole.superadmin:
        return True
    member = get_project_member(db, project_id, user.id)
    if member is None:
        return False
    if member.role == ProjectRole.owner:
        return True
    if member.role == ProjectRole.editor:
        project = db.query(Project).filter(Project.id == project_id).first()
        return project is not None and project.ratings_visible_to_all
    return False


# ── Asset-level ────────────────────────────────────────────────────────────────

def is_public_project(db: Session, project_id: uuid.UUID) -> bool:
    """Check if a project is public."""
    project = db.query(Project).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first()
    return project is not None and project.is_public


def can_access_asset(db: Session, asset: Asset, user: User) -> bool:
    """Check if user can access the asset via any path."""
    # 1. Asset creator
    if asset.created_by == user.id:
        return True

    # 2. Project member
    if get_project_member(db, asset.project_id, user.id):
        return True

    # 3. Direct AssetShare with user
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct:
        return True

    # 4. Public project — any authenticated user can view
    if is_public_project(db, asset.project_id):
        return True

    return False


def require_asset_access(db: Session, asset: Asset, user: User) -> None:
    if not can_access_asset(db, asset, user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


def get_asset_share_permission(db: Session, asset: Asset, user: User) -> SharePermission:
    """Get the effective share permission for a user on an asset (highest wins)."""
    PERM_RANK = {
        SharePermission.approve: 3,
        SharePermission.comment: 2,
        SharePermission.view: 1,
    }

    best = SharePermission.view

    # Direct share
    direct = db.query(AssetShare).filter(
        AssetShare.asset_id == asset.id,
        AssetShare.shared_with_user_id == user.id,
        AssetShare.deleted_at.is_(None),
    ).first()
    if direct and PERM_RANK[direct.permission] > PERM_RANK[best]:
        best = direct.permission

    return best


# ── Share link validation ──────────────────────────────────────────────────────

#: The one answer every scope failure gets: the same 404 an unknown token
#: gets. §234 — a share endpoint that distinguished "no such asset" from
#: "that asset is not in this link" from "that asset is in the trash" would
#: answer, for any uuid a stranger cares to try, which of the three it is.
#: One shape for all of them, so the only thing a caller learns is that this
#: token does not reach that asset.
SHARE_NOT_FOUND = "Share link not found"


def _share_404() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=SHARE_NOT_FOUND)


def is_descendant_of(db: Session, folder_id: uuid.UUID, ancestor_id: uuid.UUID) -> bool:
    """Check if folder_id is a descendant of ancestor_id via parent chain traversal.

    §234 — moved here from routers/share.py (where it was `_is_descendant_of`)
    so the share routes and the share-comment routes decide "is this asset
    inside the shared folder" with ONE function rather than two that drift.
    Behaviour is unchanged: pure ancestry, trash not considered. Liveness is
    `folder_chain_is_live` below, deliberately separate — the download and
    listing paths ask only the ancestry question (§30/§217) and are not
    changed by §234.
    """
    current_id = folder_id
    visited = set()
    while current_id and current_id not in visited:
        if current_id == ancestor_id:
            return True
        visited.add(current_id)
        folder = db.query(Folder.parent_id).filter(Folder.id == current_id).first()
        current_id = folder.parent_id if folder else None
    return False


def folder_chain_is_live(db: Session, folder_id: uuid.UUID) -> bool:
    """True when the folder exists and neither it nor any folder above it is trashed.

    §234, ported from upstream v1.21.0's helper of the same name (which does
    it as one recursive CTE; this walks `parent_id` in Python like
    `is_descendant_of` above, because that is the shape this file already
    uses and the depth is small). A folder's own `deleted_at` is NULL when an
    ancestor was trashed instead — trashing a folder does not stamp its
    subtree — so "is this content live" cannot be answered by looking at one
    row.

    The `visited` set makes a corrupt parent cycle end the walk rather than
    spin.
    """
    current_id = folder_id
    visited = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        row = db.query(Folder.parent_id, Folder.deleted_at).filter(
            Folder.id == current_id
        ).first()
        if row is None or row.deleted_at is not None:
            return False
        current_id = row.parent_id
    return True


def _project_is_live(db: Session, project_id: uuid.UUID | None) -> bool:
    if project_id is None:
        return False
    return db.query(Project.id).filter(
        Project.id == project_id,
        Project.deleted_at.is_(None),
    ).first() is not None


def share_link_content_is_live(db: Session, link: ShareLink) -> bool:
    """Whether what this link points INTO still exists.

    §234 — `validate_share_link` used to check the link row alone: enabled,
    unexpired, not revoked. A link to an asset that was since trashed, or to
    a folder inside a trashed folder, or into a deleted project, kept
    resolving and kept serving. The link row is not touched here, so
    restoring the content brings the link back by itself.
    """
    if link.asset_id:
        asset = db.query(Asset).filter(
            Asset.id == link.asset_id,
            Asset.deleted_at.is_(None),
        ).first()
        if asset is None or not _project_is_live(db, asset.project_id):
            return False
        # An asset under a trashed folder is trashed with it.
        return asset.folder_id is None or folder_chain_is_live(db, asset.folder_id)
    if link.folder_id:
        folder = db.query(Folder).filter(
            Folder.id == link.folder_id,
            Folder.deleted_at.is_(None),
        ).first()
        if folder is None or not _project_is_live(db, folder.project_id):
            return False
        return folder_chain_is_live(db, folder.id)
    return _project_is_live(db, link.project_id)


def asset_is_in_share_scope(db: Session, link: ShareLink, asset: Asset) -> bool:
    """Whether `asset` is inside what `link` shares. Scope only — the caller
    decides what a `False` answers with.

    §234 — THE one implementation of the question. Both the share routes
    (routers/share.py::_validate_asset_in_share, which keeps its own 403
    wording) and `validate_asset_in_share` below read it, so a folder share's
    subtree rule, a single-asset link's identity rule and a multi-share's
    item list cannot come to mean two different things on two routes.
    """
    if link.folder_id:
        if asset.folder_id == link.folder_id:
            return True
        return bool(asset.folder_id) and is_descendant_of(db, asset.folder_id, link.folder_id)
    if link.asset_id:
        return asset.id == link.asset_id
    if link.project_id:
        if asset.project_id != link.project_id:
            return False
        # A multi-share link (ShareLinkItem rows) shares a SELECTION out of
        # the project, not the project. With no rows it is a project share.
        items = db.query(ShareLinkItem).filter(
            ShareLinkItem.share_link_id == link.id
        ).all()
        if not items:
            return True
        if asset.id in {i.asset_id for i in items if i.asset_id}:
            return True
        folder_ids = [i.folder_id for i in items if i.folder_id]
        return any(
            asset.folder_id == fid
            or (asset.folder_id and is_descendant_of(db, asset.folder_id, fid))
            for fid in folder_ids
        )
    return False


def validate_asset_in_share(db: Session, link: ShareLink, asset_id: uuid.UUID) -> Asset:
    """The asset a share-token caller asked for, or 404.

    §234 — for routes that take a client-supplied `asset_id` alongside a
    share token. Holding a token proves the caller holds SOME valid link, not
    that this particular asset is inside it. Four things have to hold, and
    all four answer the same `SHARE_NOT_FOUND`:

      * the asset exists and is not in the trash,
      * its project is not deleted,
      * the folder it sits in, and every folder above that, are live,
      * it is inside the link's own scope (`asset_is_in_share_scope`).

    Returns the asset so the caller does not look it up twice.
    """
    asset = db.query(Asset).filter(
        Asset.id == asset_id,
        Asset.deleted_at.is_(None),
    ).first()
    if asset is None:
        raise _share_404()
    if not _project_is_live(db, asset.project_id):
        raise _share_404()
    if asset.folder_id and not folder_chain_is_live(db, asset.folder_id):
        raise _share_404()
    if not asset_is_in_share_scope(db, link, asset):
        raise _share_404()
    return asset


def validate_share_link(db: Session, token: str) -> ShareLink:
    """Validate a share link token and return the link. Raises 404/410 on failure.

    §234 — a link also resolves only while what it points into is live (see
    `share_link_content_is_live`), checked before the enabled and expiry
    branches so a link into trashed content answers exactly like a token that
    never existed.
    """
    from datetime import datetime, timezone
    link = db.query(ShareLink).filter(
        ShareLink.token == token,
        ShareLink.deleted_at.is_(None),
    ).first()
    if link and not share_link_content_is_live(db, link):
        link = None
    if not link:
        raise _share_404()
    if not link.is_enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Share link is disabled")
    if link.expires_at and link.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Share link has expired")
    return link


def validate_share_link_with_session(
    db: Session,
    token: str,
    share_session: "str | None" = None,
    current_user: "User | None" = None,
) -> ShareLink:
    """Validate a share link and verify password session if link is password-protected.
    Skips password check if the caller is the authenticated link creator."""
    link = validate_share_link(db, token)
    if link.password_hash:
        # Skip password for authenticated link creator (e.g. admin settings preview)
        if current_user and link.created_by == current_user.id:
            return link
        if not share_session or not verify_share_session(token, share_session):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Password required",
            )
    return link
