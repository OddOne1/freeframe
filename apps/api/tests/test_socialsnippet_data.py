"""SocialSnippet data layer: the migration's place in the chain, and the one read rule.

Two halves:

* Structural, stdlib-only, always run — the chain has exactly one head, the
  new revision id fits Alembic's default VARCHAR(32), and the migration
  creates no extension. Same approach as test_alembic_revision_width.py:
  parse the files, import nothing.

* Real Postgres, skipped without TEST_DATABASE_URL — the soft-delete helper
  (`models/snippet.py::live_media_file_clause`, via `AssetBound.live`) leaves
  out rows of a deleted asset for EVERY asset-bound table, the media_files
  cascade that keeps `purge_asset` working holds, and the CHECKs on
  `export_aspect` and `snippets.source` admit exactly the listed values and
  nothing else. A mocked session cannot answer any of it: all of it is about
  what Postgres does.

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


def test_the_model_and_the_migration_list_the_same_export_aspects():
    """The migration writes the list out by hand (it must not change when the
    model does), so SOMETHING has to compare the two copies — otherwise
    adding a shape to one of them is a silent one-sided change."""
    from apps.api.models.snippet import EXPORT_ASPECTS

    expected = ("9:16", "16:9", "1:1", "4:5", "3:4", "4:3")
    assert EXPORT_ASPECTS == expected
    body = re.search(r"export_aspect IN \(([^)]*)\)", NEW_MIGRATION.read_text())
    assert body, "no export_aspect CHECK found in the migration"
    assert tuple(re.findall(r"'([^']+)'", body.group(1))) == expected


def test_the_model_and_the_migration_list_the_same_snippet_sources():
    from apps.api.models.snippet import SNIPPET_SOURCES

    expected = ("keyword", "llm", "import", "manual")
    assert SNIPPET_SOURCES == expected
    body = re.search(r"source IN \(([^)]*)\)", NEW_MIGRATION.read_text())
    assert body, "no source CHECK found in the migration"
    assert tuple(re.findall(r"'([^']+)'", body.group(1))) == expected


def test_every_export_aspect_fits_the_declared_column_width():
    """A value longer than the varchar would be rejected at runtime, not
    here, so the width is checked against the list rather than assumed."""
    from apps.api.models.snippet import EXPORT_ASPECTS, SnippetProjectSettings

    model_width = SnippetProjectSettings.__table__.c.export_aspect.type.length
    longest = max(len(a) for a in EXPORT_ASPECTS)
    assert longest <= model_width, (longest, model_width)

    # And the migration declares the same width as the model.
    src = NEW_MIGRATION.read_text()
    declared = re.search(r'"export_aspect",\s*sa\.String\((\d+)\)', src)
    assert declared, "could not find the export_aspect column in the migration"
    assert int(declared.group(1)) == model_width


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


# ── (d) the schema rules, against Postgres ─────────────────────────────────


@realdb
def test_every_listed_export_aspect_is_accepted_and_an_unlisted_one_is_not(session):
    """All six go in; 2:3 does not. 2:3 is a real aspect ratio and still not
    one of ours — the CHECK is a list of supported shapes, not a test for
    whether a string looks like a ratio."""
    from sqlalchemy.exc import IntegrityError

    from apps.api.models.snippet import EXPORT_ASPECTS, SnippetProjectSettings

    world = _world(session)
    pid = world["project"].id
    row = session.get(SnippetProjectSettings, pid)
    assert row is not None

    for aspect in EXPORT_ASPECTS:
        with session.begin_nested():
            row.export_aspect = aspect
            session.flush()
        session.expire(row)
        assert row.export_aspect == aspect, aspect

    with pytest.raises(IntegrityError) as exc:
        with session.begin_nested():
            row.export_aspect = "2:3"
            session.flush()
    assert "ck_snippet_settings_export_aspect" in str(exc.value)


@realdb
def test_export_aspect_defaults_to_portrait_in_the_database(session):
    """The DEFAULT Postgres holds, not the model's python-side one: a row
    written by raw SQL — a backfill, a psql session — gets 9:16 as well."""
    from sqlalchemy import text

    from apps.api.models.project import Project

    world = _world(session)
    other = Project(name=f"SNIP-{uuid.uuid4().hex[:8]}", created_by=world["user"].id)
    session.add(other)
    session.flush()
    session.execute(
        text("INSERT INTO snippet_project_settings (project_id) VALUES (:p)"), {"p": other.id}
    )
    got = session.execute(
        text("SELECT export_aspect FROM snippet_project_settings WHERE project_id = :p"),
        {"p": other.id},
    ).scalar()
    assert got == "9:16"


@realdb
def test_snippet_source_admits_the_listed_kinds_and_rejects_anything_else(session):
    """`generator` is free text and takes whatever the implementation is
    called; `source` is the closed list."""
    from sqlalchemy.exc import IntegrityError

    from apps.api.models.snippet import SNIPPET_SOURCES, Snippet

    world = _world(session)
    mf = world["kept"]["media_file"].id

    generators = {"keyword": "yake-lite", "llm": "claude", "import": None, "manual": "hand"}
    for i, kind in enumerate(SNIPPET_SOURCES):
        with session.begin_nested():
            row = Snippet(
                media_file_id=mf, start_ms=10_000 + i * 100, end_ms=10_050 + i * 100,
                source=kind, generator=generators[kind],
            )
            session.add(row)
            session.flush()
        session.expire(row)
        assert (row.source, row.generator) == (kind, generators[kind]), kind

    # Omitting it is the keyword pipeline, the common case.
    with session.begin_nested():
        implied = Snippet(media_file_id=mf, start_ms=20_000, end_ms=20_500)
        session.add(implied)
        session.flush()
    session.expire(implied)
    assert implied.source == "keyword"
    assert implied.generator is None

    # Last DB action of the test: the failed INSERT leaves the object
    # pending, and a later flush would retry it.
    with pytest.raises(IntegrityError) as exc:
        with session.begin_nested():
            session.add(
                Snippet(media_file_id=mf, start_ms=30_000, end_ms=30_500, source="vibes")
            )
            session.flush()
    assert "ck_snippets_source" in str(exc.value)


@realdb
def test_both_scores_may_be_null_meaning_not_scored(session):
    """NULL is the state of a clip the scorer has not reached, and of one it
    never will (import, hand). 0.0 would claim it scored badly."""
    from sqlalchemy import text

    from apps.api.models.snippet import Snippet

    world = _world(session)
    mf = world["kept"]["media_file"].id

    unscored = Snippet(media_file_id=mf, start_ms=40_000, end_ms=40_500, source="manual")
    session.add(unscored)
    session.flush()
    session.expire(unscored)
    assert unscored.quality_score is None
    assert unscored.viral_score is None

    # A real score still goes in, 0.0 among them, and reads back as itself
    # rather than as NULL.
    unscored.quality_score = 0.0
    unscored.viral_score = 0.75
    session.flush()
    session.expire(unscored)
    assert unscored.quality_score == 0.0
    assert unscored.viral_score == 0.75

    # And the columns really are nullable in the database, not merely unset
    # on these rows.
    nullable = dict(
        session.execute(
            text(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'snippets' "
                "AND column_name IN ('quality_score', 'viral_score', 'generator', 'source')"
            )
        ).all()
    )
    assert nullable == {
        "quality_score": "YES", "viral_score": "YES", "generator": "YES", "source": "NO",
    }


@realdb
def test_the_timeline_index_on_file_and_start_exists_in_that_order(session):
    """One file's clips in playback order. Column ORDER is the point: an
    index on (start_ms, media_file_id) would not serve that read, so the
    order is asserted rather than the mere presence of both names."""
    from sqlalchemy import text

    indexdef = session.execute(
        text(
            "SELECT indexdef FROM pg_indexes "
            "WHERE tablename = 'snippets' AND indexname = :n"
        ),
        {"n": "ix_snippets_media_file_id_start_ms"},
    ).scalar()
    assert indexdef, "ix_snippets_media_file_id_start_ms is missing"
    # Read the parenthesised column list, not the whole statement: the index
    # NAME contains both column names too.
    columns = re.search(r"\(([^)]*)\)\s*$", indexdef).group(1)
    assert [c.strip() for c in columns.split(",")] == ["media_file_id", "start_ms"]
