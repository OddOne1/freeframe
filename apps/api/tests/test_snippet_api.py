"""SocialSnippet HTTP API (routers/snippet.py), against a real database.

Two databases, and each test says which it needs:

* `db` is parametrised over SQLite (every model by `create_all`, foreign
  keys on, the SQLite shims in models/snippet.py) AND Postgres. It runs the
  tests that do not touch full-text search: permissions per role, 404 / 409
  / 422, settings, speakers, tracks, processing, the transcript range and
  clip edits.
* `pg` is Postgres only, for everything that needs `tsvector`, `unnest` or
  `pg_trgm`: search, suggest and moments. The SQLite shims cannot do any of
  that -- on SQLite `search_vector` is a plain copy of the text.

Postgres tests skip without TEST_DATABASE_URL:

    docker run -d --name ffsnipapi-pg -e POSTGRES_USER=freeframe \\
      -e POSTGRES_PASSWORD=freeframe -e POSTGRES_DB=freeframe \\
      -p 55476:5432 postgres:15
    (cd apps/api && DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55476/freeframe \\
      alembic upgrade head)
    TEST_DATABASE_URL=postgresql://freeframe:freeframe@127.0.0.1:55476/freeframe \\
      pytest apps/api/tests/test_snippet_api.py

The Postgres schema comes from the migrations (so the generated column and
the GIN index are the real ones), and every test runs in one outer
transaction that is rolled back: the routes' own commits release savepoints
inside it, and the database is left exactly as it was found.

The app is the real one; only `get_db` (this test's session) and
`get_current_user` (whoever the test is acting as) are overridden.
"""
import os
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

PG_URL = os.environ.get("TEST_DATABASE_URL")
HAVE_PG = bool(PG_URL and PG_URL.startswith("postgresql"))
needs_pg = pytest.mark.skipif(not HAVE_PG, reason="needs TEST_DATABASE_URL pointing at a migrated Postgres")


# ── Databases ──────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def pg_engine():
    if not HAVE_PG:
        pytest.skip("needs TEST_DATABASE_URL pointing at a migrated Postgres")
    from sqlalchemy import create_engine

    eng = create_engine(PG_URL)
    yield eng
    eng.dispose()


def _pg_session(engine):
    from sqlalchemy.orm import Session

    conn = engine.connect()
    outer = conn.begin()
    s = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)

    def close():
        s.close()
        outer.rollback()
        conn.close()

    return s, close


def _sqlite_session(tmp_path):
    from sqlalchemy import create_engine, event
    from sqlalchemy.dialects.postgresql import JSONB, UUID
    from sqlalchemy.ext.compiler import compiles
    from sqlalchemy.orm import Session

    @compiles(UUID, "sqlite")
    def _uuid_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "CHAR(36)"

    @compiles(JSONB, "sqlite")
    def _jsonb_sqlite(element, compiler, **kw):  # noqa: ARG001
        return "TEXT"

    from apps.api.database import Base
    import apps.api.models  # noqa: F401  -- registers every table

    # check_same_thread off: TestClient runs the app in its own thread, and
    # the route uses this test's session (one connection, used in turn).
    eng = create_engine(f"sqlite:///{tmp_path / 'snippet_api.db'}",
                        connect_args={"check_same_thread": False})

    @event.listens_for(eng, "connect")
    def _fk_on(dbapi_conn, _rec):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    Base.metadata.create_all(eng)
    s = Session(bind=eng, expire_on_commit=False)

    def close():
        s.close()
        eng.dispose()

    return s, close


@pytest.fixture(params=["sqlite", "postgres"])
def db(request, tmp_path):
    if request.param == "postgres":
        if not HAVE_PG:
            pytest.skip("needs TEST_DATABASE_URL pointing at a migrated Postgres")
        engine = request.getfixturevalue("pg_engine")
        s, close = _pg_session(engine)
    else:
        s, close = _sqlite_session(tmp_path)
    yield s
    close()


@pytest.fixture
def pg(pg_engine):
    s, close = _pg_session(pg_engine)
    yield s
    close()


def _session_of(request):
    return request.getfixturevalue("pg" if "pg" in request.fixturenames else "db")


# ── The world ──────────────────────────────────────────────────────────────

WORD_MS, GAP_MS = 500, 100


def _words(start_ms, text):
    """Each word 500 ms long, 100 ms apart, from start_ms."""
    out = []
    for i, w in enumerate(text.split()):
        s = start_ms + i * (WORD_MS + GAP_MS)
        out.append((s, s + WORD_MS, w))
    return out


