"""Human-readable S3 key prefixes (CLAUDE.md §14).

Object keys used to be pure UUID:

    raw/{project_id}/{asset_id}/{version_id}/original.mov

which is unambiguous but tells you nothing when you are looking at a
bucket. New uploads use:

    raw/{YYMMDD}_{slug}_{project_id}/{asset_id}/{version_id}/original.mov

The trailing `project_id` is deliberate and load-bearing: it keeps the
prefix globally unique even if two projects somehow share a slug, and it
means **both formats end with the project id**, so nothing downstream has
to guess which one it is looking at.

──────────────────────────────────────────────────────────────────────────
BOTH FORMATS COEXIST, PERMANENTLY
──────────────────────────────────────────────────────────────────────────

Existing objects are NOT migrated. So a single project can hold both, and
so can a single *asset*: an asset uploaded before this shipped has an
old-format v1, and a new version uploaded afterwards gets a new-format v2.

Anything that needs an existing object's prefix must therefore read it
back off the stored key rather than recompute it — see
`project_prefix_of_key`. Recomputation is only correct for keys being
written right now, which is what `prefix_for_project` is for. Getting this
backwards is how the purge silently leaks storage (§12).
"""

from __future__ import annotations

import re
from datetime import date, datetime, timezone
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from ..models.project import Project

# Long enough to stay readable, short enough that the full prefix
# (6 + 1 + 40 + 1 + 36 = 84 chars) stays well inside S3's 1024-byte key
# limit alongside the asset/version ids and a filename.
MAX_SLUG_LENGTH = 40

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_SLUG_VALID = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")


class SlugUnavailable(ValueError):
    """A user-supplied slug is already taken by another project."""


class StorageLocked(ValueError):
    """The prefix was frozen by the project's first upload."""


def slugify(name: str) -> str:
    """Project name → a candidate slug.

    Everything that isn't [a-z0-9] collapses to a single underscore, so
    "Just Ride 2026 — B-Cam!" becomes "just_ride_2026_b_cam". Underscores
    throughout rather than hyphens: the user's call, on the grounds that
    they survive more tools intact and read more clearly in a key.
    """
    lowered = (name or "").strip().lower()
    slug = _SLUG_STRIP.sub("_", lowered).strip("_")
    slug = slug[:MAX_SLUG_LENGTH].strip("_")
    # A name made entirely of punctuation leaves nothing behind; the
    # project id in the prefix still disambiguates, so a generic stem is
    # better than failing an upload over an unusual name.
    return slug or "project"


def validate_slug(slug: str) -> str:
    """Check a user-supplied slug, returning it normalised.

    **Case is normalised, structure is not.** `Beach` becomes `beach`,
    because the field is lowercase by definition and nobody is surprised
    by that. But `Beach Shoot` is rejected rather than quietly becoming
    `beach_shoot` — that changes what they'll see in the bucket, and
    silently rewriting someone's deliberate input is how you get a slug
    nobody recognises. Surrounding whitespace is stripped as a typing
    convenience, not treated as structure.
    """
    candidate = (slug or "").strip().lower()
    if not candidate:
        raise ValueError("Storage slug cannot be empty")
    if len(candidate) > MAX_SLUG_LENGTH:
        raise ValueError(f"Storage slug must be at most {MAX_SLUG_LENGTH} characters")
    if not _SLUG_VALID.match(candidate):
        raise ValueError(
            "Storage slug may only contain lowercase letters, numbers and "
            "single underscores, and cannot start or end with an underscore"
        )
    return candidate


def _slug_taken(db: Session, slug: str, exclude_project_id=None) -> bool:
    q = db.query(Project.id).filter(Project.storage_slug == slug)
    if exclude_project_id is not None:
        q = q.filter(Project.id != exclude_project_id)
    return db.query(q.exists()).scalar()


def claim_user_slug(db: Session, project: Project, slug: str) -> str:
    """Validate + reserve a slug the user typed. Raises if taken.

    Auto-generated slugs de-duplicate silently (see `unique_slug_from_name`)
    because nobody should have an upload fail over a name collision they
    never saw. A slug someone typed by hand is the opposite: silently
    turning `beach` into `beach_2` would be worse than saying it's taken.
    """
    candidate = validate_slug(slug)
    if _slug_taken(db, candidate, exclude_project_id=project.id):
        raise SlugUnavailable(f"Storage slug '{candidate}' is already used by another project")
    return candidate


