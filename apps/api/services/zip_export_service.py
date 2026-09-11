"""Selection resolution and cache keying for zip downloads (CLAUDE.md §143).

Pure functions, deliberately: the hard parts here — which variant an asset
actually gets, and whether two requests may share one archive — are exactly
the parts worth testing without a database, a worker or S3 in the way.

Nothing in this module re-derives a permission. `_available_variants` in
routers/share.py is the single place that decides what a link allows for an
asset, and this asks it rather than reimplementing the rule; a second copy
of a permission rule is how this codebase has repeatedly ended up with two
that disagree (§30, §32, §139).
"""
import hashlib
import json
import posixpath
from dataclasses import dataclass, field
from typing import Optional

from ..models.share import VARIANT_QUALITY, VARIANT_USES_LUT, DownloadVariant

#: Everything this feature writes lives under here. The delete task refuses
#: any key that does not start with it, mirroring delete_lut_export.
ZIP_PREFIX = "zip-exports/"

#: Three days, per the requirement. A build is also destroyed early when its
#: share link is deactivated or deleted — whichever comes first.
ZIP_TTL_SECONDS = 3 * 24 * 60 * 60


@dataclass
class ResolvedFile:
    """One file's fully-decided place in the archive."""

    asset_id: str
    version_id: str
    #: Path inside the zip, including folders. Never absolute, never "..".
    path: str
    #: The variant this file will actually be built as.
    variant: str
    #: Set when `variant` is not what the batch asked for, e.g. a LUT
    #: variant requested for an asset that has no LUT. Shown per file in the
    #: UI — a silent substitution hands someone a different file than the
    #: label promised, which is the thing §30 exists to prevent.
    fallback_reason: Optional[str] = None
    applied_lut_id: Optional[str] = None

    def key_tuple(self) -> list:
        # The LUT id is part of identity only when the variant burns one:
        # re-grading an asset changes a `*_lut` export's bytes without
        # changing its version, but leaves a plain export untouched.
        lut = self.applied_lut_id if VARIANT_USES_LUT.get(DownloadVariant(self.variant)) else None
        return [self.path, self.asset_id, self.version_id, self.variant, lut]


@dataclass
class ResolvedSelection:
    files: list[ResolvedFile] = field(default_factory=list)

    @property
    def has_fallbacks(self) -> bool:
        return any(f.fallback_reason for f in self.files)


def available_variants_for(allowed: list[str], asset) -> list[str]:
    """The permission rule, in one place (§30's single enforcement point).

    `routers/share.py::_available_variants` delegates here rather than
    keeping its own copy, and the authenticated zip route passes the full
    variant list as `allowed` because an in-app download is not gated by a
    share link. Same rule either way: a LUT variant is meaningless on an
    asset with no LUT and must not be offered.
    """
    has_lut = getattr(asset, "applied_lut_id", None) is not None
    return [v for v in (allowed or []) if has_lut or not VARIANT_USES_LUT[DownloadVariant(v)]]


def resolve_variant(
    requested: str,
    available: list[str],
    *,
    is_video: bool,
) -> tuple[str, Optional[str]]:
    """Pick the variant this asset will actually be exported as.

    Returns `(variant, fallback_reason)`; the reason is None when the
    request was honoured exactly.

    The brief's rule is "fall back to that asset's nearest available variant
    rather than failing the whole batch". Nearest is defined here, in order:

      1. the request itself, if available;
      2. the same quality rung without the LUT — the closest thing that
         still matches what was asked for in resolution terms;
      3. `raw`, if allowed at all;
      4. whatever remains, lowest-quality-first, so a fallback never
         silently upgrades someone to a bigger file than they asked for.

    Non-video never gets past step 3: proxies and LUT burns are ffmpeg
    renders, and `request_share_export` already refuses them for stills and
    audio. Asking for one here is not an error though — an image in a mixed
    folder should land in the zip as its original, not fail the batch.
    """
    if not available:
        return "", "this link does not allow downloads for this file"

    if requested in available and (is_video or not _needs_render(requested)):
        return requested, None

    if not is_video and _needs_render(requested):
        if DownloadVariant.raw.value in available:
            return DownloadVariant.raw.value, "not a video — using the original"
        chosen = _cheapest(available)
        return chosen, "not a video — using the original"

    # Same rung, no LUT.
    plain = _strip_lut(requested)
    if plain != requested and plain in available:
        return plain, "no LUT on this file — using plain"

    if DownloadVariant.raw.value in available:
        reason = (
            "no LUT on this file — using the original"
            if VARIANT_USES_LUT.get(DownloadVariant(requested), False)
            else "this quality is not available for this file — using the original"
        )
        return DownloadVariant.raw.value, reason

    chosen = _cheapest(available)
    return chosen, "the requested option is not available for this file"


