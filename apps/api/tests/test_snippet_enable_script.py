"""scripts/snippet_enable_project.py, against a real database.

SQLite with foreign keys on and every model built by `create_all` -- the
same setup as test_snippet_pipeline.py, and for the same reason: this
script's whole job is reading and writing rows, so a mocked session would
only prove that the mock was called.

`main(argv)` is driven end to end, with `SessionLocal` pointed at the test
database, so what is measured is what an operator gets: the exit code, what
was printed, and what is in the database afterwards.

Where SQLite differs from production it is called out at the test that
cares -- see test_a_speaker_already_in_the_roster_is_not_added_twice.
"""

import uuid

import pytest


# ── database ─────────────────────────────────────────────────────────────
#
# Identical to test_snippet_pipeline.py's fixtures. Kept here rather than
# shared, exactly as that file keeps them: a conftest fixture would apply
# the UUID/JSONB compile shims to every test in the suite, and they are
# only correct for a SQLite-only test.


@pytest.fixture
def engine(tmp_path):
    from sqlalchemy import create_engine, event
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles

    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401  -- registers every table

    eng = create_engine(f"sqlite:///{tmp_path / 'snippet.db'}")

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture
def Session(engine):
    from sqlalchemy.orm import sessionmaker
    return sessionmaker(bind=engine)


# ── the world ────────────────────────────────────────────────────────────


class World:
    pass


@pytest.fixture
def world(Session):
    """Two projects, a folder tree in the first, and five assets.

    project "Acme Interviews"
      Rushes/                 interview-a.mkv   (live, video)
      Rushes/Nested/          interview-b.mkv   (live, video)
      Rushes/                 deleted.mkv       (SOFT-DELETED)
      (root)                  outside.mkv       (live, video)
      (root)                  poster.png        (live, image, no media file)
    project "Other Project"
      Rushes/                 -                 (a same-named folder, to be refused)
    """
    from datetime import datetime, timezone

    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
        TranscriptionStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    w = World()
    w.Session = Session
    db = Session()

    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4().hex[:8]}@example.com",
                first_name="T", last_name="U", password_hash="x",
                status=UserStatus.active, role=UserGlobalRole.superuser)
    db.add(user)
    db.flush()

    acme = Project(id=uuid.uuid4(), name="Acme Interviews",
                   project_type=ProjectType.personal, created_by=user.id)
    other = Project(id=uuid.uuid4(), name="Other Project",
                    project_type=ProjectType.personal, created_by=user.id)
    db.add_all([acme, other])
    db.flush()

    folders = {}
    for key, name, project, parent in (
        ("rushes", "Rushes", acme, None),
        ("nested", "Nested", acme, "rushes"),
        ("other_rushes", "Rushes", other, None),
    ):
        f = Folder(id=uuid.uuid4(), project_id=project.id, name=name,
                   parent_id=folders[parent].id if parent else None, created_by=user.id)
        db.add(f)
        db.flush()
        folders[key] = f

    def _asset(name, folder_key, asset_type, with_media=True, deleted=False):
        asset = Asset(
            id=uuid.uuid4(), project_id=acme.id, name=name, asset_type=asset_type,
            created_by=user.id,
            folder_id=folders[folder_key].id if folder_key else None,
            transcription_enabled=True,
            deleted_at=datetime.now(timezone.utc) if deleted else None,
        )
        db.add(asset)
        db.flush()
        version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1,
                               processing_status=ProcessingStatus.ready, created_by=user.id)
        db.add(version)
        db.flush()
        media = None
        if with_media:
            file_type = FileType.image if asset_type is AssetType.image else FileType.video
            media = MediaFile(
                id=uuid.uuid4(), version_id=version.id, file_type=file_type,
                original_filename=name, mime_type="video/x-matroska",
                file_size_bytes=1, s3_key_raw=f"raw/{acme.id}/{asset.id}/original",
                transcription_status=TranscriptionStatus.not_started,
            )
            db.add(media)
            db.flush()
        return asset, media

    w.assets = {}
    w.media = {}
    for key, name, folder_key, kind, with_media, deleted in (
        ("a", "interview-a.mkv", "rushes", AssetType.video, True, False),
        ("b", "interview-b.mkv", "nested", AssetType.video, True, False),
        ("gone", "deleted.mkv", "rushes", AssetType.video, True, True),
        ("outside", "outside.mkv", None, AssetType.video, True, False),
        ("poster", "poster.png", None, AssetType.image, False, False),
    ):
        asset, media = _asset(name, folder_key, kind, with_media, deleted)
        w.assets[key] = asset.id
        w.media[key] = media.id if media is not None else None

    db.commit()
    # Read every id while the session is still open: commit expires each
    # instance, and closing detaches it, so `acme.id` after db.close() is a
    # DetachedInstanceError rather than a value.
    w.acme_id = acme.id
    w.other_id = other.id
    w.folders = {k: v.id for k, v in folders.items()}
    db.close()
    return w


