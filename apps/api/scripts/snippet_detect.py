"""Make clip suggestions for files that are already transcribed.

The same detection the transcription pipeline runs as its `detect` stage:
this script and tasks/transcribe_tasks.py both call
`run_detect_for_media_file`, so a run here cannot differ from a run there.
No model and no network -- the rules are in services/snippet_detect.py.

Use it when a file was transcribed before `detect` existed, or after the
window rules changed. A --dry-run lists every suggestion with its score
(0..1, stored as `quality_score`) and the reason codes behind it -- "+x"
raised the score, "-x" lowered it; services/snippet_detect.py names them.
To see what changed against the previous detector, without writing
anything, use scripts/snippet_detect_compare.py.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_detect \\
        --project-id <uuid> --dry-run

    docker-compose exec api python -m apps.api.scripts.snippet_detect \\
        --asset-id <uuid>

Only files that ALREADY have transcript segments are touched; a file with
no transcript is listed as skipped, because detection reads the stored
transcript and never starts a transcription. snippet_reprocess.py is the
script that transcribes.

What a run replaces is only `source='keyword'` AND `status='suggested'`
AND never edited by a person. Imported and hand-made rows, any keyword row
somebody approved or rejected, and any clip a person trimmed, retitled or
re-topiced are left exactly as they are, and no new suggestion is made that
overlaps one of them -- see tasks/transcribe_tasks.replaceable_snippets.
"""
import argparse
import sys
import uuid
from dataclasses import dataclass
from typing import Optional

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.snippet import Snippet, TranscriptSegment, media_file_is_hidden
from sqlalchemy import and_, not_

from apps.api.services.snippet_detect import detect_snippets, drop_overlapping

# The same no-traceback error type the other snippet scripts use.
from apps.api.scripts.snippet_set_track_speaker import ScriptError


@dataclass
class Target:
    asset_id: str
    asset_name: str
    media_file_id: Optional[str]
    segments: int
    run: bool
    reason: str


def _latest_live_version(db, asset_id):
    return (
        db.query(AssetVersion)
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .order_by(AssetVersion.version_number.desc())
        .first()
    )


def find_targets(db, project_id=None, asset_id=None) -> list:
    """Every live asset in scope, and whether detection will run on it.

    Soft-deleted assets are left out here, and `TranscriptSegment.live`
    leaves their transcripts out again when the segments are counted: that
    rule has one implementation and this is a caller of it.
    """
    query = db.query(Asset).filter(Asset.deleted_at.is_(None))
    if asset_id is not None:
        query = query.filter(Asset.id == asset_id)
    else:
        query = query.filter(Asset.project_id == project_id)
    assets = query.order_by(Asset.name).all()

    out = []
    for asset in assets:
        version = _latest_live_version(db, asset.id)
        media_file = (
            db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
            if version is not None else None
        )
        if media_file is None:
            out.append(Target(str(asset.id), asset.name, None, 0, False, "no media file"))
            continue
        if media_file_is_hidden(db, media_file.id):
            # The pipeline skips it too (run_detect_for_media_file): a hidden
            # file's clips stay as they are until it is unhidden.
            out.append(Target(str(asset.id), asset.name, str(media_file.id), 0, False,
                              "hidden from SocialSnippet"))
            continue
        segments = (
            TranscriptSegment.live(db)
            .filter(TranscriptSegment.media_file_id == media_file.id)
            .count()
        )
        if not segments:
            out.append(Target(str(asset.id), asset.name, str(media_file.id), 0, False,
                              "no transcript segments yet"))
            continue
        out.append(Target(str(asset.id), asset.name, str(media_file.id), segments, True,
                          "detect"))
    return out


def preview(db, media_file_id) -> dict:
    """What a run WOULD do, without writing anything.

    Reads the same words and runs the same detection as the real thing, then
    COUNTS the rows that would go instead of deleting them.
    """
    from apps.api.tasks.transcribe_tasks import replaceable_snippets, snippet_detect_input

    rows = detect_snippets(snippet_detect_input(db, media_file_id))
    removed = (
        db.query(Snippet)
        .filter(Snippet.media_file_id == media_file_id, *replaceable_snippets())
        .count()
    )
    kept = [
        {"start_ms": start, "end_ms": end}
        for start, end in db.query(Snippet.start_ms, Snippet.end_ms)
        .filter(Snippet.media_file_id == media_file_id, not_(and_(*replaceable_snippets())))
        .all()
    ]
    rows, skipped = drop_overlapping(rows, kept)
    return {"created": len(rows), "removed": removed, "kept": len(kept), "skipped": skipped,
            "rows": rows}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--project-id", type=uuid.UUID)
    target.add_argument("--asset-id", type=uuid.UUID)
    parser.add_argument("--dry-run", action="store_true", help="list only; change nothing")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        targets = find_targets(db, project_id=args.project_id, asset_id=args.asset_id)
        if not targets:
            print("No live assets found.")
            return 0

        from apps.api.tasks.transcribe_tasks import run_detect_for_media_file

        created = removed = failed = 0
        for item in targets:
            if not item.run:
                print(f"skip  {item.asset_id}  {item.asset_name}  ({item.reason})")
                continue
            if args.dry_run:
                result = preview(db, uuid.UUID(item.media_file_id))
                print(f"would {item.asset_id}  {item.asset_name}  "
                      f"{result['created']} suggestion(s), replacing {result['removed']}, "
                      f"{result['kept']} row(s) kept untouched, {result['skipped']} "
                      f"candidate(s) left out for overlapping a kept clip")
                for row in result["rows"]:
                    print(f"        {row['start_ms']:>8}-{row['end_ms']:<8} "
                          f"track {row['track_index']}  score {row['quality_score']:.3f}  "
                          f"{row['title']}")
                    print(f"            {' '.join(row.get('reasons') or [])}")
                created += result["created"]
                removed += result["removed"]
                continue
            try:
                result = run_detect_for_media_file(db, uuid.UUID(item.media_file_id))
            except Exception as exc:  # noqa: BLE001 -- one bad file must not stop the rest
                db.rollback()
                failed += 1
                print(f"FAIL  {item.asset_id}  {item.asset_name}  "
                      f"({type(exc).__name__}: {exc})", file=sys.stderr)
                continue
            created += result["created"]
            removed += result["removed"]
            print(f"ok    {item.asset_id}  {item.asset_name}  "
                  f"{result['created']} suggestion(s), {result['removed']} replaced")

        verb = "would create" if args.dry_run else "created"
        print(f"{verb} {created} suggestion(s), replacing {removed}"
              + (f"; {failed} file(s) failed" if failed else "")
              + (". Nothing written." if args.dry_run else "."))
        # A failed file is reported AND makes the run a failure overall, so a
        # caller in a shell script notices rather than reading the summary.
        return 1 if failed else 0
    except ScriptError as exc:
        db.rollback()
        print(f"error: {exc}", file=sys.stderr)
        return 2
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
