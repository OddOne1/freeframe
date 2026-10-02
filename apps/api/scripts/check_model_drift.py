#!/usr/bin/env python3
"""Fail when the SQLAlchemy models and the Alembic migrations disagree (§208).

Why this exists, specifically
----------------------------
§200 declared three columns on `GuestUser` and added them to `users` only.
Nothing caught it for two months, because nothing compares the two halves: the
test suite's `conftest.py` mocks the database wholesale, so a model can mention
a column that no table has and every test still passes. The symptom finally
showed up as `psycopg2.errors.UndefinedColumn` and a 500 on every guest comment
— found by hand, while testing something else (§207).

What it does
------------
Builds a database with `alembic upgrade head`, reflects it, and asks Alembic's
own autogenerate machinery what it would still want to change. Anything it
wants is, by definition, a difference between the models and the migrations.

The baseline, and why there is one
----------------------------------
This repo already had ~17 pre-existing differences when this check was written
(dropped `organizations`/`teams`/`contact_requests` tables whose models are
long gone, index renames, a few `nullable`/timezone mismatches). A check that
fails on all of them would have been switched off within a week, which is worth
less than no check at all.

So known differences live in `migration_drift_baseline.txt`, one normalised
line each, and this script fails only on something NOT in that file. That makes
it a ratchet: today's drift is frozen and visible, and tomorrow's is a build
failure. Removing a line from the baseline (because the drift was really fixed)
is always safe — an entry that no longer occurs is reported as stale, not as an
error.

The baseline is deliberately NOT a blanket "ignore guest_users": the three
§208 columns are absent from it, so re-introducing any of them fails here.

Usage
-----
    DATABASE_URL=postgresql://... python apps/api/scripts/check_model_drift.py
    DATABASE_URL=postgresql://... python apps/api/scripts/check_model_drift.py --write-baseline

Exit codes: 0 clean, 1 new drift found, 2 could not run the comparison.
"""

import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
API_ROOT = HERE.parent
BASELINE = API_ROOT / "migration_drift_baseline.txt"

# `alembic/env.py` puts apps/api on sys.path and imports `database`/`models`
# as top-level modules. Match that, so this script and the migrations are
# looking at the same metadata object rather than two copies of it.
sys.path.insert(0, str(API_ROOT))


def normalise(diff) -> list[str]:
    """One stable line per difference.

    Alembic's diff tuples contain live SQLAlchemy objects whose `repr()`
    includes memory addresses, so the raw form cannot be compared across runs.
    These keys carry the kind of change and what it is ON — enough to tell two
    different problems apart, stable enough to commit.
    """
    out = []
    for item in diff:
        # A list means a grouped column alteration (modify_type,
        # modify_nullable, ...) — several entries about one column.
        if isinstance(item, list):
            for sub in item:
                kind, _schema, table, column = sub[0], sub[1], sub[2], sub[3]
                out.append(f"{kind} {table}.{column}")
            continue

        kind = item[0]
        if kind in ("add_table", "remove_table"):
            out.append(f"{kind} {item[1].name}")
        elif kind in ("add_column", "remove_column"):
            out.append(f"{kind} {item[2]}.{item[3].name}")
        elif kind in ("add_index", "remove_index"):
            ix = item[1]
            out.append(f"{kind} {ix.table.name if ix.table is not None else '?'}.{ix.name}")
        elif kind in ("add_constraint", "remove_constraint"):
            c = item[1]
            table = getattr(getattr(c, "table", None), "name", "?")
            cols = ",".join(sorted(col.name for col in getattr(c, "columns", [])))
            out.append(f"{kind} {table}({cols})")
        else:
            out.append(f"{kind} {item[1:]!r}")
    return sorted(out)


def collect() -> list[str]:
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine

    # Importing these runs `config.Settings()`, which requires the full env
    # (DATABASE_URL, REDIS_URL, JWT_SECRET, the S3 block). Reported as exit 2,
    # NOT as drift: a misconfigured job that exits 1 reads as "the models and
    # migrations disagree", which would send whoever sees it looking for a
    # schema problem that isn't there.
    try:
        from database import Base  # noqa: F401  (populates Base.metadata)
        import models  # noqa: F401
    except Exception as exc:
        print(
            "check_model_drift: could not import the models — this is a setup\n"
            "problem, not drift. Every variable config.Settings requires must\n"
            "be present (DATABASE_URL, REDIS_URL, JWT_SECRET, S3_*).\n"
            f"\n{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("check_model_drift: DATABASE_URL is not set", file=sys.stderr)
        sys.exit(2)

    try:
        engine = create_engine(url)
        with engine.connect() as conn:
            context = MigrationContext.configure(conn)
            return normalise(compare_metadata(context, Base.metadata))
    except Exception as exc:
        # Same reasoning as the import guard above: an unreachable or
        # unmigrated database is not a finding about the models.
        print(
            "check_model_drift: could not compare against the database — this\n"
            "is a setup problem, not drift. It must be reachable and already\n"
            "migrated (`alembic upgrade head`).\n"
            f"\n{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)


def main() -> int:
    found = collect()

    if "--write-baseline" in sys.argv:
        BASELINE.write_text(
            "# Known model/migration differences, frozen by §208. See\n"
            "# scripts/check_model_drift.py for why this file exists and how to\n"
            "# shrink it. Do not ADD to it to make a build pass.\n"
            + "".join(f"{line}\n" for line in found)
        )
        print(f"check_model_drift: wrote {len(found)} entries to {BASELINE.name}")
        return 0

    known = set()
    if BASELINE.exists():
        known = {
            line.strip()
            for line in BASELINE.read_text().splitlines()
            if line.strip() and not line.startswith("#")
        }

    new = [line for line in found if line not in known]
    stale = sorted(known - set(found))

    if stale:
        print(
            "check_model_drift: these baseline entries no longer occur — "
            "delete them from migration_drift_baseline.txt:"
        )
        for line in stale:
            print(f"  - {line}")

    if not new:
        print(
            f"check_model_drift: OK — {len(found)} known difference(s), "
            "none new."
        )
        return 0

    print("")
    print("check_model_drift: NEW model/migration drift, not in the baseline:")
    for line in new:
        print(f"  * {line}")
    print("")
    print(
        "A model column with no migration behind it is not inert: SQLAlchemy\n"
        "names every mapped column in its SELECT, so the first query that\n"
        "loads that row fails with UndefinedColumn at runtime (§208).\n"
        "Write a migration, or take the column off the model."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
