"""Re-queue process_asset for the `failed` versions of ONE project.

Written for the clean-up after the short-clip thumbnail bug: a clip under
5 s failed its thumbnail at step 5 of the transcode -- AFTER the HLS ladder
had been encoded and uploaded -- which marked the version `failed` and made
Celery retry the whole transcode until it gave up. Those versions are now
transcodable and nothing will pick them up on its own: `process_asset` is
only ever dispatched by an upload completing.

Deliberately a script and not a Celery task. It is a one-off that re-runs
other people's work on a whole project, so it wants a dry run, an operator
reading the list, and no schedule of its own.

ONE PROJECT at a time, required, by design. "Everything that ever failed"
is not a safe default: a `failed` version can also be a genuinely broken
upload, and re-queueing a library's worth of them means hours of worker
time nobody asked for.

A version is re-queued only when ALL THREE hold:

  * `processing_status` is `failed` (and the asset and version are not
    deleted);
  * its raw object EXISTS at the store, by `head_object`. There is nothing
    to transcode otherwise, and a re-queue would fail the same way again
    while occupying a worker;
  * it is NOT part of an open multipart upload. A key with parts still
    arriving is a LIVE upload, not finished work -- §213/§215 own that
    lifecycle, and transcoding a key mid-assembly would read a partial
    object.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.requeue_failed_versions \\
        --project-id <uuid>

That is a DRY RUN -- it lists and dispatches nothing. `--requeue` is the
only thing that changes it:

    docker-compose exec api python -m apps.api.scripts.requeue_failed_versions \\
        --project-id <uuid> --requeue

    --limit N      dispatch at most N (the dry run still lists everything)
    --project-id   required; accepts the id only, not a name

This script writes NOTHING to the database in either mode. `failed` is
already a re-runnable state -- process_asset's idempotency guard skips only
`ready` -- and the task sets `processing` itself on each attempt, so there
is no status to reset here and no half-applied state if it is interrupted.
"""
import argparse
import logging
import sys
import uuid

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from apps.api.models.project import Project
from apps.api.services.s3_service import (
    IncompleteListingError,
    list_multipart_uploads_all,
    object_exists,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("requeue_failed_versions")

#: The same boundary §215's sweep uses. Originals live under `raw/`;
#: everything else in the bucket is a derivative, not an upload session.
RAW_PREFIX = "raw/"

#: Why a candidate was not re-queued. Printed as its own section each, so a
#: dry run separates "nothing to transcode" from "still arriving" from
#: "the store would not say" -- three quite different things to do next.
SKIP_NO_MEDIA_FILE = "no media_files row"
SKIP_NO_RAW_KEY = "media_files row has no s3_key_raw"
SKIP_OBJECT_MISSING = "raw object is not at the store"
SKIP_UPLOAD_OPEN = "an open multipart upload still holds this key"
SKIP_STORE_ERROR = "the store would not answer"


def _candidates(db, project_id: uuid.UUID):
    """Every live `failed` version of this project, oldest first."""
    return (
        db.query(AssetVersion, Asset)
        .join(Asset, Asset.id == AssetVersion.asset_id)
        .filter(
            Asset.project_id == project_id,
            Asset.deleted_at.is_(None),
            AssetVersion.deleted_at.is_(None),
            AssetVersion.processing_status == ProcessingStatus.failed,
        )
        .order_by(AssetVersion.created_at)
        .all()
    )


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--project-id", required=True,
                    help="the project whose failed versions to consider")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True,
                      help="list only, dispatch nothing (the default)")
    mode.add_argument("--requeue", action="store_true",
                      help="actually dispatch process_asset for each eligible version")
    ap.add_argument("--limit", type=int, default=None,
                    help="dispatch at most N (the listing is unaffected)")
    args = ap.parse_args(argv)

    try:
        project_id = uuid.UUID(args.project_id)
    except ValueError:
        logger.error("--project-id is not a uuid: %r", args.project_id)
        return 2

    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            logger.error("no project %s", project_id)
            return 2

        rows = _candidates(db, project_id)
        logger.info(
            "project %s (%s): %d failed version(s). Mode: %s",
            project_id, project.name, len(rows),
            "REQUEUE" if args.requeue else "DRY RUN",
        )
        if not rows:
            return 0

        # ONE listing for the whole run, not one call per candidate: a
        # project's worth of ListMultipartUploads calls against the shared
        # AIStor endpoint is real traffic, and the answer is the same for
        # every row.
        #
        # An IncompleteListingError ABORTS. §215a's reasoning applies with
        # the sign flipped: a key missing from a short listing reads here as
        # "no upload is open", which would let this script transcode a key
        # whose parts are still arriving.
        try:
            open_upload_keys = {u["Key"] for u in list_multipart_uploads_all(RAW_PREFIX)}
        except IncompleteListingError as exc:
            logger.error(
                "could not list open multipart uploads in full, so a live "
                "upload could not be told apart from a finished one. Nothing "
                "was dispatched; re-run. (%s)", exc,
            )
            return 2
        logger.info("%d open multipart upload(s) under %s", len(open_upload_keys), RAW_PREFIX)

        eligible: list[tuple[AssetVersion, Asset, MediaFile]] = []
        skipped: list[tuple[AssetVersion, Asset, str, str]] = []

        for version, asset in rows:
            mf = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
            if mf is None:
                skipped.append((version, asset, SKIP_NO_MEDIA_FILE, ""))
                continue
            if not mf.s3_key_raw:
                skipped.append((version, asset, SKIP_NO_RAW_KEY, ""))
                continue
            if mf.s3_key_raw in open_upload_keys:
                skipped.append((version, asset, SKIP_UPLOAD_OPEN, mf.s3_key_raw))
                continue
            try:
                exists = object_exists(mf.s3_key_raw)
            except Exception as exc:  # noqa: BLE001
                # object_exists raises on anything that is not a clean 404,
                # deliberately. "The store did not answer" must not be
                # flattened into "the file is gone" and silently dropped
                # from the list an operator is about to act on.
                skipped.append((version, asset, SKIP_STORE_ERROR, f"{mf.s3_key_raw}: {exc}"))
                continue
            if not exists:
                skipped.append((version, asset, SKIP_OBJECT_MISSING, mf.s3_key_raw))
                continue
            eligible.append((version, asset, mf))

        line = "─" * 72
        print()
        print(line)
        print(f"  Failed versions, project {project_id}"
              f"{'' if args.requeue else '   (DRY RUN — nothing dispatched)'}")
        print(line)
        print(f"  eligible to re-queue        {len(eligible)}")
        print(f"  skipped                     {len(skipped)}")
        if args.limit and len(eligible) > args.limit:
            print(f"  --limit                     dispatching only the first {args.limit}")
        print()
        if eligible:
            print("  Eligible:")
            for version, asset, mf in eligible:
                print(f"    v{version.version_number:<3} {asset.name[:42]:<42} "
                      f"asset={asset.id} version={version.id}")
        for reason in (SKIP_UPLOAD_OPEN, SKIP_OBJECT_MISSING, SKIP_NO_MEDIA_FILE,
                       SKIP_NO_RAW_KEY, SKIP_STORE_ERROR):
            group = [s for s in skipped if s[2] == reason]
            if not group:
                continue
            print()
            print(f"  Skipped — {reason} ({len(group)}):")
            for version, asset, _r, detail in group:
                print(f"    v{version.version_number:<3} {asset.name[:38]:<38} "
                      f"version={version.id}{('  ' + detail) if detail else ''}")
        print(line)

        if not args.requeue:
            print("  Re-run with --requeue to dispatch these.")
            print(line)
            return 0

        # Imported HERE rather than at module scope: importing the task
        # module builds the Celery app and its broker connection, which a
        # dry run has no business doing.
        from apps.api.tasks.transcode_tasks import process_asset

        dispatched = 0
        for version, asset, _mf in eligible:
            if args.limit and dispatched >= args.limit:
                break
            try:
                process_asset.delay(str(asset.id), str(version.id))
            except Exception:  # noqa: BLE001
                # Keep going: one broker hiccup should not stop the rest,
                # and a re-run is safe — process_asset skips `ready` and
                # these rows are still `failed` until a worker picks them up.
                logger.exception(
                    "could not dispatch asset %s version %s; skipping it",
                    asset.id, version.id,
                )
                continue
            dispatched += 1
            logger.info("queued asset %s version %s (%s)", asset.id, version.id, asset.name)

        print(f"  dispatched {dispatched} of {len(eligible)} eligible version(s).")
        print(line)
        return 0 if dispatched == min(len(eligible), args.limit or len(eligible)) else 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
