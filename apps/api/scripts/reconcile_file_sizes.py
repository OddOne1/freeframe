"""Backfill media_files.file_size_bytes from the real S3 object size (§181).

§180 made every NEW upload reconcile itself at /upload/complete, and added
`media_files.size_verified_at` — NULL on every row that predates it, and on
any row whose HEAD failed at the time. That NULL is this script's work
queue; nothing else had to be added to track it.

Why it matters: both storage-quota checks in routers/upload.py and every
storage figure in the admin UI are sums of `file_size_bytes`, and until
§180 that column held whatever the uploading client said it was. Until this
has run, those numbers are only as good as the clients that produced them.

Deliberately a script, not an endpoint: it may touch thousands of rows and
makes one S3 round-trip each, which is neither a request nor a migration's
business.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.reconcile_file_sizes
    docker-compose exec api python -m apps.api.scripts.reconcile_file_sizes --write

The first form is a DRY RUN and writes nothing — that is the default, and
--write is the only thing that changes it. Interrupting a --write run is
safe: rows commit per batch, and the `size_verified_at IS NULL` filter
means a re-run resumes exactly where it stopped.

    --batch-size N     rows per DB commit and per pause (default 200)
    --sleep SECONDS    pause between batches, to stay out of the way of
                       real traffic on the shared AIStor endpoint
                       (default 0.5)
    --limit N          stop after N rows — for a quick look at a big library
    --progress-every N log a running total every N rows (default 500)
"""
import argparse
import logging
import sys
import time
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile, ProcessingStatus
from apps.api.services.s3_service import head_object_size

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("reconcile_file_sizes")

#: S3 error codes that mean "the object is not there", as opposed to "the
#: bucket would not answer". The two are reported separately: the first is a
#: data-integrity finding, the second is a transient failure to re-run.
MISSING_CODES = {"404", "NoSuchKey", "NoSuchBucket"}