def build_world(s):
    """Three projects, six users, seven files.

    Project A (SocialSnippet on), members owner/editor/reviewer/viewer:
      Alpha.mov  video, 120 s, two recorded audio tracks. Track 0 (Anna),
                 one sentence per segment:
                   0     "Welcome to the show today."
                   3000  "We talk about rivers."
                   6000  "The glacier melts every summer."
                   9000  "Nobody expected that."
                   11000 "Thanks for listening."
                 Track 1 (unmapped): "Second microphone here." at 20 s.
                 Snippet SC 2500-5500 "River talk" (manual, unscored).
      Delta.mov  video, 60 s, no transcript. Snippets D1-D4 for sorting,
                 grouping and filtering (D4 rejected).
      Beta.wav   audio, 90 s. One 35.9 s sentence (Ben) with "volcano" as
                 word 55; snippet BR at its start, rejected.
      Fresh.wav  audio, 30 s, no transcript.
      Gone.mov   video, SOFT-DELETED: transcript "The glacier phantom
                 speaks." (Ghost) and snippet G1 (Ghost, topic Phantom).
    Project B (on): `outsider` is its owner. One file, one snippet.
    Project C (off): owner and viewer. One file, transcript and snippet.
    `admin` is a superadmin and a member of nothing.
    """
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.models.project import Project, ProjectMember, ProjectRole
    from apps.api.models.snippet import (
        Snippet, SnippetProjectSettings, SnippetSpeaker, SnippetStatus,
        SnippetTrackSpeaker, TranscriptSegment, TranscriptWord,
    )
    from apps.api.models.user import User, UserGlobalRole

    tag = uuid.uuid4().hex[:8]
    w = SimpleNamespace()

    def user(key, role=UserGlobalRole.superuser):
        u = User(email=f"{key}-{tag}@ff-snippet-api.test", first_name=key.title(),
                 last_name="Test", role=role)
        s.add(u)
        s.flush()
        setattr(w, key, u)

    for key in ("owner", "editor", "reviewer", "viewer", "outsider"):
        user(key)
    user("admin", UserGlobalRole.superadmin)

    def project(key, enabled, members):
        p = Project(name=f"SNIPAPI-{key}-{tag}", created_by=w.owner.id)
        s.add(p)
        s.flush()
        for u, role in members:
            s.add(ProjectMember(project_id=p.id, user_id=u.id, role=role))
        s.add(SnippetProjectSettings(project_id=p.id, enabled=enabled))
        s.flush()
        return p

    w.A = project("A", True, [(w.owner, ProjectRole.owner), (w.editor, ProjectRole.editor),
                              (w.reviewer, ProjectRole.reviewer), (w.viewer, ProjectRole.viewer)])
    w.B = project("B", True, [(w.outsider, ProjectRole.owner)])
    w.C = project("C", False, [(w.owner, ProjectRole.owner), (w.viewer, ProjectRole.viewer)])

    def speaker(p, name):
        sp = SnippetSpeaker(project_id=p.id, name=name)
        s.add(sp)
        s.flush()
        return sp

    w.anna = speaker(w.A, "Anna Example")
    w.ben = speaker(w.A, "Ben")
    w.ghost = speaker(w.A, "Ghost")
    w.carl = speaker(w.B, "Carl")

    def media(p, name, kind, duration_s, deleted=False, streams=None):
        video = kind == "video"
        a = Asset(project_id=p.id, name=name, asset_type=AssetType.video if video else AssetType.audio,
                  created_by=w.owner.id)
        s.add(a)
        s.flush()
        # Ready: every file here has finished its own processing, which
        # POST /snippet/process requires.
        v = AssetVersion(asset_id=a.id, version_number=1, processing_status=ProcessingStatus.ready)
        s.add(v)
        s.flush()
        mf = MediaFile(
            version_id=v.id, file_type=FileType.video if video else FileType.audio,
            original_filename=name, mime_type="video/quicktime" if video else "audio/wav",
            file_size_bytes=1, s3_key_raw=f"raw/{p.id}/{a.id}/{v.id}/original",
            s3_key_processed=(f"processed/{a.id}/{v.id}/hls" if video
                              else f"processed/{a.id}/{v.id}/audio.mp3"),
            s3_key_thumbnail=(f"thumbs/{a.id}/{v.id}/thumb.jpg" if video
                              else f"thumbs/{a.id}/{v.id}/waveform.json"),
            duration_seconds=duration_s,
            technical_metadata={"audio_streams": streams} if streams is not None else None,
        )
        s.add(mf)
        s.flush()
        if deleted:
            a.deleted_at = datetime.now(timezone.utc)
            s.flush()
        return a, mf

    w.alpha, w.alpha_mf = media(w.A, "Alpha.mov", "video", 120.0, streams=[
        {"audio_index": 0, "channels": 1, "title": "Lav Anna", "language": "de"},
        {"audio_index": 1, "channel_layout": "stereo"},
    ])
    w.delta, w.delta_mf = media(w.A, "Delta.mov", "video", 60.0)
    w.beta, w.beta_mf = media(w.A, "Beta.wav", "audio", 90.0)
    w.fresh, w.fresh_mf = media(w.A, "Fresh.wav", "audio", 30.0)
    w.gone, w.gone_mf = media(w.A, "Gone.mov", "video", 60.0, deleted=True)
    w.b_asset, w.b_mf = media(w.B, "Other.mov", "video", 60.0)
    w.c_asset, w.c_mf = media(w.C, "Off.mov", "video", 60.0)

    def transcript(mf, track, speaker_obj, segments):
        rows = []
        for seq, (start, text) in enumerate(segments):
            words = _words(start, text)
            seg = TranscriptSegment(
                media_file_id=mf.id, track_index=track,
                speaker_id=speaker_obj.id if speaker_obj else None, seq=seq,
                start_ms=words[0][0], end_ms=words[-1][1], language="en",
                text_ai=text, text_current=text,
            )
            s.add(seg)
            s.flush()
            for idx, (ws, we, word) in enumerate(words):
                s.add(TranscriptWord(segment_id=seg.id, idx=idx, start_ms=ws, end_ms=we, word=word))
            rows.append(seg)
        s.flush()
        return rows

    w.alpha_segments = transcript(w.alpha_mf, 0, w.anna, [
        (0, "Welcome to the show today."),
        (3000, "We talk about rivers."),
        (6000, "The glacier melts every summer."),
        (9000, "Nobody expected that."),
        (11000, "Thanks for listening."),
    ])
    w.alpha_track1 = transcript(w.alpha_mf, 1, None, [(20000, "Second microphone here.")])
    s.add(SnippetTrackSpeaker(media_file_id=w.alpha_mf.id, track_index=0, speaker_id=w.anna.id))
    transcript(w.beta_mf, 0, w.ben,
               [(0, " ".join(["word"] * 55 + ["volcano", "erupts", "very", "loudly", "now."]))])
    transcript(w.gone_mf, 0, w.ghost, [(0, "The glacier phantom speaks.")])
    transcript(w.c_mf, 0, None, [(0, "Disabled project glacier text.")])

    def snippet(mf, start, end, **kw):
        sn = Snippet(media_file_id=mf.id, start_ms=start, end_ms=end, **kw)
        s.add(sn)
        s.flush()
        return sn

    w.SC = snippet(w.alpha_mf, 2500, 5500, speaker_id=w.anna.id, title="River talk",
                   topics=["Rivers"], source="manual", generator="hand")
    w.D1 = snippet(w.delta_mf, 0, 10000, speaker_id=w.anna.id, title="Clean power",
                   quote="We need clean energy.", topics=["Climate", "Energy"],
                   quality_score=0.9, source="keyword", generator="tfidf-v1")
    w.D2 = snippet(w.delta_mf, 10000, 40000, speaker_id=w.ben.id, title="Warming",
                   topics=["climate"], viral_score=0.8, source="llm", generator="claude",
                   status=SnippetStatus.approved)
    w.D3 = snippet(w.delta_mf, 40000, 45000, title="Odds and ends", topics=[],
                   quality_score=0.5, viral_score=0.2, source="import")
    w.D4 = snippet(w.delta_mf, 45000, 50000, speaker_id=w.anna.id, title="Cut this",
                   topics=["Energy"], quality_score=1.0, status=SnippetStatus.rejected)
    w.BR = snippet(w.beta_mf, 0, 10000, speaker_id=w.ben.id, title="Rejected audio",
                   status=SnippetStatus.rejected)
    w.G1 = snippet(w.gone_mf, 0, 3000, speaker_id=w.ghost.id, title="Phantom clip",
                   topics=["Phantom"])
    w.B1 = snippet(w.b_mf, 0, 5000, speaker_id=w.carl.id, title="Other project clip")
    w.C1 = snippet(w.c_mf, 0, 5000, title="Disabled project clip")
    s.commit()
    return w


