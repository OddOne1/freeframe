"""Personal LUT libraries, project sharing, and graded exports.

Ownership model (user decision 2026-07-30): a LUT belongs to the user who
uploaded it and follows them everywhere; separately it can be shared into a
specific project so that team can use it. Two consequences run through this
whole file:

- Listing a project's LUTs returns the union of *your* library and
  everything shared into that project — not just the shared set.
- Previewing a LUT locally never requires a share, but setting it as the
  asset's grade for the whole team does. Otherwise a teammate would see a
  reference to a personal LUT they cannot read.
"""

import hashlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User, UserGlobalRole
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType
from ..models.lut import Lut, LutGroup, ProjectLutShare
from ..models.project import ProjectRole
from ..schemas.asset import StreamUrlResponse
from ..schemas.lut import (
    LutResponse, LutExportResponse, ApplyLutRequest, LutUpdate,
    LutGroupResponse, LutGroupCreate, LutGroupUpdate,
)
from ..services import s3_service
from ..services.permissions import require_project_role, require_asset_access
from .hls_proxy import proxy_url_for

router = APIRouter(tags=["luts"])

# A .cube is plain text: `LUT_3D_SIZE N` then N^3 float triples. Size 64 is
# already ~1MB of text; anything past that is far outside normal use and is
# far more likely to be a mis-uploaded file than a real LUT.
MAX_CUBE_BYTES = 8 * 1024 * 1024
MAX_LUT_SIZE = 64


def _parse_cube_size(text: str) -> int:
    """Pull LUT_3D_SIZE out of a .cube header, validating the file is
    actually a 3D LUT while we're here.

    Deliberately strict: silently accepting a file that isn't a .cube would
    surface later as a preview that renders wrong rather than an upload that
    failed, and wrong-but-plausible color is the exact failure mode this
    feature must not have.
    """
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if parts[0].upper() == "LUT_3D_SIZE":
            try:
                size = int(parts[1])
            except (IndexError, ValueError):
                raise HTTPException(status_code=400, detail="Malformed LUT_3D_SIZE in .cube file")
            if size < 2 or size > MAX_LUT_SIZE:
                raise HTTPException(
                    status_code=400,
                    detail=f"LUT_3D_SIZE must be between 2 and {MAX_LUT_SIZE} (got {size})",
                )
            return size
        if parts[0].upper() == "LUT_1D_SIZE":
            raise HTTPException(
                status_code=400,
                detail="1D LUTs are not supported — upload a 3D .cube file",
            )
    raise HTTPException(status_code=400, detail="No LUT_3D_SIZE found — is this a .cube file?")


def _content_hash(text: str) -> str:
    """SHA-256 of the LUT's *canonical* contents (§44).

    Deliberately not a hash of the raw bytes. The same grade re-exported by
    a different tool differs in its TITLE line, its comments, its line
    endings and its float formatting while describing an identical
    transform -- and "two differently-named files with identical LUT data
    are the same duplicate" is the whole point. Hashing raw bytes would
    catch only byte-identical copies, which is the easy half.

    Canonical form is: the 3D size, the input domain, and every entry
    formatted to 6 decimals. Six because .cube values are display-referred
    floats that no real grading tool authors past that, and because a
    re-export that lands on 0.100000001 instead of 0.1 must not read as a
    different LUT. Two genuinely different LUTs that agree to six decimals
    would collide -- they would also be visually indistinguishable, so that
    is the right side to err on.

    DOMAIN_MIN/MAX are included, not normalised away: they change what the
    table means, so two files with identical entries and different domains
    are genuinely different LUTs.
    """
    size: Optional[int] = None
    domain_min = ["0.000000", "0.000000", "0.000000"]
    domain_max = ["1.000000", "1.000000", "1.000000"]
    entries: list[str] = []

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        keyword = parts[0].upper()
        if keyword == "LUT_3D_SIZE":
            size = int(parts[1])
            continue
        if keyword in ("TITLE", "LUT_1D_SIZE"):
            continue
        if keyword in ("DOMAIN_MIN", "DOMAIN_MAX"):
            try:
                values = [f"{float(v):.6f}" for v in parts[1:4]]
            except ValueError:
                continue
            if len(values) == 3:
                if keyword == "DOMAIN_MIN":
                    domain_min = values
                else:
                    domain_max = values
            continue
        try:
            triple = [f"{float(v):.6f}" for v in parts[:3]]
        except ValueError:
            # Any other keyword line. Ignored rather than fatal: the file has
            # already passed _parse_cube_size, so it is a .cube.
            continue
        if len(triple) == 3:
            entries.append(" ".join(triple))

    canonical = "\n".join([f"SIZE {size}", "MIN " + " ".join(domain_min), "MAX " + " ".join(domain_max), *entries])
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _describe(lut: Lut, db: Session) -> str:
    """"Kodak 2383" (in "House Looks")" -- the user asked to be told where
    the existing copy already lives, not just that one exists."""
    where = ""
    if lut.group_id:
        group = db.query(LutGroup).filter(LutGroup.id == lut.group_id).first()
        if group:
            where = f' (in "{group.name}")'
    return f'"{lut.name}"{where}'


