"""Turn SocialSnippet on for a project, and find the ids its other scripts need.

There is no UI and no endpoint for `snippet_project_settings` yet, so this
script is the only way to configure a project. It also lists the project's
files with their media-file ids, which is what
snippet_set_track_speaker.py asks for.

Run on the server, from the repo root:

    # look, change nothing
    docker-compose exec api python -m apps.api.scripts.snippet_enable_project \\
        --project-name "Acme Interviews"

    # turn it on, scope it to a folder, name the people
    docker-compose exec api python -m apps.api.scripts.snippet_enable_project \\
        --project-name "Acme Interviews" --enable --folder-name "Rushes" \\
        --speaker "Anna Example" --speaker "Ben Example"

    # the ids snippet_set_track_speaker.py needs
    docker-compose exec api python -m apps.api.scripts.snippet_enable_project \\
        --project-name "Acme Interviews" --list-files

Settings are printed before and after every run, so a run that changes
nothing still shows what the project is set to. `--dry-run` prints the same
"after" column and writes nothing at all -- no settings row, no speaker.

── Naming things ──────────────────────────────────────────────────────────
`--project-name` and `--folder-name` are EXACT matches ignoring case, never
prefixes. Zero or more than one match is an error that lists what it found
and changes nothing: picking one for the operator is how the wrong
project's settings get written. Use `--project-id` / `--folder-id` to be
unambiguous.

`--folder-id` is checked against the project before it is used. A folder of
another project is refused rather than stored, because a source folder
outside the project puts every asset out of scope and silently transcribes
nothing.

── Scope ──────────────────────────────────────────────────────────────────
`--list-files` and the pipeline agree about what "inside the source folder"
means, because both ask `services/snippet_transcribe.folder_in_scope`.
Soft-deleted assets are left out; so is a soft-deleted project or folder,
which cannot be named here at all.

Nothing here reads or writes a .env file, and nothing it prints comes from
one: the database URL arrives through `apps.api.database`, and the only
values printed are the project's own settings, folder and asset names.
"""
import argparse
import sys
import uuid
from typing import Optional

from sqlalchemy import func, null

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.folder import Folder
from apps.api.models.project import Project
from apps.api.models.snippet import EXPORT_ASPECTS, SnippetProjectSettings, SnippetSpeaker
from apps.api.services.snippet_transcribe import folder_in_scope

# The case-insensitive "same speaker" rule and the no-traceback error type
# are imported, not copied: snippet_set_track_speaker.py creates speakers
# too, and two copies of that rule is how the two scripts come to disagree
# about whether "anna" and "Anna" are one person.
from apps.api.scripts.snippet_set_track_speaker import ScriptError, find_or_create_speaker

#: What `export_retention_days = NULL` means, spelled out for the operator:
#: the column is nullable and NULL is a real choice, not "unset".
FOREVER = "forever (never purged)"

#: How many near-misses to list when a name matches nothing.
SUGGEST_LIMIT = 20


# ── Finding the project and the folder ─────────────────────────────────────


def _clean(text: Optional[str]) -> str:
    return " ".join((text or "").split())


def resolve_project(db, project_id=None, project_name=None) -> Project:
    """The one live project named, or a ScriptError listing the candidates."""
    if project_id is not None:
        project = (
            db.query(Project)
            .filter(Project.id == project_id, Project.deleted_at.is_(None))
            .first()
        )
        if project is None:
            raise ScriptError(f"No live project {project_id}.")
        return project

    wanted = _clean(project_name)
    if not wanted:
        raise ScriptError("--project-name must not be empty.")
    matches = (
        db.query(Project)
        .filter(func.lower(Project.name) == wanted.lower(), Project.deleted_at.is_(None))
        .order_by(Project.name, Project.created_at)
        .all()
    )
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ScriptError(
            f"{len(matches)} live projects are named {wanted!r}. "
            f"Use --project-id with one of:\n" + _project_lines(matches)
        )

    near = (
        db.query(Project)
        .filter(Project.name.ilike(f"%{wanted}%"), Project.deleted_at.is_(None))
        .order_by(Project.name)
        .limit(SUGGEST_LIMIT)
        .all()
    )
    hint = ("\nProjects whose name contains it:\n" + _project_lines(near)) if near else ""
    raise ScriptError(f"No live project is named exactly {wanted!r} (ignoring case).{hint}")