# ── The app ────────────────────────────────────────────────────────────────


@pytest.fixture
def api(request):
    """A TestClient on the real app, bound to the test's session.

    `api.as_(user)` sets who the next requests come from (None: nobody).
    """
    session = _session_of(request)

    from fastapi import HTTPException
    from fastapi.testclient import TestClient

    from apps.api.database import get_db
    from apps.api.main import app
    from apps.api.middleware import setup_guard
    from apps.api.middleware.auth import get_current_user

    current = {"user": None}

    def _current_user():
        if current["user"] is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        return current["user"]

    app.dependency_overrides[get_db] = lambda: session
    app.dependency_overrides[get_current_user] = _current_user
    # The setup guard and the rate limiter reach for the real database and
    # Redis; both fail open, but asking costs a connection attempt per request.
    with patch.object(setup_guard, "_setup_complete", True), \
         patch("apps.api.middleware.global_rate_limit.GlobalRateLimitMiddleware._check",
               return_value=(True, 0)):
        client = TestClient(app, raise_server_exceptions=True)

        def as_(user):
            current["user"] = user
            return client

        client.as_ = as_
        yield client
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(get_current_user, None)


@pytest.fixture
def world(request):
    return build_world(_session_of(request))


def ids(items):
    return [i["id"] for i in items]


def all_items(body):
    return [item for g in body["groups"] for item in g["items"]]


# ═══ Both databases ════════════════════════════════════════════════════════

# ── Settings ───────────────────────────────────────────────────────────────


def test_settings_read_by_any_member_and_hidden_from_outsiders(db, world, api):
    r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/settings")
    assert r.status_code == 200
    assert r.json() == {"enabled": True, "source_folder_id": None, "export_retention_days": 30,
                        "export_aspect": "9:16", "caption_font": None}
    assert api.as_(world.outsider).get(f"/projects/{world.A.id}/snippet/settings").status_code == 404
    assert api.as_(world.owner).get(f"/projects/{uuid.uuid4()}/snippet/settings").status_code == 404
    assert api.as_(world.admin).get(f"/projects/{world.A.id}/snippet/settings").status_code == 200


def test_only_the_owner_or_a_superadmin_changes_settings(db, world, api):
    url = f"/projects/{world.C.id}/snippet/settings"
    assert api.as_(world.viewer).patch(url, json={"enabled": True}).status_code == 403
    assert api.as_(world.outsider).patch(url, json={"enabled": True}).status_code == 404
    r = api.as_(world.admin).patch(url, json={"caption_font": "  Inter  "})
    assert r.status_code == 200 and r.json()["caption_font"] == "Inter"
    for role in ("editor", "reviewer"):
        r = api.as_(getattr(world, role)).patch(f"/projects/{world.A.id}/snippet/settings",
                                                json={"export_aspect": "1:1"})
        assert r.status_code == 403, role


def test_enabling_does_not_queue_any_transcription(db, world, api):
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay") as delay:
        r = api.as_(world.owner).patch(f"/projects/{world.C.id}/snippet/settings",
                                       json={"enabled": True})
    assert r.status_code == 200 and r.json()["enabled"] is True
    delay.assert_not_called()
    assert api.as_(world.viewer).get(f"/projects/{world.C.id}/snippet/speakers").status_code == 200


