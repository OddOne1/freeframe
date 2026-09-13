"""What the Recently Deleted purge would delete on its first real run (§182).

`purge_expired_trash` has been in beat_schedule since the retention feature
shipped and has never executed: it declares an explicit `name=`, so the
module-glob route never matched it and every dispatch fell through to the
`default` queue, which no container consumes. §182 routed it properly, which
means its next 03:00 tick will delete the ENTIRE accumulated backlog — every
asset and folder soft-deleted more than 30 days ago — in one pass.

This script exists so that is a decision rather than a surprise. It is
READ-ONLY: no writes, no deletes, no S3 calls at all. It answers one
question — how much is sitting past its retention window, and roughly how
much storage that is — so the scale is known before the job is switched on.

Run on the server, from the repo root:

    docker-compose exec api python -m apps.api.scripts.report_trash_backlog

    --days N        use a different retention window for the report only
                    (does not change what the real purge uses)
    --limit N       how many individual items to list (default 20)
"""
import argparse
import sys
from datetime import datetime, timezone

from sqlalchemy import func

from apps.api.database import SessionLocal
from apps.api.models.asset import Asset, AssetVersion, MediaFile
from apps.api.models.folder import Folder
from apps.api.models.project import Project
from apps.api.services.purge_service import RETENTION_DAYS, retention_cutoff


def _human(n: int) -> str:
    n = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} TB"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=RETENTION_DAYS)
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args(argv)

    now = datetime.now(timezone.utc)
    cutoff = retention_cutoff(now) if args.days == RETENTION_DAYS else (
        now - __import__("datetime").timedelta(days=args.days)
    )

    db = SessionLocal()
    try:
        due_assets = (
            db.query(Asset)
            .filter(Asset.deleted_at.isnot(None), Asset.deleted_at < cutoff)
            .order_by(Asset.deleted_at)
            .all()
        )
        due_folders = (
            db.query(Folder)
            .filter(Folder.deleted_at.isnot(None), Folder.deleted_at < cutoff)
            .order_by(Folder.deleted_at)
            .all()
        )

        # Everything still in the trash but NOT yet due — the number that
        # says whether this is a one-time backlog or an ongoing rate.
        in_trash_assets = (
            db.query(func.count(Asset.id)).filter(Asset.deleted_at.isnot(None)).scalar() or 0
        )

        due_ids = [a.id for a in due_assets]
        bytes_due = 0
        if due_ids:
            bytes_due = (
                db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0))
                .join(AssetVersion, MediaFile.version_id == AssetVersion.id)
                .filter(AssetVersion.asset_id.in_(due_ids))
                .scalar()
            ) or 0

        line = "─" * 72
        print()
        print(line)
        print("Recently Deleted — what the purge would delete on its first run")
        print(line)
        print(f"  retention window             {args.days} days")
        print(f"  cutoff                       {cutoff.isoformat()}")
        print()
        print(f"  assets PAST retention        {len(due_assets)}")
        print(f"  folders PAST retention       {len(due_folders)}")
        print(f"  storage they hold            {_human(bytes_due)}")
        print()
        print(f"  assets in trash in total     {in_trash_assets}")
        print(f"    - not yet due              {in_trash_assets - len(due_assets)}")

        if due_assets:
            oldest = due_assets[0].deleted_at
            newest = due_assets[-1].deleted_at
            print()
            print(f"  oldest deletion              {oldest.isoformat() if oldest else '?'}")
            print(f"  newest deletion past cutoff  {newest.isoformat() if newest else '?'}")

            names = {
                p.id: p.name for p in db.query(Project).filter(
                    Project.id.in_({a.project_id for a in due_assets})
                ).all()
            }
            print()
            print(f"  Oldest {min(args.limit, len(due_assets))} of {len(due_assets)}:")
            for a in due_assets[:args.limit]:
                age = (now - a.deleted_at).days if a.deleted_at else "?"
                print(f"    {str(age):>4}d  {names.get(a.project_id, '?')[:22]:22}  {a.name[:34]}")
            if len(due_assets) > args.limit:
                print(f"    ... and {len(due_assets) - args.limit} more")

        print(line)
        if due_assets or due_folders:
            print("  NOTHING HAS BEEN DELETED. This script only reports.")
            print("  The routing fix means the next 03:00 tick purges all of the above.")
        else:
            print("  Nothing is past its retention window.")
        print(line)
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
