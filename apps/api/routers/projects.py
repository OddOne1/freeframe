from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File
import io

# Registers AVIF with Pillow's codec registry (§19d). Core Pillow has no
# AVIF decoder, and the plugin is not picked up just by being installed --
# it has to be imported once, before any Image.open(), which is why this
# sits at module scope rather than next to the one function that needs it.
#
# GUARDED, deliberately, and this is a deviation from the spec's literal
# "add import pillow_avif". A bare import makes the entire API fail to boot
# if that one wheel is missing from an image -- and this project has a
# documented history of stale/partial rebuilds and migration crash-loops.
# Degrading to "AVIF posters get no thumbnail" (they still upload, and
# poster_thumb_url falls back to the original) is strictly better than an
# api container that won't start. Same reasoning as the lazy PIL import in
# _build_poster_thumbnail.
try:
    import pillow_avif  # noqa: F401
except ImportError:  # pragma: no cover
    pillow_avif = None
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User, UserGlobalRole
from ..models.project import Project, ProjectMember, ProjectRole
from ..models.asset import Asset, AssetVersion, MediaFile
from ..schemas.project import ProjectCreate, ProjectUpdate, ProjectResponse, ProjectMemberResponse, AddProjectMemberRequest, UpdateProjectMemberRequest, TransferOwnershipRequest
from ..tasks.email_tasks import send_project_added_email
from ..tasks.celery_app import send_task_safe
from ..services.s3_service import put_object, delete_object
from ..services.storage_prefix import SlugUnavailable, claim_user_slug, is_locked
from .hls_proxy import proxy_url_for
from ..config import settings

router = APIRouter(prefix="/projects", tags=["projects"])

def _get_project(db: Session, project_id: uuid.UUID) -> Project:
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project

def _resolve_poster_url(project: Project) -> str | None:
    if project.poster_s3_key:
        return proxy_url_for(project.poster_s3_key)
    return None

def _resolve_poster_thumb_url(project: Project) -> str | None:
    """Small variant of the poster (§19c).

    Falls back to the original, which covers both posters uploaded before
    thumbnails existed and GIFs (deliberately not thumbnailed -- see
    upload_project_poster). Callers can therefore always use this one and
    never have to branch.
    """
    key = project.poster_thumb_s3_key or project.poster_s3_key
    return proxy_url_for(key) if key else None

def apply_poster_urls(resp, project: Project) -> None:
    """Set both poster fields on a response.

    Shared so admin.py can't drift: it had its own inline copy of the
    poster_url logic, which is exactly how the superadmin table would have
    kept serving full-size originals after this change.
    """
    resp.poster_url = _resolve_poster_url(project)
    resp.poster_thumb_url = _resolve_poster_thumb_url(project)

def _require_project_owner(db: Session, project_id: uuid.UUID, user: User) -> ProjectMember:
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member or member.role not in (ProjectRole.owner, ProjectRole.admin):
        raise HTTPException(status_code=403, detail="Project owner access required")
    return member

def _require_project_member_manager(db: Session, project_id: uuid.UUID, user: User) -> ProjectMember:
    """Gates add/update/remove_project_member specifically -- deliberately
    NOT folded into _require_project_owner, which also gates 7 unrelated
    endpoints (update_project, archive_project, poster upload/remove) that
    should not get a superadmin bypass just because member-management needs
    one. Allows the normal owner/admin member, OR a superadmin who has
    joined this project (any active ProjectMember row, including a
    viewer-level Join & View peek) -- superadmins can only manage members in
    projects they've actually joined, not every project unconditionally."""
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if member and (member.role in (ProjectRole.owner, ProjectRole.admin) or user.role == UserGlobalRole.superadmin):
        return member
    raise HTTPException(status_code=403, detail="Project owner access required")