def _project_lines(projects) -> str:
    return "\n".join(f"  {p.id}  {p.name}  (created {p.created_at})" for p in projects)


def folder_path(db, folder: Folder, max_depth: int = 256) -> str:
    """"src/nested", for telling two same-named folders apart.

    Bounded like folder_in_scope, so a corrupt parent cycle prints a marker
    instead of hanging the operator's terminal.
    """
    names = [folder.name]
    seen = {folder.id}
    current = folder.parent_id
    for _ in range(max_depth):
        if current is None:
            return "/".join(reversed(names))
        if current in seen:
            break
        seen.add(current)
        parent = db.query(Folder).filter(Folder.id == current).first()
        if parent is None:
            break
        names.append(parent.name)
        current = parent.parent_id
    return "/".join(reversed(names)) + " (unresolved parent)"


def resolve_folder(db, project: Project, folder_id=None, folder_name=None) -> Folder:
    """The one live folder of THIS project named, or a ScriptError."""
    if folder_id is not None:
        folder = db.query(Folder).filter(Folder.id == folder_id).first()
        if folder is None:
            raise ScriptError(f"No folder {folder_id}.")
        if folder.project_id != project.id:
            raise ScriptError(
                f"Folder {folder_id} belongs to project {folder.project_id}, "
                f"not to {project.name!r} ({project.id}). A source folder outside "
                f"the project would put every asset out of scope."
            )
        if folder.deleted_at is not None:
            raise ScriptError(f"Folder {folder_id} ({folder.name!r}) is in the trash.")
        return folder

    wanted = _clean(folder_name)
    if not wanted:
        raise ScriptError("--folder-name must not be empty.")
    matches = (
        db.query(Folder)
        .filter(Folder.project_id == project.id,
                func.lower(Folder.name) == wanted.lower(),
                Folder.deleted_at.is_(None))
        .order_by(Folder.name)
        .all()
    )
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise ScriptError(
            f"{len(matches)} folders in {project.name!r} are named {wanted!r}. "
            f"Use --folder-id with one of:\n" + _folder_lines(db, matches)
        )

    near = (
        db.query(Folder)
        .filter(Folder.project_id == project.id,
                Folder.name.ilike(f"%{wanted}%"),
                Folder.deleted_at.is_(None))
        .order_by(Folder.name)
        .limit(SUGGEST_LIMIT)
        .all()
    )
    hint = ("\nFolders whose name contains it:\n" + _folder_lines(db, near)) if near else ""
    raise ScriptError(
        f"No live folder in {project.name!r} is named exactly {wanted!r} "
        f"(ignoring case).{hint}"
    )


def _folder_lines(db, folders) -> str:
    return "\n".join(f"  {f.id}  {folder_path(db, f)}" for f in folders)


# ── Settings ───────────────────────────────────────────────────────────────


def _describe(db, values: dict) -> dict:
    """The settings as the operator reads them, folder id resolved to a path."""
    out = dict(values)
    folder_id = out.get("source_folder_id")
    if folder_id is None:
        out["source_folder"] = "(whole project)"
    else:
        folder = db.query(Folder).filter(Folder.id == folder_id).first()
        out["source_folder"] = (
            f"{folder_path(db, folder)}  ({folder_id})" if folder is not None
            else f"(missing folder {folder_id})"
        )
    days = out.get("export_retention_days")
    out["export_retention"] = FOREVER if days is None else f"{days} day(s)"
    return out