def test_settings_validation_and_explicit_nulls(db, world, api):
    from apps.api.models.folder import Folder
    from apps.api.models.snippet import SnippetProjectSettings

    theirs = Folder(project_id=world.B.id, name="theirs")
    mine = Folder(project_id=world.A.id, name="Rushes")
    db.add_all([theirs, mine])
    db.commit()
    url = f"/projects/{world.A.id}/snippet/settings"
    owner = api.as_(world.owner)
    assert owner.patch(url, json={"source_folder_id": str(theirs.id)}).status_code == 422
    assert owner.patch(url, json={"source_folder_id": str(uuid.uuid4())}).status_code == 422
    assert owner.patch(url, json={"export_retention_days": 0}).status_code == 422
    assert owner.patch(url, json={"export_aspect": "2.39:1"}).status_code == 422
    assert owner.patch(url, json={"enabled": None}).status_code == 422

    r = owner.patch(url, json={"source_folder_id": str(mine.id), "export_retention_days": None})
    assert r.status_code == 200
    assert r.json()["source_folder_id"] == str(mine.id)
    assert r.json()["export_retention_days"] is None
    db.expire_all()
    row = db.query(SnippetProjectSettings).filter_by(project_id=world.A.id).one()
    assert row.export_retention_days is None, "null means forever and is stored as NULL"
    assert owner.patch(url, json={"source_folder_id": None}).json()["source_folder_id"] is None


# ── 409, 404, 401 ──────────────────────────────────────────────────────────


def test_disabled_project_answers_409_to_members_and_404_to_others(db, world, api):
    viewer = api.as_(world.viewer)
    for path in ("speakers", "search", "suggest"):
        assert viewer.get(f"/projects/{world.C.id}/snippet/{path}").status_code == 409, path
    assert viewer.get(f"/media-files/{world.c_mf.id}/snippet/tracks").status_code == 409
    assert viewer.get(f"/media-files/{world.c_mf.id}/snippet/transcript").status_code == 409
    owner = api.as_(world.owner)
    assert owner.patch(f"/snippets/{world.C1.id}", json={"title": "x"}).status_code == 409
    assert owner.post(f"/projects/{world.C.id}/snippet/process",
                      json={"asset_ids": [str(world.c_asset.id)]}).status_code == 409
    # Not a member: 404 whatever the settings say.
    assert api.as_(world.editor).get(f"/projects/{world.C.id}/snippet/speakers").status_code == 404


def test_another_projects_rows_are_404(db, world, api):
    editor = api.as_(world.editor)
    assert editor.get(f"/projects/{world.B.id}/snippet/speakers").status_code == 404
    assert editor.get(f"/projects/{world.B.id}/snippet/search").status_code == 404
    assert editor.get(f"/media-files/{world.b_mf.id}/snippet/tracks").status_code == 404
    assert editor.get(f"/media-files/{world.b_mf.id}/snippet/transcript").status_code == 404
    assert editor.patch(f"/snippets/{world.B1.id}", json={"title": "mine now"}).status_code == 404
    assert editor.patch(f"/snippets/{uuid.uuid4()}", json={"title": "x"}).status_code == 404
    # A speaker of project B cannot be put on a track of project A.
    r = editor.put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker",
                   json={"speaker_id": str(world.carl.id)})
    assert r.status_code == 404


def test_unauthenticated_is_401(db, world, api):
    assert api.as_(None).get(f"/projects/{world.A.id}/snippet/speakers").status_code == 401


# ── Speakers and tracks ────────────────────────────────────────────────────


def test_speakers_list_and_create_ignoring_case(db, world, api):
    r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/speakers")
    assert [s["name"] for s in r.json()] == ["Anna Example", "Ben", "Ghost"]

    editor = api.as_(world.editor)
    new = editor.post(f"/projects/{world.A.id}/snippet/speakers", json={"name": "  Dora   Lee "})
    assert new.status_code == 201 and new.json()["name"] == "Dora Lee"
    again = editor.post(f"/projects/{world.A.id}/snippet/speakers", json={"name": "dora lee"})
    assert again.status_code == 200 and again.json() == new.json()
    assert editor.post(f"/projects/{world.A.id}/snippet/speakers", json={"name": "   "}).status_code == 422
    for role in ("viewer", "reviewer"):
        r = api.as_(getattr(world, role)).post(f"/projects/{world.A.id}/snippet/speakers",
                                               json={"name": "Eve"})
        assert r.status_code == 403, role


def test_tracks_list_labels_and_mapping(db, world, api):
    r = api.as_(world.viewer).get(f"/media-files/{world.alpha_mf.id}/snippet/tracks")
    assert r.status_code == 200
    assert r.json() == [
        {"track_index": 0, "label": "Lav Anna · 1 ch · de",
         "speaker_id": str(world.anna.id), "speaker_name": "Anna Example"},
        {"track_index": 1, "label": "Track 2 · stereo", "speaker_id": None, "speaker_name": None},
    ]
    # No recorded streams: the tracks that have segments, here track 0.
    r = api.as_(world.viewer).get(f"/media-files/{world.beta_mf.id}/snippet/tracks")
    assert [t["track_index"] for t in r.json()] == [0]