def _needs_render(variant: str) -> bool:
    """True when producing this variant means running ffmpeg."""
    v = DownloadVariant(variant)
    return VARIANT_USES_LUT[v] or VARIANT_QUALITY[v] is not None


def _strip_lut(variant: str) -> str:
    v = DownloadVariant(variant)
    if not VARIANT_USES_LUT[v]:
        return variant
    return variant[: -len("_lut")]


def _cheapest(available: list[str]) -> str:
    order = {
        DownloadVariant.proxy_720p.value: 0,
        DownloadVariant.proxy_720p_lut.value: 1,
        DownloadVariant.proxy_1080p.value: 2,
        DownloadVariant.proxy_1080p_lut.value: 3,
        DownloadVariant.raw.value: 4,
        DownloadVariant.raw_lut.value: 5,
    }
    return sorted(available, key=lambda v: order.get(v, 99))[0]


def zip_entry_path(folder_path: list[str], filename: str, taken: set[str]) -> str:
    """Where a file sits inside the archive, folder tree preserved (§143.3).

    `folder_path` is the chain of folder names from the root of what is
    being downloaded, so the archive mirrors what the viewer sees rather
    than flattening it.

    Collisions get " (2)", " (3)" before the extension. Two files CAN
    legitimately land on the same path — the same name in the same folder at
    different versions — and overwriting one inside the zip would drop a
    file the user explicitly selected.
    """
    safe_parts = [_sanitize(p) for p in folder_path if _sanitize(p)]
    base = _sanitize(filename) or "file"
    candidate = posixpath.join(*safe_parts, base) if safe_parts else base

    if candidate not in taken:
        taken.add(candidate)
        return candidate

    stem, dot, ext = base.rpartition(".")
    if not dot:
        stem, ext = base, ""
    n = 2
    while True:
        alt_name = f"{stem} ({n}){'.' + ext if ext else ''}"
        alt = posixpath.join(*safe_parts, alt_name) if safe_parts else alt_name
        if alt not in taken:
            taken.add(alt)
            return alt
        n += 1


def _sanitize(part: str) -> str:
    """Strip anything that could escape the archive or break an extractor.

    A zip entry is just a string, so "../../etc/passwd" is a path the
    archive can genuinely carry — some extractors still honour it. Names
    come from user-supplied folder and asset names, so this is not
    hypothetical.
    """
    cleaned = (part or "").replace("\\", "/").strip()
    cleaned = cleaned.split("/")[-1]
    cleaned = cleaned.replace("\x00", "")
    if cleaned in {".", ".."}:
        return ""
    for ch in '<>:"|?*':
        cleaned = cleaned.replace(ch, "_")
    return cleaned.strip().strip(".")[:150]


