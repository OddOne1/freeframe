"""Bring clip suggestions in from a JSON file.

For clips that came from somewhere this codebase does not run: a model you
prompted by hand, a producer with a spreadsheet, another tool. Nothing here
calls a model or a network -- it reads a file you already have.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_import \\
        --media-file-id <uuid> --file /tmp/clips.json --dry-run

    docker-compose exec api python -m apps.api.scripts.snippet_import \\
        --media-file-id <uuid> --file /tmp/clips.json

The file::

    {"meta": {"generator": "claude"},
     "snippets": [{"start_ms": 12000, "end_ms": 31000,
                   "title": "Why the light matters",
                   "quote": "optional - filled from the transcript if absent",
                   "topics": ["light", "interview"],
                   "quality_score": 0.8, "viral_score": 0.4,
                   "speaker": "Anna Example"}]}

`meta.generator` is required and is stored on every row, so an imported
clip always says what produced it. Rows are written with
`source='import'`.

── What is checked, per item ──────────────────────────────────────────────
start before end; the span inside the file's transcript; at most eight
topics, all strings; scores between 0 and 1; and both times within 500 ms
of a real word boundary, to which they are then SNAPPED. An item that
fails any of those is refused with a reason naming the field, and the
others are still imported -- one bad row in a file of thirty should not
cost the other twenty-nine. A missing quote is filled from the transcript
between the snapped times.

── What is never touched ──────────────────────────────────────────────────
Importing only INSERTS. It deletes and updates nothing, so hand-made
(`source='manual'`) rows, generated ones, and anything already approved or
rejected all survive untouched. Running the same file twice therefore
imports it twice: that is deliberate -- which of two imports to keep is an
editorial decision, not one this script should make silently. Use
--dry-run first.
"""
import argparse
import json
import sys
import uuid

from sqlalchemy import func

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.snippet import Snippet, SnippetSpeaker, SnippetStatus
from apps.api.services.snippet_detect import ImportRefused, validate_import

from apps.api.scripts.snippet_set_track_speaker import ScriptError


def _project_of(db, media_file_id):
    """(media_file, asset). Raises ScriptError for a missing or trashed asset."""
    media_file = db.query(MediaFile).filter(MediaFile.id == media_file_id).first()
    if media_file is None:
        raise ScriptError(f"No media file {media_file_id}.")
    version = db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    asset = (
        db.query(Asset).filter(Asset.id == version.asset_id).first()
        if version is not None else None
    )
    if asset is None:
        raise ScriptError(f"Media file {media_file_id} has no asset.")
    if asset.deleted_at is not None:
        raise ScriptError(
            f"The asset of media file {media_file_id} ({asset.name!r}) is in the trash. "
            f"Restore it before importing clips for it."
        )
    return media_file, asset


def read_payload(path: str) -> dict:
    """The JSON file, as a dict. Raises ScriptError with the parse error."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise ScriptError(f"Could not read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ScriptError(f"{path} is not valid JSON: {exc}") from exc


def resolve_speakers(db, project_id, rows) -> dict:
    """{speaker name as given -> speaker_id}, for the names that exist.

    Case-insensitive, the same rule as everywhere else in SocialSnippet
    (models/snippet.py's unique index on project + lower(name)). A name
    that is not in the roster is NOT created here: inventing a speaker from
    an imported string would quietly populate the roster with a model's
    spelling mistakes. The row is stored with speaker_id NULL and the name
    is reported.
    """
    wanted = {row["speaker"] for row in rows if row.get("speaker")}
    if not wanted:
        return {}
    found = {}
    for name in sorted(wanted):
        speaker = (
            db.query(SnippetSpeaker)
            .filter(SnippetSpeaker.project_id == project_id,
                    func.lower(SnippetSpeaker.name) == name.lower())
            .first()
        )
        if speaker is not None:
            found[name] = speaker.id
    return found


def store_imported(db, media_file_id, rows, speaker_ids) -> int:
    """Insert every accepted row. Returns how many were written.

    Insert only -- see the module docstring on why nothing is replaced.
    """
    for row in rows:
        db.add(Snippet(
            id=uuid.uuid4(),
            media_file_id=media_file_id,
            speaker_id=speaker_ids.get(row.get("speaker")),
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            title=row["title"],
            quote=row.get("quote"),
            topics=list(row.get("topics") or []),
            quality_score=row.get("quality_score"),
            viral_score=row.get("viral_score"),
            status=SnippetStatus.suggested,
            source="import",
            generator=row["generator"],
        ))
    db.commit()
    return len(rows)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--media-file-id", required=True, type=uuid.UUID)
    parser.add_argument("--file", required=True, metavar="JSON",
                        help="the file to import")
    parser.add_argument("--dry-run", action="store_true",
                        help="check and report; import nothing")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        from apps.api.tasks.transcribe_tasks import snippet_words_by_track

        media_file, asset = _project_of(db, args.media_file_id)
        payload = read_payload(args.file)
        tracks = snippet_words_by_track(db, media_file.id)
        words_by_track = {track: data["words"] for track, data in tracks.items()}

        try:
            result = validate_import(payload, words_by_track)
        except ImportRefused as exc:
            raise ScriptError(f"{args.file}: {exc}") from exc

        accepted = result["accepted"]
        speaker_ids = resolve_speakers(db, asset.project_id, accepted)

        print(f"{asset.name!r}, media file {media_file.id}")
        print(f"  generator: {result['generator']}")
        for row in accepted:
            speaker = row.get("speaker")
            who = ""
            if speaker:
                who = (f"  speaker={speaker!r}" if speaker in speaker_ids
                       else f"  speaker={speaker!r} (not in the roster: stored unnamed)")
            print(f"  ok      {row['start_ms']:>8}-{row['end_ms']:<8} {row['title']}{who}")
        for refusal in result["refused"]:
            print(f"  refused item {refusal['index']}: {refusal['reason']}", file=sys.stderr)

        if args.dry_run:
            print(f"Dry run: {len(accepted)} would be imported "
                  f"({result['snapped']} with a time snapped to a word boundary), "
                  f"{len(result['refused'])} refused. Nothing written.")
            db.rollback()
        else:
            written = store_imported(db, media_file.id, accepted, speaker_ids)
            print(f"Imported {written} "
                  f"({result['snapped']} with a time snapped to a word boundary), "
                  f"{len(result['refused'])} refused.")

        # A refused item is a problem with the file the operator handed over,
        # so it shows in the exit code as well as in the summary.
        return 1 if result["refused"] else 0
    except ScriptError as exc:
        db.rollback()
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