#: Field -> how it is printed, in the order it is printed.
_SHOWN = (
    ("enabled", "Enabled"),
    ("source_folder", "Source folder"),
    ("export_retention", "Export retention"),
    ("export_aspect", "Export aspect"),
    ("caption_font", "Caption font"),
)


def current_values(row: Optional[SnippetProjectSettings]) -> dict:
    """The row's values, or what a new row would start as.

    The defaults repeat the model's `default=`, because with no row the
    reader still has to be told what the project behaves as: no row is the
    same as disabled with everything else at its default.
    """
    if row is None:
        return {
            "exists": False,
            "enabled": False,
            "source_folder_id": None,
            "export_retention_days": 30,
            "export_aspect": "9:16",
            "caption_font": None,
        }
    return {
        "exists": True,
        "enabled": row.enabled,
        "source_folder_id": row.source_folder_id,
        "export_retention_days": row.export_retention_days,
        "export_aspect": row.export_aspect,
        "caption_font": row.caption_font,
    }


def plan_changes(db, project: Project, args) -> tuple:
    """(before, after) values. Reads only -- nothing is written or added.

    Separated from the write so --dry-run runs exactly the same resolution
    and validation, including the folder-belongs-to-the-project check, and
    still cannot leave a settings row behind.
    """
    row = (
        db.query(SnippetProjectSettings)
        .filter(SnippetProjectSettings.project_id == project.id)
        .first()
    )
    before = current_values(row)
    after = dict(before)

    if args.enable:
        after["enabled"] = True
    elif args.disable:
        after["enabled"] = False

    if args.clear_folder:
        after["source_folder_id"] = None
    elif args.folder_id is not None or args.folder_name is not None:
        after["source_folder_id"] = resolve_folder(
            db, project, args.folder_id, args.folder_name
        ).id

    if args.retention_forever:
        after["export_retention_days"] = None
    elif args.retention_days is not None:
        if args.retention_days < 1:
            raise ScriptError(
                "--retention-days must be 1 or more; use --retention-forever to keep "
                "exports indefinitely."
            )
        after["export_retention_days"] = args.retention_days

    if args.export_aspect is not None:
        after["export_aspect"] = args.export_aspect

    if args.caption_font is not None:
        font = _clean(args.caption_font)
        if len(font) > 255:
            raise ScriptError("--caption-font is longer than 255 characters.")
        after["caption_font"] = font or None

    return before, after


def requests_settings_write(args) -> bool:
    """Did the operator ask for a settings change at all?

    This, and NOT "does any value differ", decides whether the row is
    upserted. Two different runs are being told apart:

      * no mutating flag -- a READ. `--project-name X` on its own, with or
        without `--list-files`, must leave an unconfigured project
        unconfigured; otherwise merely looking at one creates its row.
      * a mutating flag whose value happens to equal what is already in
        effect -- still a write. `--export-aspect 9:16` on a project with no
        row asked for a stored setting, and 9:16 being the default is not a
        reason to store nothing.

    `--speaker` is not here: the roster is written on its own, and naming a
    speaker is not a reason to materialise a settings row.
    """
    return any((
        args.enable,
        args.disable,
        args.clear_folder,
        args.folder_id is not None,
        args.folder_name is not None,
        args.retention_days is not None,
        args.retention_forever,
        args.export_aspect is not None,
        args.caption_font is not None,
    ))


def _explicit(value):
    """A None that survives the column's `default=`.

    SQLAlchemy treats an attribute set to None as "no value given" and falls
    back to the column default, so `row.export_retention_days = None` on a
    new row stores 30 -- the model's default -- instead of NULL, and
    --retention-forever would silently do nothing. `null()` is how you ask
    for NULL and mean it. Applied to every field so the next nullable column
    to gain a default does not re-introduce this.
    """
    return null() if value is None else value