def _human(n: int) -> str:
    """Bytes, at a size a person can compare at a glance."""
    sign = "-" if n < 0 else ""
    n = abs(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{sign}{n:.1f} {unit}" if unit != "B" else f"{sign}{n} B"
        n /= 1024
    return f"{sign}{n:.1f} TB"


def _is_missing(exc: Exception) -> bool:
    if isinstance(exc, ClientError):
        code = str(exc.response.get("Error", {}).get("Code", ""))
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        return code in MISSING_CODES or status == 404
    # boto3 also exposes a generated NoSuchKey class; matching on the name
    # avoids importing a client just to reference its exception hierarchy.
    return type(exc).__name__ in {"NoSuchKey", "NoSuchBucket"}


class Report:
    """What the dry run is for: the shape of the problem, before anyone
    authorises a write."""

    def __init__(self) -> None:
        self.checked = 0
        self.matched = 0
        self.mismatched = 0
        self.drift = 0            # signed: positive means clients under-reported
        self.abs_drift = 0
        self.written = 0
        self.offenders: list[tuple[int, float, MediaFile, int, int]] = []
        #: Object not in S3 at all, split by whether the row claims to be a
        #: finished upload. An `uploading`/`failed` version with no object is
        #: an abandoned upload — expected litter. A `ready` one is a file the
        #: UI still offers to play and whose bytes are gone.
        self.missing_incomplete: list[tuple[MediaFile, str]] = []
        self.missing_ready: list[tuple[MediaFile, str]] = []
        self.errored: list[tuple[MediaFile, str]] = []

    def record(self, mf: MediaFile, declared: int, actual: int) -> None:
        self.checked += 1
        if actual == declared:
            self.matched += 1
            return
        self.mismatched += 1
        delta = actual - declared
        self.drift += delta
        self.abs_drift += abs(delta)
        pct = (abs(delta) / declared * 100) if declared else float("inf")
        self.offenders.append((abs(delta), pct, mf, declared, actual))

    def print_summary(self, wrote: bool) -> None:
        line = "─" * 68
        print()
        print(line)
        print("§181 — file size reconciliation " + ("(WROTE)" if wrote else "(DRY RUN — nothing written)"))
        print(line)
        print(f"  rows checked                 {self.checked}")
        print(f"  sizes already correct        {self.matched}")
        print(f"  sizes wrong                  {self.mismatched}")
        if wrote:
            print(f"  rows updated                 {self.written}")
        print(f"  net drift                    {_human(self.drift)} "
              f"({'under' if self.drift > 0 else 'over'}-reported overall)")
        print(f"  total absolute drift         {_human(self.abs_drift)}")
        print()
        print(f"  objects MISSING from S3      {len(self.missing_ready) + len(self.missing_incomplete)}")
        print(f"    - version is ready         {len(self.missing_ready)}   <-- integrity problem")
        print(f"    - upload never finished    {len(self.missing_incomplete)}   (expected litter)")
        print(f"  could not be checked         {len(self.errored)}   (re-run; storage did not answer)")

        if self.offenders:
            print()
            print("  Worst by absolute difference:")
            for d, pct, mf, declared, actual in sorted(self.offenders, key=lambda o: -o[0])[:10]:
                print(f"    {_human(d):>12}  {pct:7.1f}%  declared {_human(declared):>10} "
                      f"actual {_human(actual):>10}  {mf.original_filename}")
            print()
            print("  Worst by percentage:")
            for d, pct, mf, declared, actual in sorted(self.offenders, key=lambda o: -o[1])[:10]:
                print(f"    {pct:7.1f}%  {_human(d):>12}  declared {_human(declared):>10} "
                      f"actual {_human(actual):>10}  {mf.original_filename}")

        if self.missing_ready:
            print()
            print("  MISSING objects on ready versions — look at these by hand:")
            for mf, why in self.missing_ready[:20]:
                print(f"    {mf.id}  {mf.s3_key_raw}  ({why})")
            if len(self.missing_ready) > 20:
                print(f"    ... and {len(self.missing_ready) - 20} more")
        print(line)


def _batch(db, after_id, size):
    """One page of unverified rows, keyset-paginated by id.

    Keyset rather than OFFSET, and in BOTH modes: a dry run never shrinks
    the `size_verified_at IS NULL` set, so a plain `.limit()` loop would
    hand back the same page forever.
    """
    q = db.query(MediaFile).filter(MediaFile.size_verified_at.is_(None))
    if after_id is not None:
        q = q.filter(MediaFile.id > after_id)
    # order_by/limit last: SQLAlchemy refuses a filter() applied after them.
    return q.order_by(MediaFile.id).limit(size).all()


def _version_status(db, mf: MediaFile) -> str:
    v = db.query(AssetVersion).filter(AssetVersion.id == mf.version_id).first()
    if not v:
        return "no version row"
    status = v.processing_status
    return status.value if hasattr(status, "value") else str(status)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true",
                    help="actually update rows (default is a dry run)")
    ap.add_argument("--batch-size", type=int, default=200)
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds to pause between batches")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--progress-every", type=int, default=500)
    args = ap.parse_args(argv)

    db = SessionLocal()
    report = Report()
    try:
        try:
            total = (
                db.query(MediaFile)
                .filter(MediaFile.size_verified_at.is_(None))
                .count()
            )
        except Exception as exc:  # noqa: BLE001
            # Almost always one thing: §180's migration has not been applied
            # to this database yet, so the column this script is built around
            # does not exist. Worth saying plainly — the raw ProgrammingError
            # is several screens of SQL and names nothing actionable.
            db.rollback()
            logger.error(
                "could not read media_files.size_verified_at (%s). "
                "If this says the column does not exist, run "
                "`alembic upgrade head` first — it arrives with §180.",
                exc,
            )
            return 2
        logger.info(
            "%s rows with an unverified size%s. Mode: %s",
            total,
            f" (stopping after {args.limit})" if args.limit else "",
            "WRITE" if args.write else "DRY RUN",
        )
        if not total:
            report.print_summary(args.write)
            return 0

        after_id = None
        started = time.time()

        while True:
            remaining = (args.limit - report.checked) if args.limit else None
            if remaining is not None and remaining <= 0:
                break
            rows = _batch(db, after_id, min(args.batch_size, remaining or args.batch_size))
            if not rows:
                break
            after_id = rows[-1].id

            for mf in rows:
                declared = mf.file_size_bytes
                try:
                    actual = head_object_size(mf.s3_key_raw)
                except Exception as exc:  # noqa: BLE001 — sorted below, never swallowed
                    if _is_missing(exc):
                        status = _version_status(db, mf)
                        # Never auto-corrected. A row whose object is gone is
                        # either an abandoned upload or a genuinely broken
                        # asset, and writing 0 here would quietly fold a
                        # data-integrity problem into the storage totals as
                        # if it were a free file.
                        if status in (ProcessingStatus.ready.value, "ready"):
                            report.missing_ready.append((mf, status))
                        else:
                            report.missing_incomplete.append((mf, status))
                    else:
                        report.errored.append((mf, str(exc)))
                    continue

                report.record(mf, declared, actual)
                if args.write and actual != declared:
                    mf.file_size_bytes = actual
                if args.write:
                    mf.size_verified_at = datetime.now(timezone.utc)
                    report.written += 1

                if report.checked and report.checked % args.progress_every == 0:
                    rate = report.checked / max(time.time() - started, 0.001)
                    logger.info(
                        "%s/%s checked · %s wrong · %s drift · %.1f rows/s",
                        report.checked, total, report.mismatched,
                        _human(report.abs_drift), rate,
                    )

            if args.write:
                # Per batch, not per row and not once at the end: this is what
                # makes an interrupted run resume instead of restart, and what
                # keeps a multi-thousand-row run off one enormous transaction.
                db.commit()

            # Deliberately between batches rather than between rows: the
            # point is to leave gaps for real user traffic on the shared
            # AIStor endpoint, not to slow every single call down.
            if args.sleep:
                time.sleep(args.sleep)

        if args.write:
            db.commit()

        report.print_summary(args.write)

        # Non-zero when something needs a human: a missing object on a ready
        # version, or storage that would not answer. A pile of mismatches is
        # exactly what this script exists to find and is not a failure.
        return 1 if (report.missing_ready or report.errored) else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