def _find_owner_duplicate(db: Session, owner_id, content_hash: str, exclude_id=None) -> Optional[Lut]:
    q = db.query(Lut).filter(
        Lut.owner_id == owner_id,
        Lut.content_hash == content_hash,
        Lut.deleted_at.is_(None),
    )
    if exclude_id is not None:
        q = q.filter(Lut.id != exclude_id)
    return q.first()


def _find_platform_duplicate(db: Session, content_hash: str, exclude_id=None) -> Optional[Lut]:
    """Across every owner: Platform is one curated shared list, so two
    identical entries on it are a duplicate no matter who uploaded them."""
    q = db.query(Lut).filter(
        Lut.is_platform_wide.is_(True),
        Lut.content_hash == content_hash,
        Lut.deleted_at.is_(None),
    )
    if exclude_id is not None:
        q = q.filter(Lut.id != exclude_id)
    return q.first()


def _to_response(
    lut: Lut,
    current_user: User,
    owner_name: Optional[str] = None,
    shared_with_project: Optional[bool] = None,
    shared_project_ids: Optional[list] = None,
) -> LutResponse:
    return LutResponse(
        id=lut.id,
        name=lut.name,
        lut_size=lut.lut_size,
        created_at=lut.created_at,
        is_platform_wide=lut.is_platform_wide,
        group_id=lut.group_id,
        shared_project_ids=shared_project_ids or [],
        is_owner=lut.owner_id == current_user.id,
        owner_name=owner_name,
        # 5 years: the browser refetches this on every picker open, but a
        # short expiry would break a long editing session mid-preview.
        file_url=proxy_url_for(lut.s3_key, expires_hours=24 * 365 * 5),
        shared_with_project=shared_with_project,
    )


def _require_superadmin(current_user: User) -> None:
    if current_user.role != UserGlobalRole.superadmin:
        raise HTTPException(
            status_code=403,
            detail="Only superadmins can manage platform LUT groups",
        )


def _get_own_group(db: Session, group_id: uuid.UUID, current_user: User) -> LutGroup:
    """A personal group belonging to the caller. Platform groups are
    deliberately not reachable here -- they are shared, so ownership is the
    wrong question to ask about them (see _get_platform_group)."""
    group = db.query(LutGroup).filter(
        LutGroup.id == group_id,
        LutGroup.owner_id == current_user.id,
        LutGroup.is_platform.is_(False),
        LutGroup.deleted_at.is_(None),
    ).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def _validate_parent(db: Session, parent_id: uuid.UUID, is_platform: bool) -> LutGroup:
    """The Main group a new Sub group is being created under (§45).

    Exactly one level, and the cap is enforced here because Postgres cannot
    express "at most one level of self-reference" on a self-referential FK.
    """
    parent = db.query(LutGroup).filter(
        LutGroup.id == parent_id,
        LutGroup.deleted_at.is_(None),
    ).first()
    if not parent:
        raise HTTPException(status_code=404, detail="Parent group not found")
    if parent.parent_group_id is not None:
        raise HTTPException(
            status_code=400,
            detail="A sub-group cannot hold sub-groups of its own",
        )
    if parent.is_platform != is_platform:
        raise HTTPException(
            status_code=400,
            detail=(
                "A platform sub-group must sit under a platform group"
                if is_platform
                else "A personal sub-group must sit under one of your own groups"
            ),
        )
    return parent


