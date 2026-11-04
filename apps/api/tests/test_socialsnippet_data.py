"""SocialSnippet data layer: the migration's place in the chain, and the one read rule.

Two halves:

* Structural, stdlib-only, always run — the chain has exactly one head, the
  new revision id fits Alembic's default VARCHAR(32), and the migration
  creates no extension. Same approach as test_alembic_revision_width.py:
  parse the files, import nothing.

* Real Postgres, skipped without TEST_DATABASE_URL — the soft-delete helper
  (`models/snippet.py::live_media_file_clause`, via `AssetBound.live`) leaves
  out rows of a deleted asset for EVERY asset-bound table, and the
  media_files cascade that keeps `purge_asset` working holds. A mocked
  session cannot answer either: both are about what Postgres does.

    docker run -d --name ffsnip-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55470:5432 postgres:15
    (cd apps/api && alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55470/freeframe \\
      pytest apps/api/tests/test_socialsnippet_data.py

Each real-DB test runs inside one outer transaction that is rolled back, so
the database is left exactly as it was found.
"""

import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest

API = Path(__file__).resolve().parents[1]
VERSIONS = API / "alembic" / "versions"
NEW_REVISION = "add_socialsnippet_data"
NEW_MIGRATION = VERSIONS / "add_socialsnippet_data.py"

#: Alembic's own default width for alembic_version.version_num. The chain
#: widens the column later (§222), but a NEW id is held to the default so it
#: never depends on that widening having run.
DEFAULT_VERSION_NUM_WIDTH = 32