def unique_slug_from_name(db: Session, name: str, project_id) -> str:
    """Auto-generate a free slug from the project name.

    Collisions get a numeric suffix rather than an error: this runs inside
    the first upload, and failing an upload because an unrelated project
    has a similar name would be indefensible. The suffix is trimmed to fit
    the length cap rather than pushing past it.
    """
    base = slugify(name)
    if not _slug_taken(db, base, exclude_project_id=project_id):
        return base

    for n in range(2, 1000):
        suffix = f"_{n}"
        candidate = f"{base[:MAX_SLUG_LENGTH - len(suffix)].rstrip('_')}{suffix}"
        if not _slug_taken(db, candidate, exclude_project_id=project_id):
            return candidate

    # 998 projects sharing one name stem. The project id still makes the
    # prefix unique, so fall back rather than refusing to accept an upload.
    return f"{base[:MAX_SLUG_LENGTH - 9].rstrip('_')}_{str(project_id)[:8]}"


def is_locked(project: Project) -> bool:
    """Has the prefix been frozen?

    Keyed on the date, not the slug: the slug can legitimately be set by
    the user long before any upload, whereas the date is written only by
    `lock_storage_prefix`. So the date is the honest sentinel for "an
    object has been written under this prefix".
    """
    return project.storage_date_prefix is not None


def lock_storage_prefix(db: Session, project_id, now: Optional[datetime] = None) -> Project:
    """Freeze a project's prefix, and return the project.

    Called at upload *initiation* — the multipart-create — not completion.
    If the slug could still change while a multipart upload were in
    flight, that upload's key would reference a prefix that no longer
    matched anything, orphaning the object.

    **`with_for_update()` is the point of this function.** Two near-
    simultaneous first uploads to a brand-new project would otherwise both
    read `storage_slug IS NULL`, both generate a slug, and produce two
    different "locked" prefixes for one project. The row lock serialises
    them: the second waits, then sees the first's committed values and
    reuses them. On SQLite this is a no-op, which is harmless — it
    serialises writes anyway.

    Idempotent: once locked, it returns the existing values untouched.
    """
    project = (
        db.query(Project)
        .filter(Project.id == project_id)
        .with_for_update()
        .first()
    )
    if project is None:
        raise ValueError(f"Project {project_id} not found")

    if project.storage_slug is None:
        project.storage_slug = unique_slug_from_name(db, project.name, project.id)
    if project.storage_date_prefix is None:
        stamp = (now or datetime.now(timezone.utc)).date()
        project.storage_date_prefix = stamp.strftime("%y%m%d")

    db.flush()
    return project


# ── Building keys ────────────────────────────────────────────────────────

def prefix_for_project(project: Project) -> str:
    """The project-level path segment for keys being written NOW.

    Falls back to the bare project id when the project isn't locked, so
    this is safe to call before `lock_storage_prefix` — though every
    upload path should lock first, or the object lands under a prefix that
    the next upload won't share.
    """
    if project.storage_slug and project.storage_date_prefix:
        return f"{project.storage_date_prefix}_{project.storage_slug}_{project.id}"
    return str(project.id)


def project_prefix_of_key(key: Optional[str]) -> Optional[str]:
    """Recover the project-level segment from a stored key.

    `raw/240811_beach_<uuid>/<asset>/<version>/original.mov` →
    `240811_beach_<uuid>`. Works for either format, which is the whole
    point: deletion must follow what was actually written, not what would
    be written today.
    """
    if not key:
        return None
    parts = key.split("/")
    if len(parts) < 2 or parts[0] not in ("raw", "processed", "sidecars"):
        return None
    return parts[1] or None


def candidate_project_prefixes(project: Optional[Project], stored_keys: Iterable[Optional[str]]) -> list[str]:
    """Every project-level prefix an asset's objects might live under.

    Union of what the stored keys actually say and what this project would
    generate today. The computed ones are a safety net for assets whose
    rows were lost or never had a media file — listing a prefix that holds
    nothing is a cheap no-op, whereas missing one leaks storage silently,
    and that asymmetry is the entire lesson of §12.
    """
    found = {p for p in (project_prefix_of_key(k) for k in stored_keys) if p}
    if project is not None:
        found.add(str(project.id))
        if project.storage_slug and project.storage_date_prefix:
            found.add(prefix_for_project(project))
    return sorted(found)
