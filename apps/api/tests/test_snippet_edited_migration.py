"""add_snippet_edited_at: where it sits in the chain, what it does, and that
the model says the same.

The chain checks parse the migration files (stdlib only, like
test_socialsnippet_data.py's), so they run without Alembic or a database.
The last test reads the real column from a migrated Postgres and skips
without TEST_DATABASE_URL.
"""
import ast
import os
import re
from pathlib import Path

import pytest

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
MIGRATION = VERSIONS / "add_snippet_edited_at.py"
REVISION = "add_snippet_edited_at"
PARENT = "add_snippet_exports"
PG_URL = os.environ.get("TEST_DATABASE_URL")


def _revisions() -> dict:
    """{revision id -> [down_revisions]}, merge tuples flattened."""
    out = {}
    for path in sorted(VERSIONS.glob("*.py")):
        src = path.read_text()
        rev = re.search(r"^revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        if not rev:
            continue
        down = re.search(r"^down_revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        out[rev.group(1).strip().strip("\"'")] = (
            re.findall(r"[\"']([^\"']+)[\"']", down.group(1)) if down else []
        )
    return out


def _assignments() -> dict:
    tree = ast.parse(MIGRATION.read_text())
    return {
        t.id: node.value.value
        for node in tree.body if isinstance(node, ast.Assign)
        for t in node.targets
        if isinstance(t, ast.Name) and isinstance(node.value, ast.Constant)
    }


def test_it_follows_the_exports_migration_and_its_id_fits():
    values = _assignments()
    assert values["revision"] == REVISION
    assert values["down_revision"] == PARENT
    assert len(REVISION) <= 32, "alembic_version.version_num's default width"


def test_it_is_the_only_head():
    revisions = _revisions()
    assert REVISION in revisions and PARENT in revisions
    referenced = {p for parents in revisions.values() for p in parents}
    heads = sorted(r for r in revisions if r not in referenced)
    assert len(heads) == 1, f"expected exactly one head, found {heads}"


def test_upgrade_adds_one_nullable_column_and_downgrade_drops_it():
    src = MIGRATION.read_text()
    up = src[src.index("def upgrade"):src.index("def downgrade")]
    down = src[src.index("def downgrade"):]
    assert 'op.add_column(\n        "snippets",' in up
    assert '"user_edited_at", sa.DateTime(timezone=True), nullable=True' in up
    assert "execute" not in up and "update" not in up.lower(), "no backfill"
    assert 'op.drop_column("snippets", "user_edited_at")' in down


def test_the_model_declares_the_same_column():
    from apps.api.models.snippet import Snippet

    col = Snippet.__table__.c.user_edited_at
    assert col.nullable is True
    assert col.type.timezone is True
    assert col.server_default is None and col.default is None


@pytest.mark.skipif(not (PG_URL and PG_URL.startswith("postgresql")),
                    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres")
def test_the_migrated_database_has_the_column():
    from sqlalchemy import create_engine, text

    eng = create_engine(PG_URL)
    try:
        with eng.connect() as conn:
            row = conn.execute(text(
                "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
                "WHERE table_name = 'snippets' AND column_name = 'user_edited_at'"
            )).one()
            head = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    finally:
        eng.dispose()
    assert row == ("timestamp with time zone", "YES", None)
    # Migrated at least this far: this revision, or one built on it.
    revisions = _revisions()
    chain, current = set(), head
    while current and current not in chain:
        chain.add(current)
        parents = revisions.get(current, [])
        current = parents[0] if parents else None
    assert REVISION in chain, f"database head {head} does not include {REVISION}"