@pytest.fixture
def run(world, monkeypatch, capsys):
    """Call main(argv) with SessionLocal pointed at the test database.

    Returns (exit_code, stdout, stderr).
    """
    from apps.api.scripts import snippet_enable_project as script

    monkeypatch.setattr(script, "SessionLocal", world.Session)

    def _run(*argv):
        code = script.main(list(argv))
        captured = capsys.readouterr()
        return code, captured.out, captured.err

    return _run


def settings_row(world):
    from apps.api.models.snippet import SnippetProjectSettings

    db = world.Session()
    try:
        return (
            db.query(SnippetProjectSettings)
            .filter(SnippetProjectSettings.project_id == world.acme_id)
            .first()
        )
    finally:
        db.close()


def speaker_names(world, project_id=None):
    from apps.api.models.snippet import SnippetSpeaker

    db = world.Session()
    try:
        return sorted(
            s.name for s in db.query(SnippetSpeaker)
            .filter(SnippetSpeaker.project_id == (project_id or world.acme_id))
        )
    finally:
        db.close()


# ── enable, then disable ─────────────────────────────────────────────────


def test_enable_creates_the_row_and_disable_leaves_the_rest_alone(world, run):
    """Disabling is not the same as un-configuring: the source folder, the
    aspect and the font survive it, so turning it back on does not need
    them all typed again."""
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable",
        "--folder-name", "Rushes", "--export-aspect", "4:5",
        "--retention-days", "7", "--caption-font", "Inter",
    )
    assert code == 0, err
    assert "(settings row created)" in out

    row = settings_row(world)
    assert row is not None
    assert row.enabled is True
    assert row.source_folder_id == world.folders["rushes"]
    assert row.export_aspect == "4:5"
    assert row.export_retention_days == 7
    assert row.caption_font == "Inter"

    code, out, err = run("--project-name", "Acme Interviews", "--disable")
    assert code == 0, err
    # The before -> after column shows the one thing that moved.
    assert "True  ->  False" in out

    row = settings_row(world)
    assert row.enabled is False
    assert row.source_folder_id == world.folders["rushes"]
    assert row.export_aspect == "4:5"
    assert row.export_retention_days == 7
    assert row.caption_font == "Inter"


def test_a_project_with_no_row_reads_as_disabled_and_is_not_written_to(world, run):
    """Reading settings must not create them: `--list-files` on an
    unconfigured project is the first thing an operator runs."""
    code, out, err = run("--project-name", "Acme Interviews")
    assert code == 0, err
    assert "(no settings row yet)" in out
    assert "Enabled" in out
    assert settings_row(world) is None


def test_a_flag_whose_value_equals_the_default_still_stores_the_row(world, run):
    """A read creates nothing; an explicit flag writes even when the value
    it asks for is what the project already behaves as. 9:16 IS the default,
    so this is the case where "has anything changed" and "was a change
    asked for" disagree."""
    assert settings_row(world) is None
    code, out, err = run("--project-name", "Acme Interviews", "--export-aspect", "9:16")
    assert code == 0, err
    row = settings_row(world)
    assert row is not None
    assert row.export_aspect == "9:16"


def test_retention_forever_stores_null_and_zero_days_is_refused(world, run):
    code, out, err = run("--project-name", "Acme Interviews", "--retention-forever")
    assert code == 0, err
    assert settings_row(world).export_retention_days is None
    assert "forever" in out

    # The CHECK constraint allows NULL or > 0; 0 has to be refused here
    # rather than reaching the database as an IntegrityError.
    code, out, err = run("--project-name", "Acme Interviews", "--retention-days", "0")
    assert code == 2
    assert "--retention-days must be 1 or more" in err
    assert settings_row(world).export_retention_days is None