def _get_true_owner_member(db: Session, project_id: uuid.UUID) -> ProjectMember | None:
    """The single ProjectMember holding role=owner for this project (unique,
    enforced by a partial index) -- the current true owner. Not the same as
    project.created_by, which is a frozen "who created this" snapshot and no
    longer moves on transfer."""
    return db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None),
    ).first()

def _require_true_owner_or_superadmin(db: Session, project_id: uuid.UUID, user: User) -> None:
    """Stricter than _require_project_owner: only the current true owner
    (the ProjectMember holding role=owner) or a superadmin may do this, not
    just any Project Admin (role=owner or admin member). Used for delete
    and as the actor-side check for self-service transfer-ownership."""
    if user.role == UserGlobalRole.superadmin:
        return
    owner_member = _get_true_owner_member(db, project_id)
    if not owner_member or owner_member.user_id != user.id:
        raise HTTPException(status_code=403, detail="Only the project owner or a superadmin can do this")

def _project_visible_to(project: Project, user: User, archiver_is_superadmin: bool) -> bool:
    """Archived projects are disabled for everyone except the true owner
    and superadmins. If the archiver was a superadmin, even the true
    owner loses visibility — only superadmins can see/reactivate it then.
    Callers must look up archiver_is_superadmin themselves (Project only
    stores archived_by as a bare user id)."""
    if project.archived_at is None:
        return True
    if user.role == UserGlobalRole.superadmin:
        return True
    if archiver_is_superadmin:
        return False
    return project.created_by == user.id

@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    if current_user.role == UserGlobalRole.user:
        raise HTTPException(status_code=403, detail="Your account can't create projects -- ask a superadmin to upgrade your access")
    project = Project(
        name=body.name,
        description=body.description,
        project_type=body.project_type,
        created_by=current_user.id,
        created_by_name=current_user.name,
        created_by_email=current_user.email,
    )
    db.add(project)
    db.flush()

    # §14. Optional at creation; if omitted, first upload generates one
    # from the name. A hand-typed slug that's taken is a 409 rather than a
    # silent rename -- see claim_user_slug.
    if body.storage_slug is not None:
        try:
            project.storage_slug = claim_user_slug(db, project, body.storage_slug)
        except SlugUnavailable as e:
            raise HTTPException(status_code=409, detail=str(e))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        db.flush()
    member = ProjectMember(project_id=project.id, user_id=current_user.id, role=ProjectRole.owner)
    db.add(member)
    db.commit()
    db.refresh(project)
    return project

