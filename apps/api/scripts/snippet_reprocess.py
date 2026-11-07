"""Re-run SocialSnippet transcription for one project or one asset.

For every asset in scope -- the project has SocialSnippet enabled and the
asset sits in its source folder or below -- this resets the file's
snippet_jobs stages (so nothing is resumed from an earlier run: tracks are
transcribed afresh, which is the point after changing the model, the gate
settings or the track-to-speaker mapping) and queues `transcribe_asset` for
the asset's newest version, exactly as the per-file transcription toggle
does.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.snippet_reprocess \\
        --project-id <uuid> --dry-run

    docker-compose exec api python -m apps.api.scripts.snippet_reprocess \\
        --asset-id <uuid>

`--dry-run` lists what would be queued and changes nothing. Without it,
the jobs are reset and the tasks queued.

Skipped, with the reason printed:
  * the project does not have SocialSnippet enabled, or the asset is outside
    the source folder (that asset takes the ordinary transcription path);
  * the file's latest version is not `ready` (still uploading, still being
    processed, or its processing failed);
  * transcription is turned off for the file;
  * a transcription is already running for it;
  * a person has edited its transcript -- the task would refuse it, because
    merging edits into a new transcription is not implemented yet.

Each run is one Whisper pass per audio track on the transcription worker,
which runs one job at a time: a project's worth is hours of queue.
"""
import argparse
import sys
import uuid

from apps.api.database import SessionLocal
# The scope and skip rules and the reset-then-queue are services/snippet_admin.py's,
# shared with POST /projects/{id}/snippet/process. Re-exported here under the
# names this script has always had.
from apps.api.services.snippet_admin import Candidate, find_candidates, reprocess  # noqa: F401


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--project-id", type=uuid.UUID)
    target.add_argument("--asset-id", type=uuid.UUID)
    parser.add_argument("--dry-run", action="store_true", help="list only; change nothing")
    args = parser.parse_args(argv)

    db = SessionLocal()
    try:
        candidates = find_candidates(db, project_id=args.project_id, asset_id=args.asset_id)
        if not candidates:
            print("No assets found.")
            return 0
        for c in candidates:
            mark = "QUEUE" if c.enqueue else "skip "
            detail = "" if c.enqueue else f"  ({c.reason})"
            print(f"{mark} {c.asset_id}  {c.asset_name}  version={c.version_id}{detail}")
        todo = sum(1 for c in candidates if c.enqueue)
        if args.dry_run:
            print(f"Dry run: {todo} would be queued, {len(candidates) - todo} skipped. Nothing changed.")
            return 0

        from apps.api.tasks.transcribe_tasks import transcribe_asset

        queued = reprocess(db, candidates, transcribe_asset.delay)
        print(f"Queued {queued}, skipped {len(candidates) - todo}.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