def write_settings(db, project: Project, after: dict) -> bool:
    """Upsert the row to `after`. Returns True when a row was created."""
    row = (
        db.query(SnippetProjectSettings)
        .filter(SnippetProjectSettings.project_id == project.id)
        .first()
    )
    created = row is None
    if created:
        row = SnippetProjectSettings(project_id=project.id)
        db.add(row)
    row.enabled = after["enabled"]
    row.source_folder_id = _explicit(after["source_folder_id"])
    row.export_retention_days = _explicit(after["export_retention_days"])
    row.export_aspect = after["export_aspect"]
    row.caption_font = _explicit(after["caption_font"])
    return created


def add_speakers(db, project: Project, names, dry_run: bool) -> list:
    """[(name, created)] for each --speaker, de-duplicated ignoring case.

    With dry_run nothing is inserted: an existing speaker is reported as
    existing, a new one as "would create".
    """
    out = []
    for raw in names or []:
        clean = _clean(raw)
        if not clean:
            raise ScriptError("--speaker must not be empty.")
        if len(clean) > 255:
            raise ScriptError(f"--speaker {clean[:40]!r}... is longer than 255 characters.")
        existing = (
            db.query(SnippetSpeaker)
            .filter(SnippetSpeaker.project_id == project.id,
                    func.lower(SnippetSpeaker.name) == clean.lower())
            .first()
        )
        if existing is not None:
            # Reported under the STORED spelling, not the one typed: that is
            # the name the transcript will carry.
            out.append((existing.name, False))
            continue
        if dry_run:
            out.append((clean, True))
            continue
        speaker, created = find_or_create_speaker(db, project.id, clean)
        out.append((speaker.name, created))
    return out


# ── Listing files ──────────────────────────────────────────────────────────


def _latest_live_version(db, asset_id):
    """The newest version that is not in the trash.

    Mirrors snippet_reprocess.py's own helper; that one is private to it, so
    it is not imported across scripts.
    """
    return (
        db.query(AssetVersion)
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .order_by(AssetVersion.version_number.desc())
        .first()
    )


def list_files(db, project: Project, source_folder_id) -> list:
    """Every live asset in scope, with the ids the other scripts need.

    Scope is decided by `folder_in_scope`, the same function the task uses,
    so this listing cannot disagree with what a run would pick up.
    """
    parents = {}

    def _parent_of(folder_id):
        if folder_id not in parents:
            folder = db.query(Folder).filter(Folder.id == folder_id).first()
            parents[folder_id] = folder.parent_id if folder is not None else None
        return parents[folder_id]

    assets = (
        db.query(Asset)
        .filter(Asset.project_id == project.id, Asset.deleted_at.is_(None))
        .order_by(Asset.name)
        .all()
    )

    out = []
    for asset in assets:
        if not folder_in_scope(asset.folder_id, source_folder_id, _parent_of):
            continue
        version = _latest_live_version(db, asset.id)
        media_file = (
            db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
            if version is not None else None
        )
        folder = (
            db.query(Folder).filter(Folder.id == asset.folder_id).first()
            if asset.folder_id is not None else None
        )
        out.append({
            "asset_id": str(asset.id),
            "asset_name": asset.name,
            "folder": folder_path(db, folder) if folder is not None else "(root)",
            "media_file_id": str(media_file.id) if media_file is not None else None,
            # The media file's own type where there is one, else the asset's:
            # an image asset has no transcription status to report.
            "media_type": (media_file.file_type.value if media_file is not None
                           else asset.asset_type.value),
            "transcription_status": (media_file.transcription_status.value
                                     if media_file is not None else None),
            "transcription_enabled": asset.transcription_enabled,
        })
    return out


# ── Printing ───────────────────────────────────────────────────────────────


