"""§240 A — the migration's six columns, as the database actually has them.

`alembic upgrade head` / `downgrade -1` / `upgrade head` was run by hand
against the test Postgres (see the §240 report); what cannot be left to a
hand-run is the SHAPE of what the migration produced, because three of
§240's rules depend on it:

  * NULLABLE with no backfill — a pre-§240 row must read as "unknown
    deleter", which is the one state only an owner may restore;
  * `ON DELETE SET NULL` to `users.id` — a hard-deleted account must not
    take a trash row with it, and must not block the delete either;
  * `deleted_by_name` wide enough for a name snapshot (255, matching
    `created_by_name`).

The single-head property is already covered structurally, for every
revision including this one, by
`test_alembic_revision_width.py::test_the_chain_has_exactly_one_head`.
"""

import pytest

from .trash_world_240 import PG_URL, realdb

pytestmark = realdb

TABLES = ("assets", "folders", "asset_versions")


@pytest.fixture(scope="module")
def conn():
    from sqlalchemy import create_engine

    engine = create_engine(PG_URL)
    with engine.connect() as c:
        yield c


def test_both_columns_exist_on_all_three_tables(conn):
    from sqlalchemy import text

    rows = conn.execute(text("""
        SELECT table_name, column_name, is_nullable, data_type,
               character_maximum_length
        FROM information_schema.columns
        WHERE table_name = ANY(:tables)
          AND column_name IN ('deleted_by', 'deleted_by_name')
    """), {"tables": list(TABLES)}).all()
    found = {(r.table_name, r.column_name): r for r in rows}
    assert set(found) == {(t, c) for t in TABLES for c in ("deleted_by", "deleted_by_name")}
    for (table, column), row in found.items():
        assert row.is_nullable == "YES", (table, column)
        if column == "deleted_by":
            assert row.data_type == "uuid"
        else:
            assert row.character_maximum_length == 255


def test_the_deleter_fk_sets_null_rather_than_blocking(conn):
    from sqlalchemy import text

    rows = conn.execute(text("""
        SELECT c.table_name, rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.table_constraints c
          ON c.constraint_name = rc.constraint_name
        WHERE c.constraint_name = ANY(:names)
    """), {"names": [f"fk_{t}_deleted_by_users" for t in TABLES]}).all()
    assert {r.table_name for r in rows} == set(TABLES)
    assert {r.delete_rule for r in rows} == {"SET NULL"}


def test_the_models_and_the_database_agree(conn):
    """The columns are on the ORM models too — a migration the models do
    not know about is a column nothing reads."""
    from apps.api.models.asset import Asset, AssetVersion
    from apps.api.models.folder import Folder

    for model in (Asset, AssetVersion, Folder):
        assert "deleted_by" in model.__table__.c
        assert "deleted_by_name" in model.__table__.c
        assert model.__table__.c.deleted_by.nullable
        assert model.__table__.c.deleted_by_name.nullable


def test_nothing_was_backfilled(conn):
    """No row may have gained a deleter it never had. Vacuously true on a
    fresh database and the assertion that would catch a backfill being
    added to the migration later."""
    from sqlalchemy import text

    for table in TABLES:
        orphan = conn.execute(text(
            f"SELECT COUNT(*) FROM {table} "
            "WHERE deleted_at IS NULL AND deleted_by IS NOT NULL"
        )).scalar()
        assert orphan == 0, table
