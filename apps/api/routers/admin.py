"""Admin endpoints for user and project management."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timezone

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User, UserStatus
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset, AssetVersion, MediaFile
from ..schemas.auth import UserResponse, UpdateUserRoleRequest, AdminUserResponse, AdminUserProjectSummary
from ..schemas.project import ProjectUpdate, AdminProjectResponse, TransferOwnershipRequest
from .hls_proxy import proxy_url_for

router = APIRouter(prefix="/admin", tags=["admin"])

def _require_superadmin(current_user: User) -> None:
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can access this endpoint"
        )


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/users", response_model=list[AdminUserResponse])
def list_all_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List all users in the system, each with a per-project role summary
    (so the dashboard can group by Admin/Member and show per-project roles
    without a round-trip per user). Only accessible by admins."""
    _require_superadmin(current_user)

    users = db.query(User).filter(User.deleted_at.is_(None)).all()
    user_ids = [u.id for u in users]
    if not user_ids:
        return []

    membership_rows = (
        db.query(ProjectMember.user_id, ProjectMember.role, Project.id, Project.name)
        .join(Project, Project.id == ProjectMember.project_id)
        .filter(
            ProjectMember.user_id.in_(user_ids),
            ProjectMember.deleted_at.is_(None),
            Project.deleted_at.is_(None),
        )
        .all()
    )
    projects_by_user: dict[uuid.UUID, list[AdminUserProjectSummary]] = {}
    for user_id, role, project_id, project_name in membership_rows:
        projects_by_user.setdefault(user_id, []).append(
            AdminUserProjectSummary(project_id=project_id, project_name=project_name, role=role)
        )

    result = []
    for u in users:
        resp = AdminUserResponse.model_validate(u)
        resp.projects = projects_by_user.get(u.id, [])
        result.append(resp)
    return result

@router.patch("/users/{user_id}/deactivate", response_model=UserResponse)
def deactivate_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Deactivate a user. Admins cannot deactivate themselves."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can deactivate users"
        )

    # Prevent admin from deactivating themselves
    if user_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot deactivate yourself"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.status = UserStatus.deactivated
    db.commit()
    db.refresh(user)
    return user