def print_settings(db, project: Project, before: dict, after: dict) -> None:
    shown_before = _describe(db, before)
    shown_after = _describe(db, after)
    existed = "" if before["exists"] else "  (no settings row yet)"
    print(f"Project {project.name!r} ({project.id}){existed}")
    width = max(len(label) for _, label in _SHOWN)
    for key, label in _SHOWN:
        was, now = shown_before.get(key), shown_after.get(key)
        mark = "   " if was == now else "-> "
        value = now if was == now else f"{was}  ->  {now}"
        print(f"  {mark}{label:<{width}}  {value}")


def print_speakers(results, dry_run: bool) -> None:
    verb = "would create" if dry_run else "created"
    for name, created in results:
        print(f"  speaker {name!r}: {verb if created else 'already in the roster'}")


def print_files(rows, source_folder_id) -> None:
    where = "the whole project" if source_folder_id is None else f"folder {source_folder_id}"
    if not rows:
        print(f"No live assets in {where}.")
        return
    print(f"{len(rows)} live asset(s) in {where}:")
    for r in rows:
        media = r["media_file_id"] or "(no media file)"
        status = r["transcription_status"] or "-"
        off = "" if r["transcription_enabled"] else "  [transcription off]"
        print(f"  {r['asset_id']}  {media}  {r['media_type']:<6} {status:<12} "
              f"{r['asset_name']}  [{r['folder']}]{off}")


# ── Entry point ────────────────────────────────────────────────────────────


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])

    which = parser.add_mutually_exclusive_group(required=True)
    which.add_argument("--project-id", type=uuid.UUID)
    which.add_argument("--project-name", help="exact match, ignoring case")

    onoff = parser.add_mutually_exclusive_group()
    onoff.add_argument("--enable", action="store_true", help="turn SocialSnippet on")
    onoff.add_argument("--disable", action="store_true", help="turn it off")

    folder = parser.add_mutually_exclusive_group()
    folder.add_argument("--folder-id", type=uuid.UUID, help="source folder, by id")
    folder.add_argument("--folder-name", help="source folder, exact match ignoring case")
    folder.add_argument("--clear-folder", action="store_true",
                        help="no source folder: the whole project is in scope")

    retention = parser.add_mutually_exclusive_group()
    retention.add_argument("--retention-days", type=int, metavar="N",
                           help="delete exports after N days")
    retention.add_argument("--retention-forever", action="store_true",
                           help="keep exports indefinitely (NULL)")

    parser.add_argument("--export-aspect", choices=list(EXPORT_ASPECTS))
    parser.add_argument("--caption-font")
    parser.add_argument("--speaker", action="append", metavar="NAME",
                        help="add to the project's speaker roster; repeatable")
    parser.add_argument("--list-files", action="store_true",
                        help="list live assets in scope with their media-file ids")
    parser.add_argument("--dry-run", action="store_true", help="print only; change nothing")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        project = resolve_project(db, args.project_id, args.project_name)
        before, after = plan_changes(db, project, args)
        speakers = add_speakers(db, project, args.speaker, args.dry_run)

        changed = {k: v for k, v in after.items() if k != "exists" and before[k] != v}
        new_speakers = sum(1 for _, created in speakers if created)
        writing = requests_settings_write(args)

        if args.dry_run:
            print_settings(db, project, before, after)
            print_speakers(speakers, True)
            # Nothing was added, but a rollback is still the honest end to a
            # run that promised to change nothing.
            db.rollback()
            if writing and not before["exists"]:
                print("  (the settings row would be created)")
            print(f"Dry run: {len(changed)} setting(s) and {new_speakers} speaker(s) "
                  f"would change. Nothing written.")
        else:
            created = write_settings(db, project, after) if writing else False
            db.commit()
            print_settings(db, project, before, after)
            print_speakers(speakers, False)
            if created:
                print("  (settings row created)")
            elif not changed and not new_speakers:
                print("  nothing to change")

        if args.list_files:
            print()
            print_files(list_files(db, project, after["source_folder_id"]),
                        after["source_folder_id"])
        return 0
    except ScriptError as exc:
        db.rollback()
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