def compute_cache_key(scope_id: str, selection: ResolvedSelection) -> str:
    """Identity of an archive's CONTENTS (§143.6).

    Two requests with equal keys are guaranteed to produce byte-identical
    archives, which is precisely the condition for reusing one.

    Sorted, so the order files were listed in does not matter — asking for
    A then B is the same download as B then A. Serialised through
    `json.dumps(..., sort_keys=True)` with explicit separators so the digest
    cannot drift with Python's dict ordering or whitespace defaults.

    INVALIDATION, stated plainly since "same selection" needs a precise
    definition: the key changes, and the archive is rebuilt, when any of
    these change — the scope (link/project+user), the SET of files, any
    file's version, any file's resolved variant, any file's path inside the
    zip (so a rename or a move invalidates), or the applied LUT of a file
    being exported with a LUT. Nothing else does. Editing an unrelated
    asset, re-titling the link, or another viewer requesting the same thing
    all reuse the existing build.
    """
    payload = {
        # str() because callers naturally pass a UUID (a link id, a user
        # id) and json.dumps refuses one — a crash at the exact moment a
        # download is requested.
        "scope": str(scope_id),
        "files": sorted(f.key_tuple() for f in selection.files),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def zip_object_key(project_id: str, scope_kind: str, scope_id: str, export_id: str) -> str:
    """`zip-exports/{project}/{link|user}/{scope}/{export}.zip`.

    Its own prefix, never mixed into `raw/` or `processed/` (§143.4), and
    scoped by owner so a link's archives can be listed and purged together
    when it is deactivated.
    """
    assert scope_kind in {"link", "user"}, scope_kind
    return f"{ZIP_PREFIX}{project_id}/{scope_kind}/{scope_id}/{export_id}.zip"


# ── Turning a request into a build plan ──────────────────────────────────────

def source_key_for(variant: str, media_file) -> tuple[Optional[str], bool]:
    """Which stored object backs this variant, and whether it needs a render.

    Returns `(s3_key, needs_render)`.

    **`needs_render=True` is currently unreachable from a zip build, by
    design.** Batch downloads only offer variants that already exist as
    stored objects (see `stored_variants_for`), so nothing a zip contains
    is produced by ffmpeg. The flag is kept rather than removed because it
    is the honest answer to the question this function asks, and because
    rendered batch downloads are a deferred scoping pass, not a rejected
    idea — the capability stays described here instead of having to be
    re-derived later. Single-file downloads are unaffected and still render
    on demand through burn_lut_export.

    `proxy_1080p` is the one rung that may already exist as a stored object:
    §57 persists a 1080p proxy for heavy sources, and reusing it is the
    whole point of having persisted it.
    """
    raw = getattr(media_file, "s3_key_raw", None)
    if variant == DownloadVariant.raw.value:
        return raw or getattr(media_file, "s3_key_processed", None), False
    if variant == DownloadVariant.proxy_1080p.value:
        persisted = getattr(media_file, "proxy_1080p_key", None)
        if persisted:
            return persisted, False
    return raw, True


def build_manifest_entry(
    resolved: ResolvedFile,
    media_file,
    asset_name: str,
) -> dict:
    """One row of the build plan, as stored on ZipExport.manifest.

    Written by the endpoint and consumed by the worker rather than
    recomputed there: it encodes permission decisions, and re-deriving those
    in a worker would be a second copy of a permission rule.
    """
    s3_key, needs_render = source_key_for(resolved.variant, media_file)
    return {
        "asset_id": resolved.asset_id,
        "version_id": resolved.version_id,
        "asset_name": asset_name,
        "path": resolved.path,
        "variant": resolved.variant,
        "fallback_reason": resolved.fallback_reason,
        "applied_lut_id": resolved.applied_lut_id,
        "s3_key": s3_key,
        "needs_render": needs_render,
    }


def stored_variants_for(allowed: list[str], asset, media_file) -> list[str]:
    """What a BATCH may offer for this asset: stored objects only (§143).

    Scope decision, 2026-09-11: a zip build triggers no ffmpeg. A batch of
    20 files asking for `raw_lut` would have meant 20 sequential renders
    before the archive landed, which is a concurrency and queueing design
    of its own; that is deferred to its own pass rather than smuggled in
    behind a download button.

    So this is `available_variants_for` — the permission rule — further
    narrowed to variants with a file already sitting in storage:

      * `raw` always qualifies (it is the upload).
      * `proxy_1080p` qualifies only when §57 persisted one for this file,
        which it does for heavy sources.
      * everything else needs ffmpeg and is therefore not offered.

    Note `proxy_720p` never qualifies TODAY: §57 persists a 1080p rung
    only, and the 720p rung exists purely as HLS segments, which are not a
    downloadable file. It is handled generically rather than special-cased
    so that persisting a 720p proxy later makes it available here with no
    change to this function.

    This does NOT touch single-file downloads: the per-item DownloadMenu
    still offers and renders every permitted variant.
    """
    permitted = available_variants_for(allowed, asset)
    out = []
    for v in permitted:
        key, needs_render = source_key_for(v, media_file)
        if key and not needs_render:
            out.append(v)
    return out


def batch_variant_options(
    allowed: list[str],
    per_asset: list[tuple],
) -> list[str]:
    """Which variants the batch picker offers for a whole selection.

    The UNION across the selection, not the intersection. One asset having
    a persisted proxy is a good reason to offer that option; the assets
    that lack it fall back per `resolve_variant` and say so per file, which
    is the behaviour the brief asks for. An intersection would hide a
    useful option whenever a single still image was in the folder.

    `per_asset` is a list of `(asset, media_file)` pairs.
    """
    seen: set[str] = set()
    for asset, media_file in per_asset:
        seen.update(stored_variants_for(allowed, asset, media_file))
    order = [v.value for v in DownloadVariant]
    return [v for v in order if v in seen]


def latest_ready_version(db, asset_id):
    """The version a file gets when the viewer has not chosen one (§143.1).

    Latest READY specifically, matching what the rest of the share surface
    treats as "the current version" — offering an in-flight upload in a
    download would hand back something with no file behind it.
    """
    from ..models.asset import AssetVersion, ProcessingStatus

    return (
        db.query(AssetVersion)
        .filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
        )
        .order_by(AssetVersion.version_number.desc())
        .first()
    )