def test_clear_folder_puts_the_whole_project_back_in_scope(world, run):
    run("--project-name", "Acme Interviews", "--enable", "--folder-name", "Rushes")
    assert settings_row(world).source_folder_id == world.folders["rushes"]

    code, out, err = run("--project-name", "Acme Interviews", "--clear-folder")
    assert code == 0, err
    assert settings_row(world).source_folder_id is None
    assert "(whole project)" in out


# ── naming things: never guess ───────────────────────────────────────────


def test_an_ambiguous_project_name_refuses_and_changes_nothing(world, run):
    """Two live projects of the same name: the script must list both and
    write to neither, because picking one writes the wrong project's
    settings."""
    from apps.api.models.project import Project, ProjectType

    db = world.Session()
    first = Project(id=uuid.uuid4(), name="Twin Project", project_type=ProjectType.personal)
    second = Project(id=uuid.uuid4(), name="twin project", project_type=ProjectType.personal)
    db.add_all([first, second])
    db.commit()
    first_id, second_id = first.id, second.id
    db.close()

    code, out, err = run("--project-name", "Twin Project", "--enable")
    assert code == 2
    assert "2 live projects are named 'Twin Project'" in err
    # Both candidates are offered, by id, so the operator can pick.
    assert str(first_id) in err
    assert str(second_id) in err

    from apps.api.models.snippet import SnippetProjectSettings

    db = world.Session()
    try:
        assert db.query(SnippetProjectSettings).count() == 0
    finally:
        db.close()


def test_a_project_name_that_matches_nothing_suggests_without_guessing(world, run):
    code, out, err = run("--project-name", "Acme", "--enable")
    assert code == 2
    # "Acme" is a prefix of a real project and still not an exact match.
    assert "No live project is named exactly 'Acme'" in err
    assert "Acme Interviews" in err
    assert settings_row(world) is None


def test_a_soft_deleted_project_cannot_be_configured(world, run):
    from datetime import datetime, timezone

    from apps.api.models.project import Project

    db = world.Session()
    db.query(Project).filter(Project.id == world.acme_id).update(
        {Project.deleted_at: datetime.now(timezone.utc)}
    )
    db.commit()
    db.close()

    code, out, err = run("--project-id", str(world.acme_id), "--enable")
    assert code == 2
    assert "No live project" in err
    assert settings_row(world) is None


def test_a_folder_of_another_project_is_refused(world, run):
    """A source folder outside the project puts every asset out of scope,
    so it is refused instead of stored."""
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable",
        "--folder-id", str(world.folders["other_rushes"]),
    )
    assert code == 2
    assert "belongs to project" in err
    assert str(world.other_id) in err
    # Not even the --enable landed: the plan is resolved before anything is
    # written, so a bad folder leaves no half-applied row.
    assert settings_row(world) is None


def test_a_folder_name_matching_nothing_in_this_project_is_refused(world, run):
    """"Rushes" exists -- in the OTHER project. By name it must not be
    found here."""
    from apps.api.models.folder import Folder

    db = world.Session()
    db.query(Folder).filter(Folder.id == world.folders["rushes"]).update(
        {Folder.name: "Renamed"}
    )
    db.commit()
    db.close()

    code, out, err = run("--project-name", "Acme Interviews", "--folder-name", "Rushes")
    assert code == 2
    assert "No live folder in 'Acme Interviews' is named exactly 'Rushes'" in err
    assert settings_row(world) is None


# ── speakers ─────────────────────────────────────────────────────────────