def test_mapping_a_track_relabels_its_segments(db, world, api):
    from apps.api.models.snippet import TranscriptSegment

    url = f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker"
    assert api.as_(world.viewer).put(url, json={"speaker_id": str(world.ben.id)}).status_code == 403
    r = api.as_(world.editor).put(url, json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200
    body = r.json()
    # The re-detect it triggers is covered in test_snippet_files.py.
    assert body.pop("detect_summary")["ran"] is True
    assert body == {"track_index": 1, "label": "Track 2 · stereo", "speaker_id": str(world.ben.id),
                    "speaker_name": "Ben", "segments_relabelled": 1}
    db.expire_all()
    assert db.query(TranscriptSegment).filter_by(id=world.alpha_track1[0].id).one().speaker_id == world.ben.id
    bad = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/5/speaker",
                                    json={"speaker_id": str(world.ben.id)})
    assert bad.status_code == 422 and "no track 5" in bad.json()["detail"]


# ── Processing ─────────────────────────────────────────────────────────────


def test_process_queues_exactly_the_named_assets(db, world, api):
    from apps.api.models.asset import MediaFile, TranscriptionStatus

    url = f"/projects/{world.A.id}/snippet/process"
    body = {"asset_ids": [str(world.alpha.id), str(world.fresh.id), str(world.gone.id),
                          str(world.b_asset.id), str(world.delta.id)]}
    assert api.as_(world.editor).post(url, json=body).status_code == 403
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               side_effect=lambda a, v: SimpleNamespace(id=f"task-{a}")) as delay:
        r = api.as_(world.owner).post(url, json=body)
    assert r.status_code == 200
    out = {i["asset_id"]: (i["queued"], i["reason"]) for i in r.json()["results"]}
    assert r.json()["queued"] == 2
    assert out == {
        str(world.alpha.id): (False, "already transcribed"),
        str(world.fresh.id): (True, "queue"),
        str(world.delta.id): (True, "queue"),
        str(world.gone.id): (False, "not found"),
        str(world.b_asset.id): (False, "not found"),
    }
    assert sorted(c.args[0] for c in delay.call_args_list) == sorted([str(world.fresh.id), str(world.delta.id)])
    db.expire_all()
    assert db.query(MediaFile).filter_by(id=world.fresh_mf.id).one().transcription_status \
        == TranscriptionStatus.processing

    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t")):
        forced = api.as_(world.owner).post(url, json={"asset_ids": [str(world.alpha.id)], "force": True})
    assert forced.json()["results"][0]["queued"] is True


def test_process_takes_one_to_twenty(db, world, api):
    url = f"/projects/{world.A.id}/snippet/process"
    owner = api.as_(world.owner)
    assert owner.post(url, json={"asset_ids": [str(uuid.uuid4()) for _ in range(21)]}).status_code == 422
    assert owner.post(url, json={"asset_ids": []}).status_code == 422


# ── Transcript range ───────────────────────────────────────────────────────


def test_transcript_range_has_words_and_speaker_names(db, world, api):
    r = api.as_(world.viewer).get(f"/media-files/{world.alpha_mf.id}/snippet/transcript",
                                  params={"from_ms": 0, "to_ms": 6000})
    assert r.status_code == 200
    body = r.json()
    assert body["language"] == "en"
    assert [s["text"] for s in body["segments"]] == ["Welcome to the show today.", "We talk about rivers."]
    first = body["segments"][0]
    assert first["speaker_name"] == "Anna Example" and first["status"] == "ai"
    assert first["words"][0] == {"start_ms": 0, "end_ms": 500, "word": "Welcome"}
    assert len(first["words"]) == 5


def test_transcript_range_validation(db, world, api):
    url = f"/media-files/{world.alpha_mf.id}/snippet/transcript"
    viewer = api.as_(world.viewer)
    assert viewer.get(url, params={"from_ms": 5000, "to_ms": 5000}).status_code == 422
    assert viewer.get(url, params={"from_ms": 6000, "to_ms": 5000}).status_code == 422
    assert viewer.get(url, params={"from_ms": 0, "to_ms": 600_001}).status_code == 422
    assert viewer.get(url, params={"from_ms": 0, "to_ms": 600_000}).status_code == 200
    assert viewer.get(url, params={"from_ms": 130_000, "to_ms": 140_000}).status_code == 422
    assert viewer.get(url, params={"from_ms": -1}).status_code == 422
    # Past the end is fine; the range just ends there.
    assert viewer.get(url, params={"from_ms": 100_000, "to_ms": 200_000}).status_code == 200


def test_a_soft_deleted_assets_transcript_tracks_and_clips_are_404(db, world, api):
    owner = api.as_(world.owner)
    assert owner.get(f"/media-files/{world.gone_mf.id}/snippet/transcript").status_code == 404
    assert owner.get(f"/media-files/{world.gone_mf.id}/snippet/tracks").status_code == 404
    assert owner.patch(f"/snippets/{world.G1.id}", json={"title": "back"}).status_code == 404


# ── Clip edit ──────────────────────────────────────────────────────────────


def test_editor_edits_a_clip_and_gets_the_clip_back(db, world, api):
    r = api.as_(world.editor).patch(f"/snippets/{world.D1.id}", json={
        "title": "  Clean   power now ", "topics": ["Energy", "energy", " Solar "],
        "status": "approved", "start_ms": 1000, "end_ms": 9000,
    })
    assert r.status_code == 200, r.text
    clip = r.json()
    assert clip["id"] == str(world.D1.id) and clip["kind"] == "snippet"
    assert clip["title"] == "Clean power now"
    assert clip["topics"] == ["Energy", "Solar"]
    assert clip["status"] == "approved"
    assert (clip["start_ms"], clip["end_ms"], clip["duration_ms"]) == (1000, 9000, 8000)
    assert (clip["source"], clip["generator"]) == ("keyword", "tfidf-v1"), "times edited, origin kept"
    assert clip["speaker"] == {"id": str(world.anna.id), "name": "Anna Example"}
    assert clip["asset_id"] == str(world.delta.id) and clip["asset_name"] == "Delta.mov"
    assert clip["stream_url"].startswith("/stream/hls/master.m3u8?token=")
    assert clip["thumbnail_url"].startswith("/stream/hls/thumb.jpg?token=")