@router.patch("/users/{user_id}/reactivate", response_model=UserResponse)
def reactivate_user(
    user_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Reactivate a deactivated user. Only accessible by admins."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can reactivate users"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.status = UserStatus.active
    db.commit()
    db.refresh(user)
    return user

@router.patch("/users/{user_id}/role", response_model=UserResponse)
def update_user_role(
    user_id: uuid.UUID,
    body: UpdateUserRoleRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Promote or demote a user to/from admin role. Only accessible by admins."""
    if not current_user.is_superadmin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can change user roles"
        )

    # Prevent admin from removing their own admin role
    if user_id == current_user.id and not body.is_admin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot remove your own admin role"
        )

    user = db.query(User).filter(User.id == user_id, User.deleted_at.is_(None)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.is_superadmin = body.is_admin
    db.commit()
    db.refresh(user)
    return user


# ── Project overview & management ────────────────────────────────────────────

def _apply_project_stats(db: Session, resp: AdminProjectResponse, project: Project, owners: dict) -> None:
    resp.poster_url = proxy_url_for(project.poster_s3_key) if project.poster_s3_key else None
    owner = owners.get(project.created_by)
    resp.owner_name = owner.name if owner else None
    resp.owner_email = owner.email if owner else None

def _archiver_is_superadmin(db: Session, project: Project) -> bool:
    if project.archived_by is None:
        return False
    archiver = db.query(User).filter(User.id == project.archived_by).first()
    return bool(archiver and archiver.is_superadmin)

def _current_user_role(db: Session, project_id: uuid.UUID, user_id: uuid.UUID):
    membership = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user_id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    return membership.role if membership else None

@router.get("/projects", response_model=list[AdminProjectResponse])
def list_all_projects(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List every non-deleted project with owner identity and usage stats.
    Unlike GET /projects, this ignores membership entirely — admins see
    everything. Only accessible by admins."""
    _require_superadmin(current_user)

    projects = db.query(Project).filter(Project.deleted_at.is_(None)).all()
    project_ids = [p.id for p in projects]
    if not project_ids:
        return []

    asset_counts = dict(
        db.query(Asset.project_id, func.count(Asset.id))
        .filter(Asset.project_id.in_(project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )
    storage_query = (
        db.query(Asset.project_id, func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        .filter(Asset.project_id.in_(project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )
    storage_map = {pid: int(size) for pid, size in storage_query}
    member_counts = dict(
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(project_ids), ProjectMember.deleted_at.is_(None))
        .group_by(ProjectMember.project_id)
        .all()
    )
    owners = {
        u.id: u for u in db.query(User).filter(User.id.in_([p.created_by for p in projects])).all()
    }
    archiver_ids = {p.archived_by for p in projects if p.archived_by is not None}
    superadmin_archiver_ids = set()
    if archiver_ids:
        superadmin_archiver_ids = {
            u.id for u in db.query(User).filter(User.id.in_(archiver_ids), User.is_superadmin == True).all()
        }
    my_memberships = dict(
        db.query(ProjectMember.project_id, ProjectMember.role)
        .filter(
            ProjectMember.project_id.in_(project_ids),
            ProjectMember.user_id == current_user.id,
            ProjectMember.deleted_at.is_(None),
        )
        .all()
    )

    result = []
    for p in projects:
        resp = AdminProjectResponse.model_validate(p)
        resp.asset_count = asset_counts.get(p.id, 0)
        resp.storage_bytes = storage_map.get(p.id, 0)
        resp.member_count = member_counts.get(p.id, 0)
        resp.archived_by_is_superadmin = p.archived_by in superadmin_archiver_ids
        resp.current_user_role = my_memberships.get(p.id)
        _apply_project_stats(db, resp, p, owners)
        result.append(resp)
    return result

@router.patch("/projects/{project_id}", response_model=AdminProjectResponse)
def admin_update_project(
    project_id: uuid.UUID,
    body: ProjectUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename/update any project, bypassing the normal owner-only check.
    Only accessible by admins."""
    _require_superadmin(current_user)

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    if body.is_public is not None:
        project.is_public = body.is_public
    if body.storage_limit_bytes is not None:
        project.storage_limit_bytes = body.storage_limit_bytes
    if body.ratings_visible_to_all is not None:
        project.ratings_visible_to_all = body.ratings_visible_to_all
    db.commit()
    db.refresh(project)

    resp = AdminProjectResponse.model_validate(project)
    resp.archived_by_is_superadmin = _archiver_is_superadmin(db, project)
    resp.current_user_role = _current_user_role(db, project.id, current_user.id)
    owners = {project.created_by: db.query(User).filter(User.id == project.created_by).first()}
    _apply_project_stats(db, resp, project, owners)
    return resp

@router.delete("/projects/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def admin_delete_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete any project, bypassing the normal owner-only check.
    Only accessible by admins."""
    _require_superadmin(current_user)

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    project.deleted_at = datetime.now(timezone.utc)
    db.commit()

@router.post("/projects/{project_id}/join", response_model=AdminProjectResponse)
def admin_join_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Let a superadmin add themselves to a project as a viewer, so they
    can inspect its contents. Superadmins can see every project's
    metadata/stats via GET /admin/projects regardless of membership, but
    viewing actual assets still goes through the normal membership check
    in projects.py — this is the deliberate privacy boundary: admin
    powers over a project (rename/delete/archive/transfer) don't imply
    content access. Only accessible by admins."""
    _require_superadmin(current_user)

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    existing = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
    ).first()
    if existing:
        existing.deleted_at = None
        joined_role = existing.role
    else:
        db.add(ProjectMember(
            project_id=project_id, user_id=current_user.id,
            role=ProjectRole.viewer, invited_by=current_user.id,
        ))
        joined_role = ProjectRole.viewer
    db.commit()
    db.refresh(project)

    resp = AdminProjectResponse.model_validate(project)
    resp.archived_by_is_superadmin = _archiver_is_superadmin(db, project)
    resp.current_user_role = joined_role
    owners = {project.created_by: db.query(User).filter(User.id == project.created_by).first()}
    _apply_project_stats(db, resp, project, owners)
    return resp

@router.post("/projects/{project_id}/leave", response_model=AdminProjectResponse)
def admin_leave_project(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Undo the self-join from admin_join_project — lets a superadmin who
    peeked into a project (via Join & View) remove themselves again.
    Scoped to viewer-role memberships only: if the superadmin has a real
    editor/reviewer/owner membership on this project (actual
    collaboration, not just a peek), this endpoint refuses — that kind of
    membership should be managed from the project's own Members panel,
    not one-clicked away from the admin table. Only accessible by
    admins."""
    _require_superadmin(current_user)

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    membership = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not membership:
        raise HTTPException(status_code=404, detail="You are not a member of this project")
    if membership.role != ProjectRole.viewer:
        raise HTTPException(
            status_code=400,
            detail="This is a real project membership, not a Join & View peek — manage it from the project's Members panel instead.",
        )

    membership.deleted_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(project)

    resp = AdminProjectResponse.model_validate(project)
    resp.archived_by_is_superadmin = _archiver_is_superadmin(db, project)
    resp.current_user_role = None
    owners = {project.created_by: db.query(User).filter(User.id == project.created_by).first()}
    _apply_project_stats(db, resp, project, owners)
    return resp

@router.post("/projects/{project_id}/transfer-ownership", response_model=AdminProjectResponse)
def admin_transfer_ownership(
    project_id: uuid.UUID,
    body: TransferOwnershipRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Transfer a project's ownership to a different user, bypassing the
    normal "target must already be a Project Admin" restriction on the
    self-service version of this endpoint (projects.py) — admins may hand
    the project to anyone, promoting/adding them as a Project Admin
    (role=owner member) if needed. Unlike the old behavior, this does NOT
    demote other existing Project Admins to editor: "Project Admin"
    (role=owner) is a legitimate multi-person tier now, separate from the
    single canonical Owner (Project.created_by) this endpoint moves.
    Only accessible by admins."""
    _require_superadmin(current_user)

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    new_owner = db.query(User).filter(User.id == body.new_owner_id, User.deleted_at.is_(None)).first()
    if not new_owner:
        raise HTTPException(status_code=404, detail="Target user not found")

    membership = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == body.new_owner_id,
    ).first()
    if membership:
        membership.role = ProjectRole.owner
        membership.deleted_at = None
    else:
        db.add(ProjectMember(
            project_id=project_id, user_id=body.new_owner_id,
            role=ProjectRole.owner, invited_by=current_user.id,
        ))

    project.created_by = body.new_owner_id
    db.commit()
    db.refresh(project)

    resp = AdminProjectResponse.model_validate(project)
    resp.archived_by_is_superadmin = _archiver_is_superadmin(db, project)
    resp.current_user_role = _current_user_role(db, project.id, current_user.id)
    _apply_project_stats(db, resp, project, {new_owner.id: new_owner})
    return resp