def test_a_speaker_already_in_the_roster_is_not_added_twice(world, run):
    """Same project, same name ignoring case = one speaker.

    ASCII names on purpose: SQLite's `lower()` only folds ASCII, so a test
    using "Odegaard" spelled with an O-umlaut here would measure SQLite's
    collation rather than the script's rule. Production is Postgres, whose
    `lower()` folds the rest.
    """
    code, out, err = run(
        "--project-name", "Acme Interviews", "--speaker", "Anna Example",
        "--speaker", "Ben Example",
    )
    assert code == 0, err
    assert speaker_names(world) == ["Anna Example", "Ben Example"]

    # Different case, extra whitespace, and a repeat inside one run.
    code, out, err = run(
        "--project-name", "Acme Interviews",
        "--speaker", "  anna   example  ", "--speaker", "ANNA EXAMPLE",
        "--speaker", "Cleo Example",
    )
    assert code == 0, err
    assert speaker_names(world) == ["Anna Example", "Ben Example", "Cleo Example"]
    # Reported under the spelling that is stored, not the one typed.
    assert "speaker 'Anna Example': already in the roster" in out
    assert "speaker 'Cleo Example': created" in out


def test_speakers_belong_to_their_own_project(world, run):
    run("--project-name", "Acme Interviews", "--speaker", "Anna Example")
    run("--project-name", "Other Project", "--speaker", "Anna Example")
    assert speaker_names(world) == ["Anna Example"]
    assert speaker_names(world, world.other_id) == ["Anna Example"]


def test_an_empty_speaker_name_is_refused(world, run):
    code, out, err = run("--project-name", "Acme Interviews", "--speaker", "   ")
    assert code == 2
    assert "--speaker must not be empty" in err
    assert speaker_names(world) == []


# ── dry run ──────────────────────────────────────────────────────────────


def test_dry_run_prints_the_change_and_writes_nothing(world, run):
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable", "--folder-name", "Rushes",
        "--export-aspect", "16:9", "--speaker", "Anna Example", "--dry-run",
    )
    assert code == 0, err
    assert "Nothing written" in out
    # It still shows what WOULD happen, including the resolved folder path.
    assert "False  ->  True" in out
    assert "Rushes" in out
    assert "speaker 'Anna Example': would create" in out

    assert settings_row(world) is None
    assert speaker_names(world) == []


def test_dry_run_on_an_existing_row_leaves_every_value_as_it_was(world, run):
    run("--project-name", "Acme Interviews", "--enable", "--retention-days", "9")
    before = settings_row(world)
    kept = (before.enabled, before.export_retention_days, before.export_aspect)

    code, out, err = run(
        "--project-name", "Acme Interviews", "--disable", "--retention-forever",
        "--export-aspect", "1:1", "--dry-run",
    )
    assert code == 0, err
    after = settings_row(world)
    assert (after.enabled, after.export_retention_days, after.export_aspect) == kept


def test_dry_run_still_refuses_a_folder_from_another_project(world, run):
    """--dry-run resolves and validates exactly as a real run does, so a bad
    argument is reported now rather than on the run that was meant to
    apply it."""
    code, out, err = run(
        "--project-name", "Acme Interviews", "--dry-run",
        "--folder-id", str(world.folders["other_rushes"]),
    )
    assert code == 2
    assert "belongs to project" in err


# ── listing files ────────────────────────────────────────────────────────


def _listed_asset_ids(out, world):
    return {key for key, asset_id in world.assets.items() if str(asset_id) in out}


def test_list_files_covers_the_whole_project_when_there_is_no_source_folder(world, run):
    code, out, err = run("--project-name", "Acme Interviews", "--list-files")
    assert code == 0, err
    # Everything live, wherever it sits -- including the image at the root.
    assert _listed_asset_ids(out, world) == {"a", "b", "outside", "poster"}
    assert "the whole project" in out


def test_list_files_excludes_a_soft_deleted_asset(world, run):
    code, out, err = run("--project-name", "Acme Interviews", "--list-files")
    assert code == 0, err
    assert str(world.assets["gone"]) not in out
    # And the row really is there to be excluded, so this is not passing by
    # the asset being absent.
    from apps.api.models.asset import Asset

    db = world.Session()
    try:
        assert db.query(Asset).filter(Asset.id == world.assets["gone"]).first() is not None
    finally:
        db.close()


def test_list_files_respects_the_source_folder_and_its_descendants(world, run):
    """Scope is the folder OR BELOW: the nested asset is in, the one at the
    project root is not."""
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable", "--folder-name", "Rushes",
        "--list-files",
    )
    assert code == 0, err
    assert _listed_asset_ids(out, world) == {"a", "b"}
    assert str(world.folders["rushes"]) in out