def test_an_audio_clip_streams_its_audio_and_has_no_thumbnail(db, world, api):
    clip = api.as_(world.editor).patch(f"/snippets/{world.BR.id}", json={"title": "Audio"}).json()
    assert clip["stream_url"].startswith("/stream/hls/audio.mp3?token=")
    assert clip["thumbnail_url"] is None


def test_clip_edit_permissions(db, world, api):
    url = f"/snippets/{world.D1.id}"
    assert api.as_(world.viewer).patch(url, json={"title": "x"}).status_code == 403
    assert api.as_(world.reviewer).patch(url, json={"title": "x"}).status_code == 403
    assert api.as_(world.outsider).patch(url, json={"title": "x"}).status_code == 404
    assert api.as_(world.owner).patch(url, json={"title": "x"}).status_code == 200


@pytest.mark.parametrize("body, fragment", [
    ({"start_ms": 5000, "end_ms": 5000}, "before"),
    ({"start_ms": 6000, "end_ms": 5000}, "before"),
    ({"end_ms": 999}, "1 second"),
    ({"start_ms": 0, "end_ms": 60_001}, "past the end"),
    ({"start_ms": -5}, "0 or more"),
    ({"start_ms": None}, "null"),
    ({"status": None}, "null"),
    ({"topics": [f"t{i}" for i in range(9)]}, "8 topics"),
    ({"title": "x" * 256}, "255"),
])
def test_clip_edit_rejects_bad_values(db, world, api, body, fragment):
    r = api.as_(world.editor).patch(f"/snippets/{world.D1.id}", json=body)
    assert r.status_code == 422, r.text
    assert fragment in str(r.json()["detail"])


def test_clip_edit_up_to_the_exact_end_of_the_file_is_allowed(db, world, api):
    r = api.as_(world.editor).patch(f"/snippets/{world.D1.id}", json={"start_ms": 59_000, "end_ms": 60_000})
    assert r.status_code == 200


# ═══ Postgres only: search and suggest ═════════════════════════════════════


def search(api, world, user=None, **params):
    r = api.as_(user or world.viewer).get(f"/projects/{world.A.id}/snippet/search", params=params)
    assert r.status_code == 200, r.text
    return r.json()


@needs_pg
def test_search_default_excludes_rejected_and_deleted(pg, world, api):
    body = search(api, world)
    assert body["total"] == 4 and body["page"] == 1 and body["page_size"] == 24
    assert [g["key"] for g in body["groups"]] == ["all"]
    assert set(ids(all_items(body))) == {str(world.SC.id), str(world.D1.id), str(world.D2.id), str(world.D3.id)}


@needs_pg
def test_search_status_filter_shows_rejected_on_request(pg, world, api):
    assert set(ids(all_items(search(api, world, status="rejected")))) == {str(world.D4.id), str(world.BR.id)}


@needs_pg
def test_quality_sort_puts_unscored_last(pg, world, api):
    items = all_items(search(api, world, sort="quality"))
    assert ids(items) == [str(world.D1.id), str(world.D3.id), str(world.SC.id), str(world.D2.id)]
    assert [i["quality_score"] for i in items] == [0.9, 0.5, None, None]


@needs_pg
def test_viral_sort_puts_unscored_last(pg, world, api):
    items = all_items(search(api, world, sort="viral"))
    assert ids(items) == [str(world.D2.id), str(world.D3.id), str(world.SC.id), str(world.D1.id)]
    assert [i["viral_score"] for i in items] == [0.8, 0.2, None, None]


@needs_pg
def test_length_sorts(pg, world, api):
    asc = ids(all_items(search(api, world, sort="length_asc")))
    assert asc == [str(world.SC.id), str(world.D3.id), str(world.D1.id), str(world.D2.id)]
    assert ids(all_items(search(api, world, sort="length_desc"))) == list(reversed(asc))


@needs_pg
def test_group_by_speaker(pg, world, api):
    body = search(api, world, group="speaker", sort="length_asc")
    assert [(g["key"], g["label"], ids(g["items"])) for g in body["groups"]] == [
        (str(world.anna.id), "Anna Example", [str(world.SC.id), str(world.D1.id)]),
        (str(world.ben.id), "Ben", [str(world.D2.id)]),
        ("none", "No speaker", [str(world.D3.id)]),
    ]


@needs_pg
def test_group_by_topic_puts_a_clip_in_each_of_its_topics(pg, world, api):
    body = search(api, world, group="topic", sort="length_asc")
    assert [(g["key"], g["label"], ids(g["items"])) for g in body["groups"]] == [
        ("climate", "Climate", [str(world.D1.id), str(world.D2.id)]),
        ("energy", "Energy", [str(world.D1.id)]),
        ("rivers", "Rivers", [str(world.SC.id)]),
        ("none", "No topic", [str(world.D3.id)]),
    ]
    assert body["total"] == 5


@needs_pg
def test_pagination(pg, world, api):
    p1 = search(api, world, sort="length_asc", page_size=2, page=1)
    p2 = search(api, world, sort="length_asc", page_size=2, page=2)
    p3 = search(api, world, sort="length_asc", page_size=2, page=3)
    assert p1["total"] == p2["total"] == p3["total"] == 4
    assert ids(all_items(p1)) == [str(world.SC.id), str(world.D3.id)]
    assert ids(all_items(p2)) == [str(world.D1.id), str(world.D2.id)]
    assert p3["groups"] == [{"key": "all", "label": "All", "items": []}]
    viewer = api.as_(world.viewer)
    assert viewer.get(f"/projects/{world.A.id}/snippet/search", params={"page_size": 61}).status_code == 422
    assert viewer.get(f"/projects/{world.A.id}/snippet/search", params={"page": 0}).status_code == 422


