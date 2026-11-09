"""Hiding files from SocialSnippet: POST /projects/{id}/snippet/files/hide and
/unhide, the `hidden` mode of the Files list, and the one rule every other
read follows (models/snippet.visible_media_file_clause).

The world is test_snippet_api.py's. Every read and edit path gets its own
test that the hidden file is invisible there AND that the same call works
again after unhide: a hidden file must behave exactly like a missing one,
and hiding must cost nothing.

`db` runs on SQLite and Postgres; `pg` (search, suggest, the statement
count) on Postgres only, as in test_snippet_api.py. The migration chain is
read from the files and needs neither; its Postgres check skips without
TEST_DATABASE_URL.
"""
import ast
import re
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from .test_snippet_api import (  # noqa: F401  -- shared fixtures
    HAVE_PG, api, db, needs_pg, pg, pg_engine, world,
)
from .test_snippet_export import _make_export, _post as _post_export

VERSIONS = Path(__file__).resolve().parents[1] / "alembic" / "versions"
MIGRATION = VERSIONS / "add_snippet_hidden_assets.py"
REVISION = "add_snippet_hidden_assets"
PARENT = "add_snippet_edited_at"


# ── Helpers ────────────────────────────────────────────────────────────────


def _ids(*assets):
    return [str(a.id) for a in assets]


def hide(api, world, *assets, user=None, project=None, raw=None):
    project = project or world.A
    return api.as_(user or world.owner).post(
        f"/projects/{project.id}/snippet/files/hide",
        json={"asset_ids": raw if raw is not None else _ids(*assets)},
    )


def unhide(api, world, *assets, user=None, project=None, raw=None):
    project = project or world.A
    return api.as_(user or world.owner).post(
        f"/projects/{project.id}/snippet/files/unhide",
        json={"asset_ids": raw if raw is not None else _ids(*assets)},
    )


def _hide_ok(api, world, *assets):
    r = hide(api, world, *assets)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] == len(assets)


def _unhide_ok(api, world, *assets):
    r = unhide(api, world, *assets)
    assert r.status_code == 200, r.text
    assert r.json()["changed"] == len(assets)