def folder_chain(db, folder_id, stop_at):
    """Folder names from `stop_at` down to `folder_id`, for the zip path.

    `stop_at` is the root of what is being downloaded — a share link's
    folder, or the project root — so the archive mirrors what the viewer
    was looking at rather than the project's whole hierarchy.
    """
    from ..models.folder import Folder

    names: list[str] = []
    current = folder_id
    guard = 0
    while current and current != stop_at and guard < 64:
        f = db.query(Folder).filter(Folder.id == current).first()
        if not f:
            break
        names.append(f.name)
        current = f.parent_id
        guard += 1
    return list(reversed(names))


def selectable_versions(db, asset_id, *, allowed: bool):
    """Ready versions a viewer may choose between for one asset (§143.1).

    Returns [] when `allowed` is False — a link with `show_versions` off
    must not learn its assets even HAVE other versions through the
    download dialog, which would be a side channel around that setting.

    Also returns [] for a single version: there is no choice to make, and
    the UI hides the selector rather than showing a one-item dropdown.
    """
    from ..models.asset import AssetVersion, ProcessingStatus

    if not allowed:
        return []
    rows = (
        db.query(AssetVersion)
        .filter(
            AssetVersion.asset_id == asset_id,
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.ready,
        )
        .order_by(AssetVersion.version_number.desc())
        .all()
    )
    return rows if len(rows) > 1 else []


# ── Staleness (§146) ─────────────────────────────────────────────────────────

#: How long a build may sit without its file count advancing before it is
#: declared dead. Tied to the task's own hard limit with margin: Celery kills
#: the worker at ZIP_HARD_TIME_LIMIT, so anything still claiming to build
#: well past that is not running — it is a row nobody will ever update.
#:
#: Measured against PROGRESS, not age, on purpose. A large batch that is
#: genuinely still downloading keeps bumping `progress_at`, and must not be
#: failed for being slow; a wedged one stops bumping it immediately.
ZIP_STALE_AFTER_SECONDS = 25 * 60


def is_stale(export, *, now=None) -> bool:
    """True when a pending/building row cannot still be alive.

    A row with no `progress_at` yet is measured from `created_at` — a build
    that died before its first file is exactly the case worth catching.
    """
    from datetime import datetime, timedelta, timezone
    from ..models.zip_export import ZipExportStatus

    if export.status not in (ZipExportStatus.pending, ZipExportStatus.building):
        return False
    now = now or datetime.now(timezone.utc)
    last = export.progress_at or export.created_at
    if last is None:
        return False
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return (now - last) > timedelta(seconds=ZIP_STALE_AFTER_SECONDS)