@needs_pg
def test_a_group_continues_across_pages(pg, world, api):
    p1 = search(api, world, group="speaker", sort="length_asc", page_size=1, page=1)
    p2 = search(api, world, group="speaker", sort="length_asc", page_size=1, page=2)
    assert [g["key"] for g in p1["groups"]] == [str(world.anna.id)]
    assert [g["key"] for g in p2["groups"]] == [str(world.anna.id)]
    assert ids(all_items(p1)) + ids(all_items(p2)) == [str(world.SC.id), str(world.D1.id)]


@needs_pg
def test_filters(pg, world, api):
    assert ids(all_items(search(api, world, speaker_id=str(world.ben.id)))) == [str(world.D2.id)]
    assert ids(all_items(search(api, world, source="llm"))) == [str(world.D2.id)]
    assert set(ids(all_items(search(api, world, source=["llm", "import"])))) == {str(world.D2.id), str(world.D3.id)}
    assert set(ids(all_items(search(api, world, topic="CLIMATE")))) == {str(world.D1.id), str(world.D2.id)}
    assert ids(all_items(search(api, world, min_ms=8000, max_ms=12000))) == [str(world.D1.id)]
    viewer = api.as_(world.viewer)
    url = f"/projects/{world.A.id}/snippet/search"
    assert viewer.get(url, params={"min_ms": 9000, "max_ms": 8000}).status_code == 422
    assert viewer.get(url, params={"source": "tiktok"}).status_code == 422
    assert viewer.get(url, params={"sort": "newest"}).status_code == 422


@needs_pg
def test_query_matches_title_topic_speaker_and_quote(pg, world, api):
    assert ids(all_items(search(api, world, q="warming"))) == [str(world.D2.id)]
    assert set(ids(all_items(search(api, world, q="climate")))) == {str(world.D1.id), str(world.D2.id)}
    assert ids(all_items(search(api, world, q="ben"))) == [str(world.D2.id)]
    assert ids(all_items(search(api, world, q="clean energy"))) == [str(world.D1.id)]
    assert search(api, world, q="%")["total"] == 0, "LIKE characters are taken literally"


@needs_pg
def test_a_transcript_hit_inside_a_snippet_returns_the_snippet_not_a_moment(pg, world, api):
    items = all_items(search(api, world, q="rivers"))
    assert [(i["kind"], i["id"]) for i in items] == [("snippet", str(world.SC.id))]


@needs_pg
def test_an_uncovered_transcript_hit_is_a_moment_padded_to_whole_sentences(pg, world, api):
    items = all_items(search(api, world, q="glacier"))
    assert len(items) == 1, items  # not Gone.mov's (trashed), not project C's
    m = items[0]
    assert m["kind"] == "moment"
    # "The glacier melts every summer." is 6000-8900. Padded with the next two
    # sentences (to 12700), still under 8 s, then the previous one (from 3000).
    assert (m["start_ms"], m["end_ms"]) == (3000, 12700)
    assert 8000 <= m["duration_ms"] <= 30000
    assert m["id"] == f"moment:{world.alpha_mf.id}:3000"
    assert m["quote"] == ("We talk about rivers. The glacier melts every summer. "
                          "Nobody expected that. Thanks for listening.")
    assert m["speaker"] == {"id": str(world.anna.id), "name": "Anna Example"}
    assert (m["source"], m["status"], m["generator"], m["title"]) == (None, None, None, None)
    assert m["topics"] == [] and m["quality_score"] is None and m["viral_score"] is None
    assert m["media_file_id"] == str(world.alpha_mf.id) and m["asset_name"] == "Alpha.mov"
    assert m["stream_url"].startswith("/stream/hls/master.m3u8?token=")


@needs_pg
def test_a_sentence_longer_than_30_s_is_cut_around_the_hit(pg, world, api):
    items = all_items(search(api, world, q="volcano"))
    # The rejected clip BR (0-10 s) does not cover the word at 33 s.
    assert len(items) == 1, items
    m = items[0]
    assert m["kind"] == "moment" and m["duration_ms"] <= 30000
    # "volcano" is word 55 (33000-33500): the last 30 s of the sentence hold it.
    assert m["start_ms"] <= 33000 and m["end_ms"] >= 33500
    assert m["end_ms"] == 59 * (WORD_MS + GAP_MS) + WORD_MS
    assert m["start_ms"] == 10 * (WORD_MS + GAP_MS), "starts on a word"
    assert "volcano" in m["quote"]
    assert m["thumbnail_url"] is None, "audio"
    assert m["stream_url"].startswith("/stream/hls/audio.mp3?token=")


@needs_pg
def test_moments_respect_filters(pg, world, api):
    assert search(api, world, q="glacier", topic="Climate")["total"] == 0
    assert search(api, world, q="glacier", source="keyword")["total"] == 0
    assert search(api, world, q="glacier", status="suggested")["total"] == 0
    assert search(api, world, q="glacier", speaker_id=str(world.ben.id))["total"] == 0
    assert search(api, world, q="glacier", min_ms=10_000)["total"] == 0
    assert search(api, world, q="glacier", speaker_id=str(world.anna.id))["total"] == 1


