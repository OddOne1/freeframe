"""Backfill luts.content_hash for rows uploaded before §44.

Deliberately not part of the migration: it reads every .cube back out of
object storage, and a schema migration has no business doing a long,
failure-prone network operation inside a deploy's transaction.

Until this has run, duplicate detection simply does not see the older
rows — a null hash matches nothing, so it can neither block a new upload
nor be blocked by one.

Run on the server, from the repo root:

    python -m apps.api.scripts.backfill_lut_hashes          # dry run
    python -m apps.api.scripts.backfill_lut_hashes --write

The dry run reports how many rows would be filled and how many .cube files
could not be read, so a storage problem shows up before anything is
written.
"""
import sys

from apps.api.database import SessionLocal
from apps.api.models.lut import Lut
from apps.api.routers.luts import _content_hash
from apps.api.config import settings
from apps.api.services.s3_service import get_s3_client


def main(write: bool) -> int:
    db = SessionLocal()
    s3 = get_s3_client()
    filled = unreadable = 0
    try:
        rows = db.query(Lut).filter(
            Lut.content_hash.is_(None), Lut.deleted_at.is_(None)
        ).all()
        print(f"{len(rows)} LUT(s) without a hash")

        for lut in rows:
            try:
                # boto3 directly: s3_service has put_object but no reader,
                # and adding one for a one-off script would widen a module
                # every router imports.
                obj = s3.get_object(Bucket=settings.s3_bucket, Key=lut.s3_key)
                text = obj["Body"].read().decode("utf-8-sig")
            except Exception as exc:  # noqa: BLE001 - reported, not swallowed
                unreadable += 1
                print(f"  ! {lut.id} {lut.name!r}: {exc}")
                continue
            digest = _content_hash(text)
            if write:
                lut.content_hash = digest
            filled += 1

        if write:
            db.commit()
        print(
            f"{'wrote' if write else 'would write'} {filled}; "
            f"{unreadable} unreadable"
        )
        # Non-zero only for storage failures, so a wrapper script can tell
        # "nothing to do" from "something is wrong".
        return 1 if unreadable else 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main(write="--write" in sys.argv))