def files(api, world, user=None, **params):
    r = api.as_(user or world.owner).get(f"/projects/{world.A.id}/snippet/files", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _results(r):
    return {i["asset_id"]: (i["changed"], i["reason"]) for i in r.json()["results"]}


# ═══ The migration and the model ═══════════════════════════════════════════


def _revisions() -> dict:
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


def test_the_migration_follows_edited_at_and_its_id_fits():
    tree = ast.parse(MIGRATION.read_text())
    values = {
        t.id: node.value.value
        for node in tree.body if isinstance(node, ast.Assign)
        for t in node.targets
        if isinstance(t, ast.Name) and isinstance(node.value, ast.Constant)
    }
    assert values["revision"] == REVISION
    assert values["down_revision"] == PARENT
    assert len(REVISION) <= 32, "alembic_version.version_num's default width"


def test_the_migration_is_the_one_head():
    revisions = _revisions()
    referenced = {p for parents in revisions.values() for p in parents}
    heads = sorted(r for r in revisions if r not in referenced)
    assert heads == [REVISION]


def test_the_migration_only_adds_and_downgrade_removes_it_all():
    src = MIGRATION.read_text()
    up = src[src.index("def upgrade"):src.index("def downgrade")]
    down = src[src.index("def downgrade"):]
    assert 'op.create_table(\n        "snippet_hidden_assets",' in up
    assert 'sa.ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True' in up
    assert 'sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True' in up
    assert '"ix_snippet_hidden_assets_project_id", "snippet_hidden_assets", ["project_id"]' in up
    for word in ("alter", "drop", "execute", "update", "delete"):
        assert word not in up.lower().replace("ondelete", ""), f"upgrade must only add ({word})"
    assert 'op.drop_index("ix_snippet_hidden_assets_project_id"' in down
    assert 'op.drop_table("snippet_hidden_assets")' in down


def test_the_model_matches_the_migration():
    from apps.api.models.snippet import SnippetHiddenAsset

    t = SnippetHiddenAsset.__table__
    assert [c.name for c in t.primary_key.columns] == ["asset_id"]
    fks = {fk.parent.name: (fk.column.table.name, fk.ondelete) for fk in t.foreign_keys}
    assert fks == {
        "asset_id": ("assets", "CASCADE"),
        "project_id": ("projects", "CASCADE"),
        "hidden_by": ("users", "SET NULL"),
    }
    assert t.c.hidden_by.nullable is True
    assert t.c.project_id.nullable is False and t.c.hidden_at.nullable is False
    assert any(ix.name == "ix_snippet_hidden_assets_project_id" for ix in t.indexes)


@needs_pg
def test_the_migrated_postgres_table_has_the_keys(pg):
    from sqlalchemy import text

    rules = dict(pg.execute(text("""
        SELECT kcu.column_name, rc.delete_rule
        FROM information_schema.referential_constraints rc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'snippet_hidden_assets'
    """)).all())
    assert rules == {"asset_id": "CASCADE", "project_id": "CASCADE", "hidden_by": "SET NULL"}
    assert pg.execute(text(
        "SELECT 1 FROM pg_indexes WHERE tablename = 'snippet_hidden_assets' "
        "AND indexname = 'ix_snippet_hidden_assets_project_id'"
    )).first() is not None


# ═══ Hide and unhide ═══════════════════════════════════════════════════════


@pytest.mark.parametrize("action", [hide, unhide])
def test_only_the_owner_or_a_superadmin_hides_and_unhides(db, world, api, action):
    for user, code in [(world.editor, 403), (world.reviewer, 403), (world.viewer, 403),
                       (world.outsider, 404), (None, 401)]:
        if user is None:
            r = api.as_(None).post(f"/projects/{world.A.id}/snippet/files/hide",
                                   json={"asset_ids": _ids(world.fresh)})
        else:
            r = action(api, world, world.fresh, user=user)
        assert r.status_code == code, (user and user.first_name, r.text)
    assert action(api, world, world.fresh, user=world.owner).status_code == 200
    assert action(api, world, world.fresh, user=world.admin).status_code == 200


@pytest.mark.parametrize("action", [hide, unhide])
def test_a_disabled_project_is_409_and_another_projects_is_404(db, world, api, action):
    assert action(api, world, world.c_asset, project=world.C).status_code == 409
    assert action(api, world, world.c_asset, project=world.C, user=world.outsider).status_code == 404
    # The owner of A is no member of B: B does not exist for them.
    assert action(api, world, world.b_asset, project=world.B).status_code == 404
    ghost = SimpleNamespace(id=uuid.uuid4())
    assert action(api, world, world.fresh, project=ghost).status_code == 404


def test_foreign_trashed_unknown_and_non_media_ids_are_not_hidden(db, world, api):
    from apps.api.models.asset import Asset, AssetType
    from apps.api.models.snippet import SnippetHiddenAsset

    image = Asset(project_id=world.A.id, name="Still.png", asset_type=AssetType.image,
                  created_by=world.owner.id)
    db.add(image)
    db.commit()
    unknown = uuid.uuid4()
    r = hide(api, world, raw=_ids(world.b_asset, world.gone, image) + [str(unknown)])
    assert r.status_code == 200
    assert r.json()["changed"] == 0
    assert _results(r) == {
        str(world.b_asset.id): (False, "not found"),
        str(world.gone.id): (False, "not found"),
        str(image.id): (False, "not video or audio"),
        str(unknown): (False, "not found"),
    }
    # A superadmin acting on B with A's asset: still not B's.
    r = hide(api, world, world.alpha, project=world.B, user=world.admin)
    assert _results(r) == {str(world.alpha.id): (False, "not found")}
    db.expire_all()
    assert db.query(SnippetHiddenAsset).count() == 0


def test_hide_and_unhide_are_idempotent_and_collapse_duplicates(db, world, api):
    from apps.api.models.snippet import SnippetHiddenAsset

    first = hide(api, world, raw=_ids(world.alpha, world.alpha, world.beta))
    assert first.json()["changed"] == 2
    assert [i["asset_id"] for i in first.json()["results"]] == _ids(world.alpha, world.beta)
    assert _results(first) == {str(world.alpha.id): (True, "hidden"),
                               str(world.beta.id): (True, "hidden")}
    again = hide(api, world, world.alpha, world.fresh)
    assert again.json()["changed"] == 1
    assert _results(again) == {str(world.alpha.id): (False, "already hidden"),
                               str(world.fresh.id): (True, "hidden")}
    db.expire_all()
    row = db.query(SnippetHiddenAsset).filter_by(asset_id=world.alpha.id).one()
    assert row.project_id == world.A.id and row.hidden_by == world.owner.id
    assert row.hidden_at is not None

    back = unhide(api, world, world.alpha, world.delta)
    assert _results(back) == {str(world.alpha.id): (True, "restored"),
                              str(world.delta.id): (False, "not hidden")}
    assert unhide(api, world, world.alpha).json() == {
        "changed": 0, "results": [{"asset_id": str(world.alpha.id), "changed": False,
                                   "reason": "not hidden"}],
    }
    db.expire_all()
    assert {r.asset_id for r in db.query(SnippetHiddenAsset)} == {world.beta.id, world.fresh.id}


def test_hide_takes_one_to_a_hundred(db, world, api):
    assert hide(api, world, raw=[]).status_code == 422
    assert hide(api, world, raw=[str(uuid.uuid4()) for _ in range(101)]).status_code == 422
    assert unhide(api, world, raw=[]).status_code == 422
    assert unhide(api, world, raw=[str(uuid.uuid4()) for _ in range(101)]).status_code == 422
    assert hide(api, world, raw=[str(uuid.uuid4()) for _ in range(100)]).status_code == 200
    assert hide(api, world, raw=["not-a-uuid"]).status_code == 422


def test_hiding_deletes_nothing_and_unhiding_restores_exactly(db, world, api):
    from apps.api.models.snippet import (
        Snippet, SnippetJob, SnippetTrackSpeaker, TranscriptSegment, TranscriptWord,
    )
    from apps.api.models.snippet_export import SnippetExport

    _make_export(db, world)
    db.add(SnippetJob(media_file_id=world.alpha_mf.id, stage="store", status="done"))
    db.commit()

    def snapshot():
        db.expire_all()
        mf = world.alpha_mf.id
        segs = db.query(TranscriptSegment).filter_by(media_file_id=mf).all()
        return {
            "segments": sorted((s.id, s.text_current, s.speaker_id) for s in segs),
            "words": db.query(TranscriptWord)
            .filter(TranscriptWord.segment_id.in_([s.id for s in segs])).count(),
            "snippets": sorted(
                (s.id, s.title, s.status.value, s.start_ms, s.end_ms, s.user_edited_at)
                for s in db.query(Snippet).filter_by(media_file_id=mf)
            ),
            "jobs": sorted((j.stage, j.status.value) for j in db.query(SnippetJob).filter_by(media_file_id=mf)),
            "tracks": sorted((t.track_index, t.speaker_id)
                             for t in db.query(SnippetTrackSpeaker).filter_by(media_file_id=mf)),
            "exports": sorted((e.id, e.status, e.s3_key) for e in db.query(SnippetExport)),
        }

    before = snapshot()
    assert before["segments"] and before["words"] and before["snippets"] and before["exports"]
    _hide_ok(api, world, world.alpha)
    assert snapshot() == before
    _unhide_ok(api, world, world.alpha)
    assert snapshot() == before


# ═══ The Files list ════════════════════════════════════════════════════════


def test_the_files_list_modes_and_their_totals(db, world, api):
    every = files(api, world)
    assert every["total"] == 4 and all(i["hidden"] is False for i in every["items"])
    alpha_before = next(i for i in every["items"] if i["asset_id"] == str(world.alpha.id))

    _hide_ok(api, world, world.alpha, world.beta)
    shown = files(api, world)
    assert shown["total"] == 2
    assert {i["name"] for i in shown["items"]} == {"Delta.mov", "Fresh.wav"}
    assert files(api, world, hidden="exclude") == shown

    both = files(api, world, hidden="include")
    assert both["total"] == 4
    assert {i["name"]: i["hidden"] for i in both["items"]} == {
        "Alpha.mov": True, "Beta.wav": True, "Delta.mov": False, "Fresh.wav": False,
    }
    # The one read that still reaches a hidden file's rows: its real counts.
    alpha = next(i for i in both["items"] if i["asset_id"] == str(world.alpha.id))
    assert {k: v for k, v in alpha.items() if k != "hidden"} == \
        {k: v for k, v in alpha_before.items() if k != "hidden"}
    assert alpha["segment_count"] == 6 and alpha["snippet_count"] == 1

    only = files(api, world, hidden="only")
    assert only["total"] == 2 and {i["name"] for i in only["items"]} == {"Alpha.mov", "Beta.wav"}
    assert all(i["hidden"] for i in only["items"])
    # The mode combines with the name search and with paging.
    assert files(api, world, hidden="only", q="alp")["total"] == 1
    paged = files(api, world, hidden="include", page_size=3, page=2)
    assert paged["total"] == 4 and len(paged["items"]) == 1

    # An editor reads every mode (the list is editor and up); a viewer none.
    assert files(api, world, user=world.editor, hidden="only")["total"] == 2
    r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/files", params={"hidden": "only"})
    assert r.status_code == 403
    r = api.as_(world.owner).get(f"/projects/{world.A.id}/snippet/files", params={"hidden": "all"})
    assert r.status_code == 422

    _unhide_ok(api, world, world.alpha, world.beta)
    assert files(api, world) == every
    assert files(api, world, hidden="only") == {"total": 0, "items": []}


def test_the_files_list_statement_count_does_not_depend_on_hidden_files(db, world, api):
    from sqlalchemy import event

    engine = db.get_bind().engine

    def count(**params):
        statements = []

        def _on(conn, cursor, statement, *a):
            if not statement.lstrip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
                statements.append(statement)

        event.listen(engine, "before_cursor_execute", _on)
        try:
            files(api, world, **params)
        finally:
            event.remove(engine, "before_cursor_execute", _on)
        return len(statements)

    baseline = {mode: count(hidden=mode) for mode in ("exclude", "include")}
    _hide_ok(api, world, world.alpha, world.beta)
    assert {mode: count(hidden=mode) for mode in baseline} == baseline


# ═══ Every other path: invisible while hidden, back after unhide ═══════════


def test_tracks_list(db, world, api):
    url = f"/media-files/{world.alpha_mf.id}/snippet/tracks"
    before = api.as_(world.viewer).get(url)
    assert before.status_code == 200
    _hide_ok(api, world, world.alpha)
    for user in (world.viewer, world.editor, world.owner, world.admin):
        assert api.as_(user).get(url).status_code == 404
    _unhide_ok(api, world, world.alpha)
    assert api.as_(world.viewer).get(url).json() == before.json()


def test_transcript_range(db, world, api):
    url = f"/media-files/{world.alpha_mf.id}/snippet/transcript"
    before = api.as_(world.viewer).get(url, params={"from_ms": 0, "to_ms": 30_000})
    assert before.status_code == 200 and before.json()["segments"]
    _hide_ok(api, world, world.alpha)
    r = api.as_(world.owner).get(url, params={"from_ms": 0, "to_ms": 30_000})
    assert r.status_code == 404 and r.json()["detail"] == "Media file not found"
    _unhide_ok(api, world, world.alpha)
    assert api.as_(world.viewer).get(url, params={"from_ms": 0, "to_ms": 30_000}).json() == before.json()


def test_clip_edit(db, world, api):
    from apps.api.models.snippet import Snippet

    url = f"/snippets/{world.SC.id}"
    _hide_ok(api, world, world.alpha)
    r = api.as_(world.editor).patch(url, json={"title": "Renamed while hidden"})
    assert r.status_code == 404 and r.json()["detail"] == "Snippet not found"
    db.expire_all()
    assert db.query(Snippet).filter_by(id=world.SC.id).one().title == "River talk"
    _unhide_ok(api, world, world.alpha)
    r = api.as_(world.editor).patch(url, json={"title": "Renamed after"})
    assert r.status_code == 200 and r.json()["title"] == "Renamed after"


def test_speaker_put(db, world, api):
    from apps.api.models.snippet import SnippetTrackSpeaker

    url = f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker"
    _hide_ok(api, world, world.alpha)
    assert api.as_(world.editor).put(url, json={"speaker_id": str(world.ben.id)}).status_code == 404
    db.expire_all()
    assert db.query(SnippetTrackSpeaker).filter_by(media_file_id=world.alpha_mf.id,
                                                   track_index=1).first() is None
    _unhide_ok(api, world, world.alpha)
    r = api.as_(world.editor).put(url, json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200, r.text
    assert r.json()["speaker_id"] == str(world.ben.id)


def test_export_post_for_a_snippet_and_a_moment(db, world, api):
    _hide_ok(api, world, world.alpha)
    r, send = _post_export(api, world, world.editor, world.SC.id)
    assert r.status_code == 404 and r.json()["detail"] == "Snippet not found"
    moment = f"moment:{world.alpha_mf.id}:6000"
    r2, send2 = _post_export(api, world, world.editor, moment, end_ms=16_000)
    assert r2.status_code == 404 and r2.json()["detail"] == "Snippet not found"
    assert not send.called and not send2.called

    _unhide_ok(api, world, world.alpha)
    r, send = _post_export(api, world, world.editor, world.SC.id)
    assert r.status_code == 202, r.text
    r2, _ = _post_export(api, world, world.editor, moment, end_ms=16_000)
    assert r2.status_code == 202, r2.text


def test_an_existing_export_stays_readable_and_downloadable(db, world, api):
    row = _make_export(db, world)
    before = api.as_(world.viewer).get(f"/exports/{row.id}")
    assert before.status_code == 200 and before.json()["download_url"]
    _hide_ok(api, world, world.alpha)
    during = api.as_(world.viewer).get(f"/exports/{row.id}")
    assert during.status_code == 200
    assert during.json()["status"] == "done" and during.json()["download_url"]
    _unhide_ok(api, world, world.alpha)
    assert api.as_(world.viewer).get(f"/exports/{row.id}").status_code == 200


def test_process_skips_a_hidden_file(db, world, api):
    url = f"/projects/{world.A.id}/snippet/process"
    _hide_ok(api, world, world.fresh)
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               side_effect=lambda a, v: SimpleNamespace(id=f"task-{a}")) as delay:
        r = api.as_(world.owner).post(url, json={"asset_ids": _ids(world.fresh, world.delta)})
    assert r.status_code == 200
    out = {i["asset_id"]: (i["queued"], i["reason"]) for i in r.json()["results"]}
    assert out == {str(world.fresh.id): (False, "hidden"), str(world.delta.id): (True, "queue")}
    assert [c.args[0] for c in delay.call_args_list] == [str(world.delta.id)]

    _unhide_ok(api, world, world.fresh)
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t")):
        r = api.as_(world.owner).post(url, json={"asset_ids": _ids(world.fresh)})
    assert r.json()["results"][0] == {"asset_id": str(world.fresh.id), "queued": True, "reason": "queue"}


def test_detect_skips_a_hidden_file_and_runs_again_after_unhide(db, world, api):
    from apps.api.models.snippet import Snippet, SnippetJob
    from apps.api.scripts.snippet_detect import find_targets
    from apps.api.tasks.transcribe_tasks import (
        DETECT_SKIPPED_HIDDEN, SNIPPET_STAGE_DETECT, _stage_detect,
    )

    def clips():
        db.expire_all()
        return sorted((s.id, s.source, s.status.value, s.start_ms, s.end_ms)
                      for s in db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id))

    def job():
        db.expire_all()
        j = db.query(SnippetJob).filter_by(media_file_id=world.alpha_mf.id,
                                          stage=SNIPPET_STAGE_DETECT).one()
        return j.status.value, j.error

    def target():
        return next(t for t in find_targets(db, project_id=world.A.id)
                    if t.asset_id == str(world.alpha.id))

    before = clips()
    _hide_ok(api, world, world.alpha)
    result = _stage_detect(db, world.alpha_mf.id)
    assert result == {"removed": 0, "created": 0, "skipped": 0, "tracks": [], "hidden": True}
    assert clips() == before
    assert job() == ("done", DETECT_SKIPPED_HIDDEN)
    assert target().reason == "hidden from SocialSnippet"

    _unhide_ok(api, world, world.alpha)
    result = _stage_detect(db, world.alpha_mf.id)
    assert "hidden" not in result and result["tracks"] == [0, 1]
    assert job() == ("done", None)
    assert target().reason == "detect"