@router.get("", response_model=list[ProjectResponse])
def list_projects(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    from sqlalchemy import or_

    # Get memberships for current user
    memberships = db.query(ProjectMember).filter(
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    membership_map = {m.project_id: m.role for m in memberships}
    member_project_ids = list(membership_map.keys())

    # Get projects: user's memberships + all public projects (archived
    # projects are filtered out below via _project_visible_to, since
    # visibility depends on who archived them, not just is_public/membership)
    projects = db.query(Project).filter(
        Project.deleted_at.is_(None),
        or_(
            Project.id.in_(member_project_ids) if member_project_ids else False,
            Project.is_public == True,
        ),
    ).all()

    # Resolve which archivers (if any) are superadmins, so archived projects
    # can be hidden from everyone but the true owner (or from everyone but
    # other superadmins, if a superadmin did the archiving).
    archiver_ids = {p.archived_by for p in projects if p.archived_by is not None}
    superadmin_archiver_ids = set()
    if archiver_ids:
        superadmin_archiver_ids = {
            u.id for u in db.query(User).filter(User.id.in_(archiver_ids), User.role == UserGlobalRole.superadmin).all()
        }
    projects = [
        p for p in projects
        if _project_visible_to(p, current_user, p.archived_by in superadmin_archiver_ids)
    ]

    all_project_ids = [p.id for p in projects]
    if not all_project_ids:
        return []

    # Batch: asset counts per project
    asset_counts = dict(
        db.query(Asset.project_id, func.count(Asset.id))
        .filter(Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )

    # Batch: storage bytes per project (sum of file sizes)
    storage_query = (
        db.query(Asset.project_id, func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .join(MediaFile, MediaFile.version_id == AssetVersion.id)
        .filter(Asset.project_id.in_(all_project_ids), Asset.deleted_at.is_(None))
        .group_by(Asset.project_id)
        .all()
    )
    storage_map = {pid: int(size) for pid, size in storage_query}

    # Batch: member counts per project
    member_counts = dict(
        db.query(ProjectMember.project_id, func.count(ProjectMember.id))
        .filter(ProjectMember.project_id.in_(all_project_ids), ProjectMember.deleted_at.is_(None))
        .group_by(ProjectMember.project_id)
        .all()
    )

    result = []
    for p in projects:
        resp = ProjectResponse.model_validate(p)
        apply_poster_urls(resp, p)
        resp.asset_count = asset_counts.get(p.id, 0)
        resp.storage_bytes = storage_map.get(p.id, 0)
        resp.member_count = member_counts.get(p.id, 0)
        resp.role = membership_map.get(p.id)
        resp.archived_by_is_superadmin = p.archived_by in superadmin_archiver_ids
        result.append(resp)

    return result

@router.get("/{project_id}", response_model=ProjectResponse)
def get_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member and not project.is_public:
        raise HTTPException(status_code=403, detail="Not a project member")

    archiver_is_superadmin = False
    if project.archived_by is not None:
        archiver = db.query(User).filter(User.id == project.archived_by).first()
        archiver_is_superadmin = bool(archiver and archiver.role == UserGlobalRole.superadmin)
    if not _project_visible_to(project, current_user, archiver_is_superadmin):
        raise HTTPException(status_code=403, detail="This project has been archived")

    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    resp.archived_by_is_superadmin = archiver_is_superadmin
    if member:
        resp.role = member.role
    # Calculate storage, asset count, member count
    resp.asset_count = db.query(func.count(Asset.id)).filter(
        Asset.project_id == project_id, Asset.deleted_at.is_(None),
    ).scalar() or 0
    resp.storage_bytes = db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0)).join(
        AssetVersion, MediaFile.version_id == AssetVersion.id
    ).join(Asset, AssetVersion.asset_id == Asset.id).filter(
        Asset.project_id == project_id, Asset.deleted_at.is_(None),
    ).scalar() or 0
    resp.member_count = db.query(func.count(ProjectMember.id)).filter(
        ProjectMember.project_id == project_id, ProjectMember.deleted_at.is_(None),
    ).scalar() or 0
    return resp

def _owner_storage_snapshot(db: Session, project_id: uuid.UUID) -> tuple[User, int] | None:
    """(true owner, amount already allocated to their *other* owned
    projects' explicit limits) for this project, or None if there's no
    resolvable true owner. Shared by _check_owner_storage_allocation
    (enforcing a new explicit limit) and _owner_remaining_storage_budget
    (what an owner's field resolves to when they clear it back to blank) --
    same underlying query, not reimplemented twice."""
    owner_member = _get_true_owner_member(db, project_id)
    if not owner_member:
        return None
    owner = db.query(User).filter(User.id == owner_member.user_id).first()
    if not owner:
        return None
    allocated_elsewhere = db.query(func.coalesce(func.sum(Project.storage_limit_bytes), 0)).join(
        ProjectMember, ProjectMember.project_id == Project.id
    ).filter(
        ProjectMember.user_id == owner.id,
        ProjectMember.role == ProjectRole.owner,
        ProjectMember.deleted_at.is_(None),
        Project.deleted_at.is_(None),
        Project.id != project_id,
    ).scalar() or 0
    return owner, allocated_elsewhere

def _check_owner_storage_allocation(db: Session, project_id: uuid.UUID, new_limit: int) -> None:
    """The project's true owner has a personal storage_limit_bytes budget
    (task 12) -- the sum of storage_limit_bytes across every project they
    currently own (excluding this one) plus new_limit can't exceed it. No
    personal limit (NULL) means unlimited, so nothing to enforce. A NULL
    (unlimited) sibling project contributes 0 to the sum rather than being
    treated as unbounded -- SQL SUM skips NULLs; the spec doesn't say how
    to handle that combination so this is the literal reading, not a
    considered decision."""
    snapshot = _owner_storage_snapshot(db, project_id)
    if not snapshot:
        return
    owner, allocated_elsewhere = snapshot
    if owner.storage_limit_bytes is None:
        return
    if allocated_elsewhere + new_limit > owner.storage_limit_bytes:
        raise HTTPException(
            status_code=400,
            detail="This would exceed the project owner's total storage limit",
        )

def _owner_remaining_storage_budget(db: Session, project_id: uuid.UUID) -> int | None:
    """What an owner's storage_limit_bytes should resolve to when they
    explicitly clear the field back to blank (storage limit UX task,
    2026-07-23): their personal total minus what's already allocated to
    their *other* owned projects. None if there's no resolvable true owner
    or the owner's own personal total is itself unlimited -- callers should
    store None (true unlimited) in that case, not a computed number."""
    snapshot = _owner_storage_snapshot(db, project_id)
    if not snapshot:
        return None
    owner, allocated_elsewhere = snapshot
    if owner.storage_limit_bytes is None:
        return None
    return max(owner.storage_limit_bytes - allocated_elsewhere, 0)

@router.patch("/{project_id}", response_model=ProjectResponse)
def update_project(project_id: uuid.UUID, body: ProjectUpdate, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    project = _get_project(db, project_id)
    fields_set = body.model_fields_set

    # ratings_visible_to_all is the one field a superadmin can toggle even if
    # they aren't a project member/owner — everything else still requires the
    # strict project-owner check below, unchanged from before.
    if fields_set - {"ratings_visible_to_all"}:
        _require_project_owner(db, project_id, current_user)
    if "ratings_visible_to_all" in fields_set and current_user.role != UserGlobalRole.superadmin:
        _require_project_owner(db, project_id, current_user)

    if body.name is not None:
        project.name = body.name
    if body.description is not None:
        project.description = body.description
    if body.is_public is not None:
        project.is_public = body.is_public
    if "storage_limit_bytes" in fields_set:
        if body.storage_limit_bytes is not None:
            if current_user.role != UserGlobalRole.superadmin:
                _check_owner_storage_allocation(db, project_id, body.storage_limit_bytes)
            project.storage_limit_bytes = body.storage_limit_bytes
        elif current_user.role == UserGlobalRole.superadmin:
            # A superadmin explicitly clearing the field gets true
            # unlimited -- they aren't bound by anyone's personal storage
            # math, unlike the owner branch below.
            project.storage_limit_bytes = None
        else:
            # Owner explicitly cleared the field: store their remaining
            # personal budget as a concrete number rather than true NULL,
            # so "empty" means "whatever's left of my total," not literally
            # unlimited (storage limit UX task, 2026-07-23). Naturally
            # resolves back to None when the owner's own personal total is
            # itself unlimited.
            project.storage_limit_bytes = _owner_remaining_storage_budget(db, project_id)
    if "storage_slug" in fields_set:
        # §14. Enforced HERE, not merely disabled in the UI -- the whole
        # point of freezing it is that an in-flight or already-written
        # object's key keeps matching its project, and a client that skips
        # the form can't be allowed to break that.
        if is_locked(project):
            raise HTTPException(
                status_code=409,
                detail="Storage slug is locked -- it was set when this project's first upload started and can't change.",
            )
        if body.storage_slug is None:
            project.storage_slug = None
        else:
            try:
                project.storage_slug = claim_user_slug(db, project, body.storage_slug)
            except SlugUnavailable as e:
                raise HTTPException(status_code=409, detail=str(e))
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))
    if body.ratings_visible_to_all is not None:
        project.ratings_visible_to_all = body.ratings_visible_to_all
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    return resp

@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Permanent (soft) delete. Unlike other project-management actions,
    this is NOT open to every Project Admin (role=owner or admin member) —
    only the current true owner (role=owner) or a superadmin. Project
    Admins who want a reversible option should use archive instead."""
    project = _get_project(db, project_id)
    _require_true_owner_or_superadmin(db, project_id, current_user)
    project.deleted_at = datetime.now(timezone.utc)
    db.commit()

@router.get("/{project_id}/members", response_model=list[ProjectMemberResponse])
def list_project_members(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    # Verify user is a member -- except superadmins, who can inspect
    # membership on any project (e.g. the card's expandable Members section
    # for a public project they haven't joined).
    member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == current_user.id,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not member and current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(status_code=403, detail="Not a project member")
    
    members = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.deleted_at.is_(None),
    ).all()
    return members

@router.post("/{project_id}/members", response_model=ProjectMemberResponse, status_code=status.HTTP_201_CREATED)
def add_project_member(project_id: uuid.UUID, body: AddProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_member_manager(db, project_id, current_user)
    if body.role == ProjectRole.owner:
        raise HTTPException(status_code=400, detail="Use Transfer Ownership to make someone the project owner")
    existing = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == body.user_id).first()
    if existing:
        if existing.deleted_at is None:
            raise HTTPException(status_code=400, detail="User already a project member")
        # Reactivate soft-deleted membership
        existing.deleted_at = None
        existing.role = body.role
        db.commit()
        db.refresh(existing)
        member = existing
    else:
        member = ProjectMember(project_id=project_id, user_id=body.user_id, role=body.role, invited_by=current_user.id)
        db.add(member)
        db.commit()
        db.refresh(member)

    # Send project added email (for both new and reactivated members)
    project = _get_project(db, project_id)
    added_user = db.query(User).filter(User.id == body.user_id).first()
    if added_user:
        project_link = f"{settings.frontend_url}/projects/{project_id}"
        send_task_safe(send_project_added_email,
            to_email=added_user.email,
            adder_name=current_user.name,
            project_name=project.name,
            project_link=project_link,
            role=body.role.value if body.role else None,
        )

    return member

@router.patch("/{project_id}/members/{user_id}", response_model=ProjectMemberResponse)
def update_project_member(project_id: uuid.UUID, user_id: uuid.UUID, body: UpdateProjectMemberRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_member_manager(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    # role=owner is unique per project (see _get_true_owner_member) -- can
    # only move via Transfer Ownership, never a direct role edit here.
    if member.role == ProjectRole.owner and body.role != ProjectRole.owner:
        raise HTTPException(status_code=400, detail="Transfer ownership before demoting the project owner")
    if body.role == ProjectRole.owner and member.role != ProjectRole.owner:
        raise HTTPException(status_code=400, detail="Use Transfer Ownership to make someone the project owner")
    member.role = body.role
    db.commit()
    db.refresh(member)
    return member

@router.delete("/{project_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_member(project_id: uuid.UUID, user_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_project(db, project_id)
    _require_project_member_manager(db, project_id, current_user)
    member = db.query(ProjectMember).filter(ProjectMember.project_id == project_id, ProjectMember.user_id == user_id, ProjectMember.deleted_at.is_(None)).first()
    if not member:
        raise HTTPException(status_code=404, detail="Member not found")
    if member.role == ProjectRole.owner:
        raise HTTPException(status_code=400, detail="Transfer ownership before removing the project owner")
    member.deleted_at = datetime.now(timezone.utc)
    db.commit()

# ── Archiving & self-service ownership transfer ─────────────────────────────

@router.post("/{project_id}/archive", response_model=ProjectResponse)
def archive_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Reversible alternative to delete. Any Project Admin (role=owner or
    admin member) or a superadmin can archive; see _project_visible_to for
    who can still see/reactivate it afterward."""
    project = _get_project(db, project_id)
    if current_user.role != UserGlobalRole.superadmin:
        _require_project_owner(db, project_id, current_user)
    if project.archived_at is not None:
        raise HTTPException(status_code=400, detail="Project is already archived")
    project.archived_at = datetime.now(timezone.utc)
    project.archived_by = current_user.id
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    resp.archived_by_is_superadmin = current_user.role == UserGlobalRole.superadmin
    return resp

@router.post("/{project_id}/reactivate", response_model=ProjectResponse)
def reactivate_project(project_id: uuid.UUID, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """If a superadmin archived the project, only a superadmin may
    reactivate it. If the true owner archived it themselves, that owner
    or any superadmin may reactivate."""
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.archived_at is None:
        raise HTTPException(status_code=400, detail="Project is not archived")

    archiver_is_superadmin = False
    if project.archived_by is not None:
        archiver = db.query(User).filter(User.id == project.archived_by).first()
        archiver_is_superadmin = bool(archiver and archiver.role == UserGlobalRole.superadmin)

    if current_user.role != UserGlobalRole.superadmin:
        if archiver_is_superadmin or project.created_by != current_user.id:
            raise HTTPException(status_code=403, detail="Only a superadmin can reactivate this project")

    project.archived_at = None
    project.archived_by = None
    db.commit()
    db.refresh(project)
    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    return resp

@router.post("/{project_id}/transfer-ownership", response_model=ProjectResponse)
def transfer_project_ownership(project_id: uuid.UUID, body: TransferOwnershipRequest, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Self-service transfer, only for the current true owner (the
    ProjectMember holding role=owner), only to an existing admin-tier
    Project Admin (role=admin member) on this project. Flips
    ProjectMember.role on both sides -- the old owner becomes admin, the
    target becomes owner -- rather than touching project.created_by, which
    is a frozen creation-time snapshot and no longer tracks current
    ownership. Superadmins use the separate admin-bypass endpoint in
    admin.py, which can promote/add anyone regardless of current role."""
    _get_project(db, project_id)
    _require_true_owner_or_superadmin(db, project_id, current_user)
    owner_member = _get_true_owner_member(db, project_id)
    if not owner_member:
        raise HTTPException(status_code=400, detail="This project has no current owner to transfer from")

    target_member = db.query(ProjectMember).filter(
        ProjectMember.project_id == project_id,
        ProjectMember.user_id == body.new_owner_id,
        ProjectMember.role == ProjectRole.admin,
        ProjectMember.deleted_at.is_(None),
    ).first()
    if not target_member:
        raise HTTPException(status_code=400, detail="Target must already be a Project Admin on this project — promote them first")

    target_user = db.query(User).filter(User.id == body.new_owner_id).first()
    if not target_user or target_user.role == UserGlobalRole.user:
        raise HTTPException(status_code=400, detail="This account's tier doesn't allow project ownership")

    owner_member.role = ProjectRole.admin
    target_member.role = ProjectRole.owner
    db.commit()
    project = _get_project(db, project_id)
    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    return resp

ALLOWED_POSTER_TYPES = {"image/jpeg", "image/png", "image/webp", "image/avif"}
MAX_POSTER_SIZE = 10 * 1024 * 1024  # 10MB

# Long edge of the generated thumbnail (§19c). Sized from the actual render
# sizes in the frontend rather than picked round: the largest a poster is
# ever drawn is the projects grid, which is aspect-square across 2-5 columns
# (apps/web/app/(dashboard)/projects/page.tsx) -- roughly 300-480 CSS px on a
# wide display. 800 covers a 400px card at 2x DPR. The other two call sites
# are far smaller: a 32px table icon and the settings-dialog preview.
POSTER_THUMB_MAX_EDGE = 800
POSTER_THUMB_QUALITY = 85


def _build_poster_thumbnail(data: bytes, content_type: str | None) -> bytes | None:
    """Downscaled JPEG copy of an uploaded poster, or None to skip.

    There is no per-format special case any more. §19c returned None for
    GIF to preserve animation; §19d removed GIF from ALLOWED_POSTER_TYPES
    entirely (no animated images anywhere), so that branch became
    unreachable and was deleted rather than adapted. AVIF took GIF's place
    and needs nothing of its own -- it decodes through the same Image.open()
    path as every other static format, given the plugin import at module
    scope (see the note there; core Pillow has no AVIF codec).

    Returns None rather than raising if Pillow can't read the file: the
    upload has already been validated and stored, and failing the whole
    request over a missing derivative would be worse than serving the
    original, which every caller already falls back to.
    """
    try:
        from PIL import Image, ImageOps

        with Image.open(io.BytesIO(data)) as im:
            im.load()
            # Honour EXIF orientation before measuring, or a rotated phone
            # photo gets a thumbnail cropped against its displayed shape.
            im = ImageOps.exif_transpose(im) or im
            if max(im.size) <= POSTER_THUMB_MAX_EDGE and content_type == "image/jpeg":
                # Already small and already JPEG -- re-encoding would only
                # lose quality for no saving.
                return None
            im.thumbnail((POSTER_THUMB_MAX_EDGE, POSTER_THUMB_MAX_EDGE), Image.LANCZOS)
            if im.mode in ("RGBA", "LA", "P"):
                # JPEG has no alpha. Composite onto white rather than letting
                # the converter fill with black, which turns a transparent
                # logo poster into a black square.
                im = im.convert("RGBA")
                flat = Image.new("RGB", im.size, (255, 255, 255))
                flat.paste(im, mask=im.split()[-1])
                im = flat
            elif im.mode != "RGB":
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=POSTER_THUMB_QUALITY, optimize=True)
            return buf.getvalue()
    except Exception:
        return None

@router.post("/{project_id}/poster", response_model=ProjectResponse)
async def upload_project_poster(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)

    if file.content_type not in ALLOWED_POSTER_TYPES:
        raise HTTPException(status_code=400, detail="File must be JPEG, PNG, WebP, or AVIF")

    data = await file.read()
    if len(data) > MAX_POSTER_SIZE:
        raise HTTPException(status_code=400, detail="File must be under 10MB")

    # Delete old poster if exists
    for old_key in (project.poster_s3_key, project.poster_thumb_s3_key):
        if old_key:
            try:
                delete_object(old_key)
            except Exception:
                pass

    ext = file.filename.rsplit(".", 1)[-1].lower() if file.filename and "." in file.filename else "jpg"
    s3_key = f"posters/{project_id}/poster.{ext}"
    put_object(s3_key, data, content_type=file.content_type, cache_control="max-age=86400")

    thumb_key = f"posters/{project_id}/poster_thumb.jpg"
    thumb = _build_poster_thumbnail(data, file.content_type)
    if thumb is not None:
        put_object(thumb_key, thumb, content_type="image/jpeg", cache_control="max-age=86400")
    else:
        thumb_key = None

    project.poster_s3_key = s3_key
    project.poster_thumb_s3_key = thumb_key
    db.commit()
    db.refresh(project)

    resp = ProjectResponse.model_validate(project)
    apply_poster_urls(resp, project)
    return resp

@router.delete("/{project_id}/poster", status_code=status.HTTP_204_NO_CONTENT)
def remove_project_poster(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    project = _get_project(db, project_id)
    _require_project_owner(db, project_id, current_user)

    if project.poster_s3_key or project.poster_thumb_s3_key:
        for key in (project.poster_s3_key, project.poster_thumb_s3_key):
            if key:
                try:
                    delete_object(key)
                except Exception:
                    pass
        project.poster_s3_key = None
        project.poster_thumb_s3_key = None
        db.commit()