def _revisions() -> dict:
    """{revision id -> [down_revisions]}, merge tuples flattened."""
    out = {}
    for path in sorted(VERSIONS.glob("*.py")):
        src = path.read_text()
        rev = re.search(r"^revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        if not rev:
            continue
        rid = rev.group(1).strip().strip("\"'")
        down = re.search(r"^down_revision\s*(?::\s*[^=]+)?=\s*(.+)$", src, re.M)
        out[rid] = re.findall(r"[\"']([^\"']+)[\"']", down.group(1)) if down else []
    return out


# ── (a) one head ───────────────────────────────────────────────────────────


def test_the_scan_finds_the_chain():
    """Guards the guard: a broken glob or regex would make 'one head' pass
    against an empty dict."""
    revisions = _revisions()
    assert len(revisions) >= 70, f"only parsed {len(revisions)} revisions"
    assert NEW_REVISION in revisions


def test_the_chain_has_exactly_one_head():
    revisions = _revisions()
    referenced = {p for parents in revisions.values() for p in parents}
    heads = sorted(r for r in revisions if r not in referenced)
    # Exactly one, not "exactly this one": the next migration will rightly
    # become the head, and that must not fail here.
    assert len(heads) == 1, f"expected exactly one head, found {heads}"


def test_the_new_revision_points_at_a_real_parent():
    revisions = _revisions()
    parents = revisions[NEW_REVISION]
    assert len(parents) == 1, f"{NEW_REVISION} should have one parent, has {parents}"
    assert parents[0] in revisions, f"down_revision {parents[0]!r} names no revision"


# ── (b) the id fits ────────────────────────────────────────────────────────


def test_the_new_revision_id_fits_the_default_column():
    assert len(NEW_REVISION) <= DEFAULT_VERSION_NUM_WIDTH, (
        f"{NEW_REVISION!r} is {len(NEW_REVISION)} characters; "
        f"the limit for a new id is {DEFAULT_VERSION_NUM_WIDTH}"
    )
    src = NEW_MIGRATION.read_text()
    declared = re.search(r"^revision\s*=\s*[\"']([^\"']+)[\"']", src, re.M).group(1)
    assert declared == NEW_REVISION


# ── task rules the migration must keep ─────────────────────────────────────


def test_the_migration_creates_no_extension():
    """No SQL the migration can execute creates an extension — pg_trgm is
    only USED if the database already has it.

    Checks every string literal passed to a call (`op.execute(...)`,
    `sa.text(...)`, ...), not the raw file: the docstring is allowed to SAY
    that it never does this."""
    import ast

    tree = ast.parse(NEW_MIGRATION.read_text())
    executed = [
        arg.value
        for node in ast.walk(tree) if isinstance(node, ast.Call)
        for arg in node.args if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
    ]
    assert any("pg_extension" in s for s in executed), "the pg_trgm probe was not found"
    offending = [s for s in executed if re.search(r"create\s+extension", s, re.I)]
    assert not offending, offending


def test_the_export_setting_is_not_called_aspect_ratio():
    """`aspect_ratio` already means the share page's card layout
    (ShareLinkAppearance). The export setting is `export_aspect`."""
    for path in (NEW_MIGRATION, API / "models" / "snippet.py"):
        code = "\n".join(
            line for line in path.read_text().splitlines()
            if not line.lstrip().startswith("#")
        )
        assert "export_aspect" in code, path.name
        assert not re.search(r"[\"']aspect_ratio[\"']|\baspect_ratio\s*[:=]", code), path.name


# ── (c) the soft-delete helper, compiled ───────────────────────────────────


def test_the_live_clause_reads_assets_deleted_at_for_every_asset_bound_model():
    """Runs without a database: the helper's SQL, as Postgres would get it,
    must test `assets.deleted_at IS NULL` for every asset-bound table —
    including the two that reach their media file only through a segment."""
    from sqlalchemy.dialects import postgresql

    from apps.api.models.snippet import (
        AssetBound, Snippet, SnippetJob, SnippetTrackSpeaker, TranscriptEdit,
        TranscriptSegment, TranscriptWord,
    )

    models = [SnippetTrackSpeaker, TranscriptSegment, TranscriptWord, TranscriptEdit, SnippetJob, Snippet]
    # Every AssetBound subclass is in the list, so a seventh one added later
    # without a test fails here instead of being silently uncovered.
    def _leaves(cls):
        for sub in cls.__subclasses__():
            if hasattr(sub, "__tablename__"):
                yield sub
            yield from _leaves(sub)
    assert set(_leaves(AssetBound)) == set(models)

    from sqlalchemy import select

    for model in models:
        table = model.__tablename__
        sql = str(select(model).where(model.live_clause()).compile(dialect=postgresql.dialect()))
        assert "assets.deleted_at IS NULL" in sql, (model.__name__, sql)
        assert "media_files" in sql and "asset_versions" in sql, (model.__name__, sql)
        # Correlated to the OUTER row: the model's own table may appear in
        # exactly ONE FROM list — the outer query's. If any subquery lists
        # it again, that subquery ranges over the whole table instead of
        # this row. That is the bug a nested scalar subquery produced for
        # words and edits (Postgres: "more than one row returned by a
        # subquery"), and it sat one level BELOW the EXISTS, so every FROM
        # list in the statement is checked, not just the EXISTS's own.
        from_lists = re.findall(r"\bFROM\s+([\w\s,]+?)\s*(?=\bWHERE\b|\)|$)", sql)
        listing_own_table = [f for f in from_lists if re.search(rf"\b{table}\b", f)]
        assert len(listing_own_table) == 1, (model.__name__, from_lists)


# ── (c) the soft-delete helper, against Postgres ───────────────────────────

PG_URL = os.environ.get("TEST_DATABASE_URL")

realdb = pytest.mark.skipif(
    not PG_URL or not PG_URL.startswith("postgresql"),
    reason="needs TEST_DATABASE_URL pointing at a migrated Postgres",
)


@pytest.fixture(scope="module")
def engine():
    from sqlalchemy import create_engine

    eng = create_engine(PG_URL)
    yield eng
    eng.dispose()


@pytest.fixture
def session(engine):
    """One outer transaction per test, rolled back at the end."""
    from sqlalchemy.orm import Session

    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield s
    finally:
        s.close()
        outer.rollback()
        conn.close()


def _world(s):
    """Two video assets in one project, each with one transcribed version.
    `gone` is soft-deleted; `kept` is not. Every SocialSnippet table gets one
    row per asset."""
    from apps.api.models.asset import Asset, AssetType, AssetVersion, FileType, MediaFile
    from apps.api.models.project import Project
    from apps.api.models.snippet import (
        Snippet, SnippetJob, SnippetProjectSettings, SnippetSpeaker,
        SnippetTrackSpeaker, TranscriptEdit, TranscriptSegment, TranscriptWord,
    )
    from apps.api.models.user import User

    user = User(email=f"snip-{uuid.uuid4().hex[:10]}@ff-snippet.test", first_name="Sni", last_name="Ppet")
    s.add(user)
    s.flush()
    project = Project(name=f"SNIP-{uuid.uuid4().hex[:8]}", created_by=user.id)
    s.add(project)
    s.flush()
    s.add(SnippetProjectSettings(project_id=project.id, enabled=True))
    speaker = SnippetSpeaker(project_id=project.id, name="Anna", created_by=user.id)
    s.add(speaker)
    s.flush()

    out = {"project": project, "speaker": speaker, "user": user}
    for key in ("kept", "gone"):
        asset = Asset(
            project_id=project.id, name=f"{key}.mov", asset_type=AssetType.video, created_by=user.id
        )
        s.add(asset)
        s.flush()
        version = AssetVersion(asset_id=asset.id, version_number=1)
        s.add(version)
        s.flush()
        mf = MediaFile(
            version_id=version.id, file_type=FileType.video, original_filename=f"{key}.mov",
            mime_type="video/quicktime", file_size_bytes=1,
            s3_key_raw=f"raw/{project.id}/{asset.id}/{version.id}/original.mov",
        )
        s.add(mf)
        s.flush()
        seg = TranscriptSegment(
            media_file_id=mf.id, track_index=0, speaker_id=speaker.id, seq=0,
            start_ms=0, end_ms=1500, language="de",
            text_ai=f"hallo {key} welt", text_current=f"hallo {key} welt",
        )
        s.add(seg)
        s.flush()
        s.add_all([
            SnippetTrackSpeaker(media_file_id=mf.id, track_index=0, speaker_id=speaker.id),
            TranscriptWord(segment_id=seg.id, idx=0, start_ms=0, end_ms=400, word="hallo", probability=0.9),
            TranscriptEdit(segment_id=seg.id, user_id=user.id, old_text="hallo", new_text="Hallo"),
            SnippetJob(media_file_id=mf.id, stage="transcribe"),
            Snippet(media_file_id=mf.id, speaker_id=speaker.id, start_ms=0, end_ms=1500, topics=["intro"]),
        ])
        s.flush()
        out[key] = {"asset": asset, "media_file": mf, "segment": seg}

    out["gone"]["asset"].deleted_at = datetime.now(timezone.utc)
    s.flush()
    return out


def _media_file_ids(model, rows, s):
    """Which media file each returned row belongs to."""
    from apps.api.models.snippet import TranscriptSegment

    if hasattr(model, "media_file_id"):
        return {r.media_file_id for r in rows}
    seg_ids = {r.segment_id for r in rows}
    return {
        seg.media_file_id
        for seg in s.query(TranscriptSegment).filter(TranscriptSegment.id.in_(seg_ids))
    }


@realdb
def test_live_excludes_rows_of_a_soft_deleted_asset_on_every_asset_bound_table(session):
    from apps.api.models.snippet import (
        Snippet, SnippetJob, SnippetTrackSpeaker, TranscriptEdit, TranscriptSegment, TranscriptWord,
    )

    world = _world(session)
    kept = world["kept"]["media_file"].id
    gone = world["gone"]["media_file"].id

    for model in (SnippetTrackSpeaker, TranscriptSegment, TranscriptWord, TranscriptEdit, SnippetJob, Snippet):
        everything = session.query(model).all()
        # The setup really has a row of the deleted asset in every table —
        # otherwise "excluded" would pass by there being nothing to exclude.
        assert gone in _media_file_ids(model, everything, session), model.__name__

        live = model.live(session).all()
        assert _media_file_ids(model, live, session) == {kept}, model.__name__


@realdb
def test_restoring_the_asset_brings_its_rows_back(session):
    from apps.api.models.snippet import TranscriptSegment

    world = _world(session)
    world["gone"]["asset"].deleted_at = None
    session.flush()
    ids = {seg.media_file_id for seg in TranscriptSegment.live(session)}
    assert ids == {world["kept"]["media_file"].id, world["gone"]["media_file"].id}


@realdb
def test_live_chains_with_further_filters_and_full_text_search(session):
    """The helper is a filter, not a query of its own: a search on top of it
    still only sees live assets. Also exercises the generated tsvector."""
    from sqlalchemy import func

    from apps.api.models.snippet import TranscriptSegment

    world = _world(session)
    q = func.plainto_tsquery("simple", "hallo welt")
    hits = TranscriptSegment.live(session).filter(TranscriptSegment.search_vector.op("@@")(q)).all()
    assert [h.media_file_id for h in hits] == [world["kept"]["media_file"].id]

    # And the deleted one IS there without the helper, so the test above
    # measured the helper, not the search.
    all_hits = session.query(TranscriptSegment).filter(TranscriptSegment.search_vector.op("@@")(q)).all()
    assert len(all_hits) == 2


@realdb
def test_deleting_a_media_file_cascades_so_purge_keeps_working(session):
    """purge_service.purge_asset deletes media_files rows and knows nothing
    about these tables. Without ON DELETE CASCADE that DELETE would fail."""
    from sqlalchemy import text

    world = _world(session)
    mf_id = world["gone"]["media_file"].id
    seg_id = world["gone"]["segment"].id
    session.execute(text("DELETE FROM media_files WHERE id = :id"), {"id": mf_id})
    for table, col, value in (
        ("transcript_segments", "media_file_id", mf_id),
        ("transcript_words", "segment_id", seg_id),
        ("transcript_edits", "segment_id", seg_id),
        ("snippet_track_speakers", "media_file_id", mf_id),
        ("snippet_jobs", "media_file_id", mf_id),
        ("snippets", "media_file_id", mf_id),
    ):
        left = session.execute(text(f"SELECT count(*) FROM {table} WHERE {col} = :v"), {"v": value}).scalar()
        assert left == 0, table


@realdb
def test_speaker_names_are_unique_per_project_ignoring_case(session):
    from sqlalchemy.exc import IntegrityError

    from apps.api.models.snippet import SnippetSpeaker

    world = _world(session)
    session.add(SnippetSpeaker(project_id=world["project"].id, name="ANNA"))
    with pytest.raises(IntegrityError):
        session.flush()