# ── Search and suggest (Postgres) ──────────────────────────────────────────


def search(api, world, **params):
    r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/search", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def _clip_ids(body):
    return [i["id"] for g in body["groups"] for i in g["items"]]


def _assets_in(body):
    return {i["asset_id"] for g in body["groups"] for i in g["items"]}


@needs_pg
def test_search(pg, world, api):
    queries = [{}, {"q": "glacier"}, {"q": "rivers"}, {"topic": "Rivers"},
               {"speaker_id": str(world.anna.id)}, {"status": ["rejected"]}, {"q": "volcano"}]
    before = [_clip_ids(search(api, world, **p)) for p in queries]
    assert str(world.SC.id) in before[0]
    assert any(i.startswith(f"moment:{world.alpha_mf.id}:") for i in before[1])

    _hide_ok(api, world, world.alpha, world.beta)
    for p in queries:
        body = search(api, world, **p)
        assert not _assets_in(body) & {str(world.alpha.id), str(world.beta.id)}, p
    assert search(api, world, q="glacier")["total"] == 0, "no transcript hit of a hidden file"
    assert search(api, world, topic="Rivers")["total"] == 0
    assert search(api, world, q="volcano")["total"] == 0
    assert str(world.BR.id) not in _clip_ids(search(api, world, status=["rejected"]))
    assert str(world.D4.id) in _clip_ids(search(api, world, status=["rejected"])), "others stay"

    _unhide_ok(api, world, world.alpha, world.beta)
    assert [_clip_ids(search(api, world, **p)) for p in queries] == before