def test_list_files_narrows_to_the_nested_folder_alone(world, run):
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable", "--folder-name", "Nested",
        "--list-files",
    )
    assert code == 0, err
    assert _listed_asset_ids(out, world) == {"b"}


def test_list_files_shows_the_media_file_id_and_status_the_operator_needs(world, run):
    """The listing exists so snippet_set_track_speaker.py can be given a
    --media-file-id, so that id has to be in it."""
    code, out, err = run("--project-name", "Acme Interviews", "--list-files")
    assert code == 0, err
    assert str(world.media["a"]) in out
    assert "video" in out
    assert "not_started" in out
    # The image has no media file, and says so rather than printing None.
    assert "(no media file)" in out


def test_list_files_uses_the_planned_folder_even_on_a_dry_run(world, run):
    """The listing answers "what would this setting cover", so it follows
    the folder being proposed, not the one on the row."""
    code, out, err = run(
        "--project-name", "Acme Interviews", "--enable", "--folder-name", "Nested",
        "--list-files", "--dry-run",
    )
    assert code == 0, err
    assert _listed_asset_ids(out, world) == {"b"}
    assert settings_row(world) is None


def test_list_files_on_an_empty_scope_says_so(world, run):
    from apps.api.models.folder import Folder

    db = world.Session()
    empty = Folder(id=uuid.uuid4(), project_id=world.acme_id, name="Empty", created_by=None)
    db.add(empty)
    db.commit()
    empty_id = empty.id
    db.close()

    code, out, err = run(
        "--project-name", "Acme Interviews", "--folder-id", str(empty_id), "--list-files",
    )
    assert code == 0, err
    assert "No live assets in" in out


# ── arguments ────────────────────────────────────────────────────────────


def test_naming_a_project_is_required(world, run):
    with pytest.raises(SystemExit) as exc:
        run("--enable")
    assert exc.value.code == 2


def test_the_mutually_exclusive_pairs_are_enforced(world, run):
    for argv in (
        ("--project-name", "Acme Interviews", "--enable", "--disable"),
        ("--project-name", "Acme Interviews", "--clear-folder", "--folder-name", "Rushes"),
        ("--project-name", "Acme Interviews", "--retention-days", "5", "--retention-forever"),
        ("--project-id", str(uuid.uuid4()), "--project-name", "x"),
    ):
        with pytest.raises(SystemExit) as exc:
            run(*argv)
        assert exc.value.code == 2, argv


def test_only_the_six_supported_aspects_are_accepted(world, run):
    from apps.api.models.snippet import EXPORT_ASPECTS

    for aspect in EXPORT_ASPECTS:
        code, out, err = run("--project-name", "Acme Interviews", "--export-aspect", aspect)
        assert code == 0, err
        assert settings_row(world).export_aspect == aspect

    # argparse rejects anything else before a session is opened, so the
    # database cannot be reached with a value the CHECK would refuse.
    with pytest.raises(SystemExit) as exc:
        run("--project-name", "Acme Interviews", "--export-aspect", "2:3")
    assert exc.value.code == 2


def test_the_script_opens_no_file_of_its_own(world):
    """Rule 4 of the task: never print secrets, never touch a .env.

    Checked as a property of the source rather than at runtime -- a test
    that merely ran the script would pass whether or not the code path was
    reached. The only mentions of ".env" in the file are in prose saying it
    does not read one.
    """
    import ast
    import pathlib

    path = (
        pathlib.Path(__file__).resolve().parents[1] / "scripts" / "snippet_enable_project.py"
    )
    tree = ast.parse(path.read_text())

    called = {
        node.func.id for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "open" not in called

    attribute_calls = {
        node.func.attr for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    for forbidden in ("read_text", "read_bytes", "getenv", "load_dotenv"):
        assert forbidden not in attribute_calls, forbidden

    # Code, not prose: every ".env" in the file is inside the docstring.
    code_only = "\n".join(
        line for line in path.read_text().splitlines()
        if not line.lstrip().startswith("#")
    )
    body = code_only.split('"""', 2)[-1]
    assert ".env" not in body
