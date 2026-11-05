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
from dataclasses import dataclass
from typing import Callable, Optional

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus
from apps.api.models.snippet import SnippetJob


@dataclass
class Candidate:
    asset_id: str
    asset_name: str
    version_id: Optional[str]
    media_file_id: Optional[str]
    enqueue: bool
    reason: str


def _latest_live_version(db, asset_id):
    return (
        db.query(AssetVersion)
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .order_by(AssetVersion.version_number.desc())
        .first()
    )


def find_candidates(db, project_id=None, asset_id=None) -> list:
    """Every asset of the project (or the one asset), with what would happen to it."""
    from apps.api.tasks.transcribe_tasks import _edited_segment_count, _snippet_settings_for

    query = db.query(Asset).filter(Asset.deleted_at.is_(None))
    if asset_id is not None:
        query = query.filter(Asset.id == asset_id)
    else:
        query = query.filter(Asset.project_id == project_id)
    assets = query.order_by(Asset.name).all()

    out = []
    for asset in assets:
        def _skip(reason, version=None, media_file=None):
            out.append(Candidate(
                str(asset.id), asset.name,
                str(version.id) if version else None,
                str(media_file.id) if media_file else None,
                False, reason,
            ))

        if asset.asset_type not in (AssetType.video, AssetType.audio):
            _skip(f"not video or audio ({asset.asset_type.value})")
            continue
        if _snippet_settings_for(db, asset) is None:
            _skip("SocialSnippet is not enabled for this project, or the asset is outside its source folder")
            continue
        version = _latest_live_version(db, asset.id)
        media_file = (
            db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
            if version else None
        )
        if media_file is None:
            _skip("no media file", version)
            continue
        if not asset.transcription_enabled:
            _skip("transcription is turned off for this file", version, media_file)
            continue
        if media_file.transcription_status == TranscriptionStatus.processing:
            _skip("a transcription is already running", version, media_file)
            continue
        edited = _edited_segment_count(db, media_file.id)
        if edited:
            _skip(f"{edited} edited transcript segment(s); merging is not implemented yet",
                  version, media_file)
            continue
        out.append(Candidate(str(asset.id), asset.name, str(version.id), str(media_file.id),
                             True, "queue"))
    return out


def reprocess(db, candidates, enqueue: Callable) -> int:
    """Reset each candidate's stages and queue it. Returns how many were queued.

    `enqueue(asset_id, version_id)` returns the Celery result.
    """
    queued = 0
    for c in candidates:
        if not c.enqueue:
            continue
        media_file_id = uuid.UUID(c.media_file_id)
        db.query(SnippetJob).filter(SnippetJob.media_file_id == media_file_id) \
            .delete(synchronize_session=False)
        db.commit()
        result = enqueue(c.asset_id, c.version_id)
        # Same as the per-file toggle: the id makes the run revocable.
        media_file = db.query(MediaFile).filter(MediaFile.id == media_file_id).first()
        media_file.transcription_task_id = result.id
        media_file.transcription_status = TranscriptionStatus.processing
        media_file.transcription_progress = 0
        db.commit()
        queued += 1
    return queued


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