@needs_pg
def test_suggest(pg, world, api):
    def suggest(q=""):
        r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/suggest", params={"q": q})
        assert r.status_code == 200
        return r.json()

    before, before_r = suggest(), suggest("riv")
    assert "Rivers" in [t["topic"] for t in before["topics"]]
    assert "Anna Example" in [n["name"] for n in before["names"]]

    _hide_ok(api, world, world.alpha, world.delta)
    # Every usable clip of project A was on these two files.
    assert suggest() == {"names": [], "topics": []}
    assert suggest("riv") == {"names": [], "topics": []}

    _unhide_ok(api, world, world.alpha, world.delta)
    assert suggest() == before and suggest("riv") == before_r


@needs_pg
def test_search_statement_count_is_the_same_with_hidden_files(pg, world, api):
    from sqlalchemy import event

    def count(**params):
        statements = []

        def _on(conn, cursor, statement, *a):
            if not statement.lstrip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
                statements.append(statement)

        event.listen(pg.get_bind().engine, "before_cursor_execute", _on)
        try:
            search(api, world, **params)
        finally:
            event.remove(pg.get_bind().engine, "before_cursor_execute", _on)
        return len(statements)

    # Searches whose results stay non-empty: a search with no hits at all
    # skips the file lookup, which would change the count for another reason.
    cases = [{}, {"q": "glacier"}, {"q": "rivers"}, {"group": "topic"}, {"group": "speaker"}]
    baseline = [count(**p) for p in cases]
    _hide_ok(api, world, world.delta, world.beta)
    assert [count(**p) for p in cases] == baseline
    _hide_ok(api, world, world.fresh)
    assert [count(**p) for p in cases] == baseline


def test_the_visible_rule_is_one_exists_with_no_extra_join():
    """The hidden check sits inside the live rule's own EXISTS; nothing is
    joined into the caller's query."""
    from sqlalchemy import select
    from sqlalchemy.dialects import postgresql

    from apps.api.models.snippet import Snippet

    def sql(clause):
        return str(select(Snippet.id).where(clause).compile(dialect=postgresql.dialect()))

    live, visible = sql(Snippet.live_clause()), sql(Snippet.visible_clause())
    assert live.count("EXISTS") == visible.count("EXISTS") == 1
    assert "snippet_hidden_assets" not in live
    assert visible.count("FROM snippet_hidden_assets") == 1 and "NOT IN" in visible
    assert visible.split("WHERE", 1)[0].strip().endswith("FROM snippets")