def _get_platform_group(db: Session, group_id: uuid.UUID) -> LutGroup:
    """One shared platform group, whoever created it.

    No owner filter on purpose: §39's whole point is that every superadmin
    sees and edits the same set. The caller checks superadmin separately --
    reading one is allowed to anyone, changing it is not.
    """
    group = db.query(LutGroup).filter(
        LutGroup.id == group_id,
        LutGroup.is_platform.is_(True),
        LutGroup.deleted_at.is_(None),
    ).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def _group_for_assignment(db: Session, group_id: uuid.UUID, current_user: User) -> LutGroup:
    """The group a LUT is being filed into: the caller's own, or any
    platform group."""
    group = db.query(LutGroup).filter(
        LutGroup.id == group_id,
        LutGroup.deleted_at.is_(None),
    ).filter(
        (LutGroup.is_platform.is_(True)) | (LutGroup.owner_id == current_user.id),
    ).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


def _get_own_lut(db: Session, lut_id: uuid.UUID, current_user: User) -> Lut:
    lut = db.query(Lut).filter(
        Lut.id == lut_id,
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")
    return lut


# ─── Personal library ────────────────────────────────────────────────────────

@router.post("/me/luts", response_model=LutResponse, status_code=status.HTTP_201_CREATED)
async def upload_lut(
    file: UploadFile = File(...),
    name: Optional[str] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Upload a .cube into the caller's personal library.

    Proxied through this container rather than a presigned browser->S3 PUT,
    for the same mixed-content reason as avatar/logo upload (see
    users.py::upload_avatar).
    """
    body = await file.read()
    if len(body) > MAX_CUBE_BYTES:
        raise HTTPException(status_code=400, detail="LUT file too large (max 8MB)")
    try:
        text = body.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="LUT file must be UTF-8 text")

    lut_size = _parse_cube_size(text)

    content_hash = _content_hash(text)
    existing = _find_owner_duplicate(db, current_user.id, content_hash)
    if existing is not None:
        # Per-owner, not global: two different people owning the identical
        # file is fine and expected (§44). Names where it already lives,
        # because "duplicate rejected" leaves the user hunting for it.
        raise HTTPException(
            status_code=409,
            detail=f"You already have this LUT as {_describe(existing, db)}.",
        )

    display_name = (name or file.filename or "Untitled LUT").strip()
    if display_name.lower().endswith(".cube"):
        display_name = display_name[: -len(".cube")]
    display_name = display_name[:255] or "Untitled LUT"

    key = f"luts/{current_user.id}/{uuid.uuid4()}.cube"
    s3_service.put_object(key, body, content_type="text/plain", cache_control="max-age=86400")

    lut = Lut(
        owner_id=current_user.id,
        name=display_name,
        s3_key=key,
        lut_size=lut_size,
        content_hash=content_hash,
    )
    db.add(lut)
    db.commit()
    db.refresh(lut)
    return _to_response(lut, current_user)


@router.get("/me/luts", response_model=list[LutResponse])
def list_own_luts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    luts = db.query(Lut).filter(
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).order_by(Lut.created_at.desc()).all()

    # Current share state for all of them in one query, so the share popover
    # can render its per-project toggles without N requests.
    shares: dict = {}
    if luts:
        rows = db.query(ProjectLutShare).filter(
            ProjectLutShare.lut_id.in_([l.id for l in luts])
        ).all()
        for row in rows:
            shares.setdefault(row.lut_id, []).append(row.project_id)

    return [
        _to_response(lut, current_user, shared_project_ids=shares.get(lut.id, []))
        for lut in luts
    ]


@router.get("/luts/platform", response_model=list[LutResponse])
def list_platform_luts(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every platform-wide LUT, from any superadmin.

    Readable by any authenticated user: these are explicitly meant to be
    usable by everyone, and the Settings page pins them for all viewers
    (read-only for non-superadmins). Distinct from GET /me/luts, which only
    ever returns the caller's own -- a superadmin needs to see every other
    superadmin's platform LUTs here too, not just theirs.
    """
    rows = db.query(Lut, User).outerjoin(User, Lut.owner_id == User.id).filter(
        Lut.is_platform_wide.is_(True),
        Lut.deleted_at.is_(None),
    ).order_by(Lut.name).all()
    return [
        _to_response(lut, current_user, owner_name=owner.name if owner else None)
        for lut, owner in rows
    ]


# ─── Groups ──────────────────────────────────────────────────────────────────

@router.post("/me/lut-groups", response_model=LutGroupResponse, status_code=status.HTTP_201_CREATED)
def create_lut_group(
    body: LutGroupCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    name = (body.name or "").strip()[:255]
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")
    if body.parent_group_id is not None:
        parent = _validate_parent(db, body.parent_group_id, is_platform=False)
        # A personal sub-group has to sit under one of the caller's own.
        if parent.owner_id != current_user.id:
            raise HTTPException(status_code=404, detail="Parent group not found")
    group = LutGroup(
        owner_id=current_user.id,
        name=name,
        parent_group_id=body.parent_group_id,
    )
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


@router.get("/me/lut-groups", response_model=list[LutGroupResponse])
def list_lut_groups(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return db.query(LutGroup).filter(
        LutGroup.owner_id == current_user.id,
        # A superadmin's own platform groups belong in the platform listing,
        # not doubled into their personal library.
        LutGroup.is_platform.is_(False),
        LutGroup.deleted_at.is_(None),
    ).order_by(LutGroup.name).all()


@router.patch("/me/lut-groups/{group_id}", response_model=LutGroupResponse)
def rename_lut_group(
    group_id: uuid.UUID,
    body: LutGroupUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    group = _get_own_group(db, group_id, current_user)
    if body.name is not None:
        name = body.name.strip()[:255]
        if not name:
            raise HTTPException(status_code=400, detail="Group name is required")
        group.name = name
    db.commit()
    db.refresh(group)
    return group


@router.delete("/me/lut-groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lut_group(
    group_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete. Member LUTs are explicitly ungrouped rather than left
    pointing at a deleted row -- the FK's ON DELETE SET NULL only fires on a
    hard delete, which this deliberately isn't. Sub-groups are promoted to
    top level for the same reason (§45): they and their own LUTs survive."""
    group = _get_own_group(db, group_id, current_user)
    group.deleted_at = datetime.now(timezone.utc)
    db.query(Lut).filter(Lut.group_id == group.id).update(
        {"group_id": None}, synchronize_session=False
    )
    db.query(LutGroup).filter(LutGroup.parent_group_id == group.id).update(
        {"parent_group_id": None}, synchronize_session=False
    )
    db.commit()


# ─── Platform groups (§39) ───────────────────────────────────────────────────
#
# One shared set, not a private view per superadmin. Any superadmin creates,
# renames, deletes and files into them; every authenticated user can read
# them, matching GET /luts/platform, which is likewise readable by everyone
# and manageable by nobody else.


@router.get("/luts/platform-groups", response_model=list[LutGroupResponse])
def list_platform_lut_groups(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Every platform group, identically, for whoever asks.

    Deliberately unfiltered by owner: two superadmins organising the same
    shared list into contradictory sets of groups is the thing this design
    rejects.
    """
    return db.query(LutGroup).filter(
        LutGroup.is_platform.is_(True),
        LutGroup.deleted_at.is_(None),
    ).order_by(LutGroup.name).all()


@router.post(
    "/luts/platform-groups",
    response_model=LutGroupResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_platform_lut_group(
    body: LutGroupCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    name = (body.name or "").strip()[:255]
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")
    if body.parent_group_id is not None:
        _validate_parent(db, body.parent_group_id, is_platform=True)
    # owner_id records who created it; it is not who may change it.
    group = LutGroup(
        owner_id=current_user.id,
        name=name,
        is_platform=True,
        parent_group_id=body.parent_group_id,
    )
    db.add(group)
    db.commit()
    db.refresh(group)
    return group


@router.patch("/luts/platform-groups/{group_id}", response_model=LutGroupResponse)
def rename_platform_lut_group(
    group_id: uuid.UUID,
    body: LutGroupUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_superadmin(current_user)
    group = _get_platform_group(db, group_id)
    if body.name is not None:
        name = body.name.strip()[:255]
        if not name:
            raise HTTPException(status_code=400, detail="Group name is required")
        group.name = name
    db.commit()
    db.refresh(group)
    return group


@router.delete(
    "/luts/platform-groups/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def delete_platform_lut_group(
    group_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft delete, same shape as the personal one: members are explicitly
    ungrouped and sub-groups promoted to top level rather than left pointing
    at a deleted row, since the FK's ON DELETE SET NULL only fires on a hard
    delete."""
    _require_superadmin(current_user)
    group = _get_platform_group(db, group_id)
    group.deleted_at = datetime.now(timezone.utc)
    db.query(Lut).filter(Lut.group_id == group.id).update(
        {"group_id": None}, synchronize_session=False
    )
    db.query(LutGroup).filter(LutGroup.parent_group_id == group.id).update(
        {"parent_group_id": None}, synchronize_session=False
    )
    db.commit()


@router.patch("/me/luts/{lut_id}", response_model=LutResponse)
def update_lut(
    lut_id: uuid.UUID,
    body: LutUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Rename, move between groups, or toggle platform-wide.

    Name and group are owner-only. `is_platform_wide` is superadmin-only and
    checked here rather than relying on the UI hiding the control -- it
    grants a LUT read access across every project on the platform, so it
    cannot be a client-side-only restriction.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    fields_set = body.model_fields_set

    if "is_platform_wide" in fields_set and body.is_platform_wide is not None:
        if current_user.role != UserGlobalRole.superadmin:
            raise HTTPException(
                status_code=403,
                detail="Only superadmins can make a LUT platform-wide",
            )
        if body.is_platform_wide and not lut.is_platform_wide:
            # Checked on promotion as well as on upload (§44): this LUT
            # passed its per-owner check when it was uploaded, and can still
            # collide with another owner's copy that is already on the
            # platform list.
            clash = _find_platform_duplicate(db, lut.content_hash, exclude_id=lut.id) \
                if lut.content_hash else None
            if clash is not None:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "This LUT is already on the platform list as "
                        f"{_describe(clash, db)}."
                    ),
                )
        lut.is_platform_wide = body.is_platform_wide

    if "name" in fields_set and body.name is not None:
        name = body.name.strip()[:255]
        if not name:
            raise HTTPException(status_code=400, detail="LUT name is required")
        lut.name = name

    # Explicit null clears the group; not sending the field leaves it alone.
    if "group_id" in fields_set:
        if body.group_id is None:
            lut.group_id = None
        else:
            # The caller's own group, or any platform group (§39).
            group = _group_for_assignment(db, body.group_id, current_user)
            # A platform LUT belongs in a platform group and a personal LUT
            # in a personal one. Checked against the values this request is
            # leaving behind, so promoting and filing in one call is fine.
            if group.is_platform != lut.is_platform_wide:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "A platform-wide LUT can only go in a platform group"
                        if lut.is_platform_wide
                        else "A personal LUT can only go in one of your own groups"
                    ),
                )
            lut.group_id = body.group_id
    elif "is_platform_wide" in fields_set and lut.group_id is not None:
        # Promoting or demoting without saying anything about the group:
        # drop a group that the LUT no longer belongs in, rather than
        # leaving a pair the rule above would reject. This is the path the
        # Settings page's Platform button and its drag-to-promote take.
        existing = db.query(LutGroup).filter(LutGroup.id == lut.group_id).first()
        if existing is not None and existing.is_platform != lut.is_platform_wide:
            lut.group_id = None

    db.commit()
    db.refresh(lut)
    return _to_response(lut, current_user)


@router.delete("/me/luts/{lut_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_lut(
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Soft-delete, owner only.

    The ProjectLutShare rows are hard-deleted alongside: leaving them would
    keep a deleted LUT listed in every project it was shared into. Assets
    referencing it fall back to no grade via the FK's ON DELETE SET NULL —
    except that a soft delete doesn't trigger that, so applied_lut_id is
    cleared explicitly here.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    lut.deleted_at = datetime.now(timezone.utc)
    db.query(ProjectLutShare).filter(ProjectLutShare.lut_id == lut.id).delete(synchronize_session=False)
    db.query(Asset).filter(Asset.applied_lut_id == lut.id).update(
        {"applied_lut_id": None}, synchronize_session=False
    )
    db.commit()


# ─── Project sharing ─────────────────────────────────────────────────────────

@router.post("/projects/{project_id}/luts/{lut_id}/share", response_model=LutResponse)
def share_lut_to_project(
    project_id: uuid.UUID,
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Share one of your own LUTs into a project.

    Restricted to the LUT's owner (not any project admin): it's the owner's
    personal content being published, not the project's. The caller must
    also actually be on the project — viewer is enough, since sharing a LUT
    grants nothing beyond making a color transform readable.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    existing = db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == project_id,
        ProjectLutShare.lut_id == lut_id,
    ).first()
    if not existing:
        db.add(ProjectLutShare(project_id=project_id, lut_id=lut_id, shared_by=current_user.id))
        db.commit()

    return _to_response(lut, current_user, shared_with_project=True)


@router.delete("/projects/{project_id}/luts/{lut_id}/share", status_code=status.HTTP_204_NO_CONTENT)
def unshare_lut_from_project(
    project_id: uuid.UUID,
    lut_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Remove the share row only — never touches the underlying Lut.

    Any asset currently graded with this LUT has its applied_lut_id cleared,
    since the invariant "applied LUTs are project-visible" would otherwise
    break for everyone but the owner.
    """
    lut = _get_own_lut(db, lut_id, current_user)
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == project_id,
        ProjectLutShare.lut_id == lut_id,
    ).delete(synchronize_session=False)
    db.query(Asset).filter(
        Asset.project_id == project_id,
        Asset.applied_lut_id == lut.id,
    ).update({"applied_lut_id": None}, synchronize_session=False)
    db.commit()


@router.get("/projects/{project_id}/luts", response_model=list[LutResponse])
def list_project_luts(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What the in-player picker calls: the caller's own library plus every
    LUT shared into this project, de-duplicated."""
    require_project_role(db, project_id, current_user, ProjectRole.viewer)

    shared_rows = db.query(ProjectLutShare, Lut, User).join(
        Lut, ProjectLutShare.lut_id == Lut.id
    ).outerjoin(
        User, Lut.owner_id == User.id
    ).filter(
        ProjectLutShare.project_id == project_id,
        Lut.deleted_at.is_(None),
    ).all()

    own = db.query(Lut).filter(
        Lut.owner_id == current_user.id,
        Lut.deleted_at.is_(None),
    ).all()

    # Third branch: platform-wide LUTs are available in every project with
    # no ProjectLutShare row at all -- that is what "usable by every user in
    # every project" means. Reported as shared_with_project=True so the
    # picker groups them with the project's own LUTs rather than under
    # "preview only", and so they can be applied as an asset's grade.
    platform_rows = db.query(Lut, User).outerjoin(User, Lut.owner_id == User.id).filter(
        Lut.is_platform_wide.is_(True),
        Lut.deleted_at.is_(None),
    ).all()

    shared_ids = {lut.id for _, lut, _ in shared_rows}
    seen: set = set()
    out: list[LutResponse] = []

    for _, lut, owner in shared_rows:
        seen.add(lut.id)
        out.append(_to_response(
            lut, current_user,
            owner_name=owner.name if owner else None,
            shared_with_project=True,
        ))
    for lut, owner in platform_rows:
        if lut.id in seen:
            continue
        seen.add(lut.id)
        out.append(_to_response(
            lut, current_user,
            owner_name=owner.name if owner else None,
            shared_with_project=True,
        ))
    for lut in own:
        if lut.id in seen:
            continue  # already listed above
        out.append(_to_response(
            lut, current_user,
            owner_name=current_user.name,
            shared_with_project=False,
        ))
    out.sort(key=lambda r: r.name.lower())
    return out


# ─── Applying a LUT to an asset ──────────────────────────────────────────────

@router.put("/assets/{asset_id}/lut", response_model=Optional[LutResponse])
def apply_lut_to_asset(
    asset_id: uuid.UUID,
    body: ApplyLutRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Set (or clear, with lut_id=null) the grade the whole team sees.

    Requires the LUT to be shared into this asset's project — a personal,
    unshared LUT can be previewed locally all day, but writing it here would
    hand every teammate a reference they can't read.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)
    require_project_role(db, asset.project_id, current_user, ProjectRole.editor)

    if body.lut_id is None:
        asset.applied_lut_id = None
        db.commit()
        return None

    lut = db.query(Lut).filter(Lut.id == body.lut_id, Lut.deleted_at.is_(None)).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")

    # Platform-wide LUTs are visible in every project by definition, so they
    # satisfy the "everyone on the team can see it" requirement without any
    # ProjectLutShare row. Without this branch the apply step would reject
    # exactly the LUTs that are meant to work everywhere.
    is_shared = lut.is_platform_wide or db.query(ProjectLutShare).filter(
        ProjectLutShare.project_id == asset.project_id,
        ProjectLutShare.lut_id == lut.id,
    ).first() is not None
    if not is_shared:
        raise HTTPException(
            status_code=400,
            detail="Share this LUT into the project before applying it, so the rest of the team can see it too",
        )

    asset.applied_lut_id = lut.id
    db.commit()
    return _to_response(lut, current_user, shared_with_project=True)


# ─── Graded export ───────────────────────────────────────────────────────────

@router.post("/assets/{asset_id}/lut-export", response_model=LutExportResponse)
def request_lut_export(
    asset_id: uuid.UUID,
    version_id: Optional[uuid.UUID] = Query(default=None),
    lut_id: Optional[uuid.UUID] = Query(default=None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Kick off a one-off graded render.

    The result is deliberately temporary: it lands under `lut-exports/` and
    a delayed cleanup task deletes it an hour later. Only the original
    un-graded file is ever kept.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    if asset.asset_type != AssetType.video:
        raise HTTPException(status_code=400, detail="Graded export is only available for video assets")

    if version_id:
        version = db.query(AssetVersion).filter(
            AssetVersion.id == version_id,
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).first()
    else:
        version = db.query(AssetVersion).filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
        ).order_by(AssetVersion.version_number.desc()).first()
    if not version:
        raise HTTPException(status_code=404, detail="No version found")

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Media file not found")

    target_lut_id = lut_id or asset.applied_lut_id
    if not target_lut_id:
        raise HTTPException(status_code=400, detail="No LUT applied to this asset")

    lut = db.query(Lut).filter(Lut.id == target_lut_id, Lut.deleted_at.is_(None)).first()
    if not lut:
        raise HTTPException(status_code=404, detail="LUT not found")

    # Same visibility rule as applying: you may export with a LUT you own,
    # or one shared into this project.
    if lut.owner_id != current_user.id and not lut.is_platform_wide:
        is_shared = db.query(ProjectLutShare).filter(
            ProjectLutShare.project_id == asset.project_id,
            ProjectLutShare.lut_id == lut.id,
        ).first() is not None
        if not is_shared:
            raise HTTPException(status_code=403, detail="No access to this LUT")

    export_id = uuid.uuid4()

    from ..tasks.celery_app import send_task_safe
    from ..tasks.lut_tasks import burn_lut_export
    send_task_safe(
        burn_lut_export,
        str(asset.id), str(version.id), str(lut.id), str(export_id),
    )

    return LutExportResponse(
        export_id=export_id,
        asset_id=asset.id,
        version_id=version.id,
        lut_id=lut.id,
    )


@router.get("/assets/{asset_id}/lut-export/{export_id}", response_model=StreamUrlResponse)
def get_lut_export_url(
    asset_id: uuid.UUID,
    export_id: uuid.UUID,
    version_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Download URL for a finished graded export.

    Short token expiry (1h) matched to the export's own lifetime — there is
    no point handing out a URL that outlives the object it points at.
    """
    asset = db.query(Asset).filter(Asset.id == asset_id, Asset.deleted_at.is_(None)).first()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    require_asset_access(db, asset, current_user)

    export_key = f"lut-exports/{asset.project_id}/{asset_id}/{version_id}/{export_id}.mp4"
    filename = s3_service.build_download_filename(asset.name, export_key)
    return StreamUrlResponse(
        url=proxy_url_for(export_key, expires_hours=1, download_filename=filename),
        asset_type=asset.asset_type,
        expires_in=3600,
    )