@needs_pg
def test_moments_sort_with_unscored_snippets_and_group_under_none(pg, world, api):
    body = search(api, world, q="glacier", group="topic")
    assert [(g["key"], g["label"]) for g in body["groups"]] == [("none", "No topic")]
    body = search(api, world, q="glacier", group="speaker")
    assert [g["key"] for g in body["groups"]] == [str(world.anna.id)]


@needs_pg
def test_soft_deleted_assets_vanish_from_search(pg, world, api):
    assert search(api, world, q="phantom")["total"] == 0
    assert search(api, world, q="ghost")["total"] == 0
    assert search(api, world, topic="Phantom")["total"] == 0
    assert search(api, world, speaker_id=str(world.ghost.id))["total"] == 0


@needs_pg
def test_search_query_count_does_not_grow_with_results(pg, world, api):
    """No N+1: speakers, files and words are each fetched in one query."""
    from sqlalchemy import event

    from apps.api.models.snippet import Snippet, TranscriptSegment, TranscriptWord

    def count(**params):
        statements = []

        def _on(conn, cursor, statement, *a):
            # The test session's own savepoint bookkeeping is not the route's.
            if not statement.lstrip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
                statements.append(statement)

        event.listen(pg.get_bind().engine, "before_cursor_execute", _on)
        try:
            search(api, world, **params)
        finally:
            event.remove(pg.get_bind().engine, "before_cursor_execute", _on)
        return len(statements)

    before_plain, before_q = count(), count(q="glacier")
    # Ten more hits 10 s apart (each its own moment: the pauses are cuts),
    # and ten more clips that do not cover them.
    for i in range(10):
        start = 20_000 + i * 10_000
        pg.add(Snippet(media_file_id=world.alpha_mf.id, start_ms=start + 6_000, end_ms=start + 8_000,
                       speaker_id=world.ben.id, topics=[f"t{i}"]))
        seg = TranscriptSegment(media_file_id=world.alpha_mf.id, track_index=0, seq=100 + i,
                                start_ms=start, end_ms=start + 2900, text_ai="x",
                                text_current="A glacier again here.")
        pg.add(seg)
        pg.flush()
        for idx, (ws, we, word) in enumerate(_words(start, "A glacier again here.")):
            pg.add(TranscriptWord(segment_id=seg.id, idx=idx, start_ms=ws, end_ms=we, word=word))
    pg.commit()
    body = search(api, world, q="glacier", sort="length_asc", page_size=60)
    assert body["total"] == 11
    # An isolated 2.3 s remark is widened into the silence around it to 8 s,
    # evenly, without reaching the next remark 7.7 s away.
    lone = next(m for m in all_items(body) if m["start_ms"] < 20_000 < m["end_ms"])
    assert (lone["start_ms"], lone["end_ms"]) == (20_000 - 2_850, 22_300 + 2_850)
    assert lone["quote"] == "A glacier again here."
    assert count() == before_plain
    assert count(q="glacier") == before_q


@needs_pg
def test_search_permissions(pg, world, api):
    for role in ("viewer", "reviewer", "editor", "owner"):
        assert search(api, world, user=getattr(world, role))["total"] == 4, role
    assert api.as_(world.outsider).get(f"/projects/{world.A.id}/snippet/search").status_code == 404


# ── Suggest ────────────────────────────────────────────────────────────────


def suggest(api, world, q=""):
    r = api.as_(world.viewer).get(f"/projects/{world.A.id}/snippet/suggest", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()


@needs_pg
def test_suggest_with_no_query_returns_the_most_used(pg, world, api):
    body = suggest(api, world)
    # Anna: SC and D1 (D4 is rejected); Ben: D2 (BR is rejected). Ghost's only
    # clip is on a deleted asset.
    assert [n["name"] for n in body["names"]] == ["Anna Example", "Ben"]
    assert body["names"][0]["id"] == str(world.anna.id)
    assert body["topics"] == [
        {"topic": "Climate", "count": 2},
        {"topic": "Energy", "count": 1},
        {"topic": "Rivers", "count": 1},
    ]


@needs_pg
def test_suggest_prefix_matches_any_word(pg, world, api):
    assert [n["name"] for n in suggest(api, world, "exa")["names"]] == ["Anna Example"]
    assert suggest(api, world, "CLI")["topics"] == [{"topic": "Climate", "count": 2}]


@needs_pg
def test_soft_deleted_assets_vanish_from_suggest(pg, world, api):
    assert suggest(api, world, "gho") == {"names": [], "topics": []}
    assert suggest(api, world, "phan") == {"names": [], "topics": []}


@needs_pg
def test_suggest_uses_trigrams_only_when_pg_trgm_is_installed(pg, world, api):
    from sqlalchemy import text

    installed = pg.execute(text("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).first()
    if installed is None:
        assert suggest(api, world, "Ana Exampel")["names"] == []
        assert suggest(api, world, "enrgy")["topics"] == []
        pg.execute(text("CREATE EXTENSION pg_trgm"))  # rolled back with the test
    assert [n["name"] for n in suggest(api, world, "Ana Exampel")["names"]] == ["Anna Example"]
    assert [t["topic"] for t in suggest(api, world, "enrgy")["topics"]] == ["Energy"]


@needs_pg
def test_suggest_caps_at_six(pg, world, api):
    from apps.api.models.snippet import Snippet

    pg.add(Snippet(media_file_id=world.delta_mf.id, start_ms=50000, end_ms=55000,
                   topics=[f"Topic {i}" for i in range(8)]))
    pg.commit()
    assert len(suggest(api, world, "")["topics"]) == 6
    assert len(suggest(api, world, "topic")["topics"]) == 6
