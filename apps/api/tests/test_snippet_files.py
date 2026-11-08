"""GET /projects/{id}/snippet/files, the process not-ready rule, and the
re-detect after a track is given a speaker.

The world, the two databases and the client are test_snippet_api.py's
(imported below). Every test here takes `db`, so each runs on SQLite AND on
Postgres when TEST_DATABASE_URL points at a migrated one; nothing here needs
full-text search. `derive_status` is also tested on its own, without a
database.
"""
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from .test_snippet_api import api, db, pg_engine, world  # noqa: F401  -- shared fixtures


def files(api, world, user=None, project=None, **params):
    r = api.as_(user or world.owner).get(
        f"/projects/{(project or world.A).id}/snippet/files", params=params,
    )
    assert r.status_code == 200, r.text
    return r.json()


def by_name(body):
    return {i["name"]: i for i in body["items"]}


def add_asset(s, project, name, kind="video", folder=None, status=None,
              versions=1, transcription_status=None):
    """A live asset with `versions` versions, each with a media file; the
    latest version's processing status is `status` (default ready)."""
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
        TranscriptionStatus,
    )

    a = Asset(project_id=project.id, name=name, asset_type=AssetType(kind),
              folder_id=folder.id if folder else None)
    s.add(a)
    s.flush()
    mf = None
    for n in range(1, versions + 1):
        v = AssetVersion(asset_id=a.id, version_number=n,
                         processing_status=(status if n == versions and status is not None
                                            else ProcessingStatus.ready))
        s.add(v)
        s.flush()
        if kind in ("video", "audio"):
            mf = MediaFile(
                version_id=v.id, file_type=FileType(kind), original_filename=name,
                mime_type="video/mp4" if kind == "video" else "audio/wav", file_size_bytes=1,
                s3_key_raw=f"raw/{a.id}/{v.id}", duration_seconds=10.0,
                transcription_status=transcription_status or TranscriptionStatus.not_started,
            )
            s.add(mf)
            s.flush()
    return a, mf


def add_folder(s, project, name, parent=None):
    from apps.api.models.folder import Folder

    f = Folder(project_id=project.id, name=name, parent_id=parent.id if parent else None)
    s.add(f)
    s.flush()
    return f


def add_job(s, mf, stage, status, error=None, when=None):
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus

    job = SnippetJob(media_file_id=mf.id, stage=stage, status=SnippetJobStatus(status),
                     error=error)
    if when is not None:
        job.updated_at = when
    s.add(job)
    s.flush()
    return job


# ── derive_status, without a database ──────────────────────────────────────


def _jobs(*specs):
    from apps.api.models.snippet import SnippetJobStatus
    from apps.api.services.snippet_files import JobView

    return [JobView(stage, SnippetJobStatus(status), error) for stage, status, error in specs]


@pytest.mark.parametrize("transcription, jobs, segments, expected", [
    ("not_started", [], 0, ("not_processed", None)),
    ("processing", [], 0, ("queued", None)),
    ("processing", [("plan", "pending", None)], 0, ("queued", None)),
    # A resumed file waiting in the queue keeps its done rows: still queued.
    ("processing", [("plan", "done", None)], 0, ("queued", None)),
    ("processing", [("plan", "done", None), ("transcribe:track0", "done", "no speech"),
                    ("transcribe:track1", "pending", None)], 0, ("queued", None)),
    ("ready", [("plan", "done", None), ("transcribe:track0", "running", None)], 0, ("running", None)),
    # A Celery retry: the earlier failure is still recorded while the task runs again.
    ("processing", [("plan", "done", None), ("gate", "failed", "boom")], 0, ("running", None)),
    ("failed", [("plan", "done", None), ("gate", "failed", "OSError: disk")], 0,
     ("failed", "OSError: disk")),
    # Refused because a person edited the transcript: the old one is kept.
    ("ready", [("store", "failed", "3 edited segment(s)")], 4, ("failed", "3 edited segment(s)")),
    ("failed", [], 0, ("failed", "Transcription failed before any stage started.")),
    ("ready", [("store", "done", None), ("detect", "done", None)], 7, ("done", None)),
    # No speech at all: no segments, but the store stage finished.
    ("ready", [("store", "done", None)], 0, ("done", None)),
    ("ready", [("transcribe:track0", "done", "no speech"), ("store", "done", "no speech found"),
               ("detect", "done", None)], 0, ("done", None)),
    # A track's "no speech" note is not an error of the file.
    ("ready", [("transcribe:track1", "done", "no speech"), ("store", "done", None)], 4, ("done", None)),
    # An imported transcript with no jobs at all.
    ("not_started", [], 3, ("done", None)),
    ("ready", [("store", "done", None), ("detect", "failed", "KeyError: x")], 5,
     ("done", "Clip detection failed: KeyError: x")),
])
def test_derive_status(transcription, jobs, segments, expected):
    from apps.api.models.asset import TranscriptionStatus
    from apps.api.services.snippet_files import derive_status

    assert derive_status(TranscriptionStatus(transcription), _jobs(*jobs), segments) == expected


def test_the_latest_failure_is_the_one_reported():
    from apps.api.models.asset import TranscriptionStatus
    from apps.api.models.snippet import SnippetJobStatus
    from apps.api.services.snippet_files import JobView, derive_status

    t0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
    jobs = [JobView("gate", SnippetJobStatus.failed, "old", t0),
            # Naive, as SQLite returns it: compared as UTC, not refused.
            JobView("store", SnippetJobStatus.failed, "new", datetime(2026, 1, 2))]
    assert derive_status(TranscriptionStatus.failed, jobs, 0) == ("failed", "new")


def test_stage_names_match_the_pipeline():
    from apps.api.services import snippet_files
    from apps.api.tasks import transcribe_tasks

    assert snippet_files.STORE_STAGE == transcribe_tasks.SNIPPET_STAGE_STORE
    assert snippet_files.DETECT_STAGE == transcribe_tasks.SNIPPET_STAGE_DETECT
    from apps.api.services import snippet_admin
    assert transcribe_tasks.snippet_track_stage(3) == f"{snippet_admin.TRACK_STAGE_PREFIX}3"
    assert snippet_admin.track_of_stage(transcribe_tasks.snippet_track_stage(12)) == 12
    assert snippet_admin.track_of_stage("gate") is None
    assert snippet_admin.track_of_stage("transcribe:trackX") is None


# ── Access ─────────────────────────────────────────────────────────────────


def test_files_permissions_per_role(db, world, api):
    url = f"/projects/{world.A.id}/snippet/files"
    assert api.as_(world.owner).get(url).status_code == 200
    assert api.as_(world.editor).get(url).status_code == 200
    assert api.as_(world.reviewer).get(url).status_code == 403
    assert api.as_(world.viewer).get(url).status_code == 403
    assert api.as_(world.outsider).get(url).status_code == 404
    assert api.as_(None).get(url).status_code == 401
    assert api.as_(world.owner).get(f"/projects/{uuid.uuid4()}/snippet/files").status_code == 404


def test_files_409_when_disabled(db, world, api):
    url = f"/projects/{world.C.id}/snippet/files"
    assert api.as_(world.owner).get(url).status_code == 409
    # Role before enabled: a viewer of the disabled project learns nothing more.
    assert api.as_(world.viewer).get(url).status_code == 403
    assert api.as_(world.outsider).get(url).status_code == 404


def test_page_size_bounds(db, world, api):
    url = f"/projects/{world.A.id}/snippet/files"
    owner = api.as_(world.owner)
    assert owner.get(url, params={"page_size": 101}).status_code == 422
    assert owner.get(url, params={"page_size": 0}).status_code == 422
    assert owner.get(url, params={"page": 0}).status_code == 422
    assert owner.get(url, params={"page_size": 100}).status_code == 200


# ── What is listed ─────────────────────────────────────────────────────────


def test_lists_the_projects_video_and_audio_with_counts_and_tracks(db, world, api):
    add_asset(db, world.A, "Still.jpg", kind="image")
    db.commit()
    body = files(api, world)
    assert body["total"] == 4
    assert [i["name"] for i in body["items"]] == ["Alpha.mov", "Beta.wav", "Delta.mov", "Fresh.wav"]
    alpha = by_name(body)["Alpha.mov"]
    assert alpha["asset_id"] == str(world.alpha.id)
    assert alpha["media_file_id"] == str(world.alpha_mf.id)
    assert alpha["kind"] == "video"
    assert alpha["folder_path"] == "/"
    assert alpha["duration_ms"] == 120_000
    assert alpha["asset_status"] == "ready" and alpha["not_ready_reason"] is None
    assert alpha["snippet_status"] == "done" and alpha["error"] is None
    assert alpha["segment_count"] == 6 and alpha["snippet_count"] == 1
    assert alpha["updated_at"] is not None
    assert alpha["tracks"] == [
        {"track_index": 0, "label": "Lav Anna · 1 ch · de",
         "speaker_id": str(world.anna.id), "speaker_name": "Anna Example"},
        {"track_index": 1, "label": "Track 2 · stereo", "speaker_id": None, "speaker_name": None},
    ]
    # The same rows GET /media-files/{id}/snippet/tracks answers with.
    assert api.as_(world.owner).get(
        f"/media-files/{world.alpha_mf.id}/snippet/tracks").json() == alpha["tracks"]
    delta, beta, fresh = (by_name(body)[n] for n in ("Delta.mov", "Beta.wav", "Fresh.wav"))
    # D1-D3 count, D4 is rejected; Beta's only clip is rejected.
    assert (delta["snippet_status"], delta["segment_count"], delta["snippet_count"]) == ("not_processed", 0, 3)
    assert (beta["snippet_status"], beta["segment_count"], beta["snippet_count"]) == ("done", 1, 0)
    assert beta["kind"] == "audio"
    # No recorded streams and no segments: track 0, unnamed.
    assert fresh["tracks"] == [{"track_index": 0, "label": "Track 1", "speaker_id": None,
                                "speaker_name": None}]


def test_query_and_pagination(db, world, api):
    assert [i["name"] for i in files(api, world, q="TA")["items"]] == ["Beta.wav", "Delta.mov"]
    assert files(api, world, q="  .wav ")["total"] == 2
    # LIKE wildcards in the query are literal.
    assert files(api, world, q="%")["total"] == 0
    assert files(api, world, q="_")["total"] == 0
    first = files(api, world, page_size=3)
    second = files(api, world, page_size=3, page=2)
    assert first["total"] == second["total"] == 4
    assert [i["name"] for i in first["items"]] == ["Alpha.mov", "Beta.wav", "Delta.mov"]
    assert [i["name"] for i in second["items"]] == ["Fresh.wav"]
    assert files(api, world, page=9)["items"] == []


def test_soft_deleted_assets_versions_and_folders_are_left_out(db, world, api):
    from apps.api.models.asset import AssetVersion, MediaFile

    now = datetime.now(timezone.utc)
    trashed = add_folder(db, world.A, "Trashed")
    trashed.deleted_at = now
    below = add_folder(db, world.A, "Below", parent=trashed)
    add_asset(db, world.A, "InTrashedFolder.mov", folder=below)
    # Two versions; the newer one is in the trash, so the older one is listed.
    two, _ = add_asset(db, world.A, "TwoVersions.mov", versions=2)
    v2 = db.query(AssetVersion).filter_by(asset_id=two.id, version_number=2).one()
    v2.deleted_at = now
    v1_mf = (db.query(MediaFile).join(AssetVersion, AssetVersion.id == MediaFile.version_id)
             .filter(AssetVersion.asset_id == two.id, AssetVersion.version_number == 1).one())
    db.commit()
    names = by_name(files(api, world))
    assert "Gone.mov" not in names
    assert "InTrashedFolder.mov" not in names
    assert names["TwoVersions.mov"]["media_file_id"] == str(v1_mf.id)


def test_scoped_to_the_source_folder_and_everything_below_it(db, world, api):
    from apps.api.models.snippet import SnippetProjectSettings

    interviews = add_folder(db, world.A, "Interviews")
    day1 = add_folder(db, world.A, "Day 1", parent=interviews)
    other = add_folder(db, world.A, "B-roll")
    add_asset(db, world.A, "Top.mov", folder=interviews)
    add_asset(db, world.A, "Deep.wav", kind="audio", folder=day1)
    add_asset(db, world.A, "Elsewhere.mov", folder=other)
    db.query(SnippetProjectSettings).filter_by(project_id=world.A.id).one().source_folder_id = interviews.id
    db.commit()
    body = files(api, world)
    assert body["total"] == 2
    assert {i["name"]: i["folder_path"] for i in body["items"]} == {
        "Deep.wav": "/Interviews/Day 1", "Top.mov": "/Interviews",
    }

    # Without a source folder: the whole project, root included.
    db.query(SnippetProjectSettings).filter_by(project_id=world.A.id).one().source_folder_id = None
    db.commit()
    names = by_name(files(api, world))
    assert {"Top.mov", "Deep.wav", "Elsewhere.mov", "Alpha.mov"} <= set(names)
    assert names["Elsewhere.mov"]["folder_path"] == "/B-roll"


# ── Status, through the endpoint ───────────────────────────────────────────


def test_each_status_through_the_endpoint(db, world, api):
    from apps.api.models.asset import TranscriptionStatus

    _a, _queued = add_asset(db, world.A, "S1-queued.wav", kind="audio",
                            transcription_status=TranscriptionStatus.processing)
    _a, running = add_asset(db, world.A, "S2-running.wav", kind="audio",
                            transcription_status=TranscriptionStatus.processing)
    add_job(db, running, "plan", "done")
    add_job(db, running, "transcribe:track0", "running")
    _a, failed = add_asset(db, world.A, "S3-failed.wav", kind="audio",
                           transcription_status=TranscriptionStatus.failed)
    add_job(db, failed, "plan", "done")
    add_job(db, failed, "transcribe:track0", "failed", error="RuntimeError: out of memory")
    _a, detect = add_asset(db, world.A, "S4-detect.wav", kind="audio",
                           transcription_status=TranscriptionStatus.ready)
    add_job(db, detect, "store", "done")
    add_job(db, detect, "detect", "failed", error="ValueError: bad window")
    later = datetime.now(timezone.utc) + timedelta(days=1)
    _a, silent = add_asset(db, world.A, "S5-silent.wav", kind="audio",
                           transcription_status=TranscriptionStatus.ready)
    add_job(db, silent, "store", "done", when=later)
    db.commit()

    listed = by_name(files(api, world))
    got = {n: (i["snippet_status"], i["error"]) for n, i in listed.items() if n.startswith("S")}
    assert got == {
        "S1-queued.wav": ("queued", None),
        "S2-running.wav": ("running", None),
        "S3-failed.wav": ("failed", "RuntimeError: out of memory"),
        "S4-detect.wav": ("done", "Clip detection failed: ValueError: bad window"),
        "S5-silent.wav": ("done", None),
    }
    assert listed["Fresh.wav"]["snippet_status"] == "not_processed"
    # updated_at follows the latest sign of life, here the job's.
    assert listed["S5-silent.wav"]["updated_at"][:10] == later.date().isoformat()


def test_after_process_the_file_reads_queued(db, world, api):
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t-1")):
        r = api.as_(world.owner).post(f"/projects/{world.A.id}/snippet/process",
                                      json={"asset_ids": [str(world.fresh.id)]})
    assert r.json()["queued"] == 1
    db.expire_all()
    assert by_name(files(api, world))["Fresh.wav"]["snippet_status"] == "queued"


# ── Not ready ──────────────────────────────────────────────────────────────


def test_a_file_that_is_not_ready_is_not_queued_and_says_why(db, world, api):
    from apps.api.models.asset import ProcessingStatus

    uploading, _ = add_asset(db, world.A, "Uploading.mov", status=ProcessingStatus.uploading)
    transcoding, _ = add_asset(db, world.A, "Transcoding.mov", status=ProcessingStatus.processing)
    broken, _ = add_asset(db, world.A, "Broken.mov", status=ProcessingStatus.failed)
    db.commit()
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t")) as delay:
        r = api.as_(world.owner).post(
            f"/projects/{world.A.id}/snippet/process",
            json={"asset_ids": [str(uploading.id), str(transcoding.id), str(broken.id)],
                  "force": True},
        )
    assert r.status_code == 200
    assert r.json()["queued"] == 0
    assert delay.call_count == 0
    reasons = {i["asset_id"]: (i["queued"], i["reason"]) for i in r.json()["results"]}
    assert reasons == {
        str(uploading.id): (False, "the file is still uploading"),
        str(transcoding.id): (False, "the file is still being processed"),
        str(broken.id): (False, "the file's own processing failed; fix that first"),
    }
    listed = by_name(files(api, world))
    for name, asset in (("Uploading.mov", uploading), ("Transcoding.mov", transcoding),
                        ("Broken.mov", broken)):
        assert listed[name]["not_ready_reason"] == reasons[str(asset.id)][1]
    assert listed["Uploading.mov"]["asset_status"] == "uploading"
    assert listed["Broken.mov"]["asset_status"] == "failed"


# ── No N+1 ─────────────────────────────────────────────────────────────────


def test_statement_count_does_not_grow_with_the_page(db, world, api):
    """The same number of statements for 4 files as for 24, each of the 20
    new ones with jobs, segments, a clip and a named track."""
    from sqlalchemy import event

    from apps.api.models.snippet import Snippet, SnippetTrackSpeaker, TranscriptSegment

    engine = db.get_bind().engine

    def count():
        statements = []

        def _on(conn, cursor, statement, *a):
            # The test session's own savepoint bookkeeping is not the route's.
            if not statement.lstrip().upper().startswith(("SAVEPOINT", "RELEASE", "ROLLBACK")):
                statements.append(statement)

        event.listen(engine, "before_cursor_execute", _on)
        try:
            body = files(api, world, page_size=100)
        finally:
            event.remove(engine, "before_cursor_execute", _on)
        return len(statements), body["total"]

    before, total = count()
    assert total == 4
    folder = add_folder(db, world.A, "More")
    for i in range(20):
        _a, mf = add_asset(db, world.A, f"More-{i:02d}.wav", kind="audio", folder=folder)
        add_job(db, mf, "store", "done")
        add_job(db, mf, "detect", "done")
        db.add(TranscriptSegment(media_file_id=mf.id, track_index=0, seq=0, start_ms=0,
                                 end_ms=1000, text_ai="hi", text_current="hi"))
        db.add(Snippet(media_file_id=mf.id, start_ms=0, end_ms=2000, source="manual"))
        db.add(SnippetTrackSpeaker(media_file_id=mf.id, track_index=0, speaker_id=world.ben.id))
    db.commit()
    after, total = count()
    assert total == 24
    assert after == before
    # And it is a small fixed number: access checks, settings, folders,
    # count, page, and one each for segments, clips, jobs and tracks.
    assert after <= 14, after


# ── Naming a speaker re-runs detection ─────────────────────────────────────


def _clear_the_transcript_span(db, world):
    """Move Alpha's hand-made clip SC (2.5-5.5 s) past the transcript.

    Kept clips block overlapping suggestions, and SC lies inside the only
    window Alpha's transcript yields, so with it there nothing is created.
    """
    from apps.api.models.snippet import Snippet

    sc = db.query(Snippet).filter_by(id=world.SC.id).one()
    sc.start_ms, sc.end_ms = 80_000, 83_000
    db.commit()


def test_naming_a_speaker_redetects_and_leaves_decided_clips_alone(db, world, api):
    from apps.api.models.snippet import Snippet, SnippetJob, SnippetStatus

    _clear_the_transcript_span(db, world)

    stale = Snippet(media_file_id=world.alpha_mf.id, start_ms=0, end_ms=9000, source="keyword",
                    generator="tfidf-v1", speaker_id=world.anna.id, title="Old suggestion")
    # Away from the transcript, so it does not stop new suggestions over it.
    approved = Snippet(media_file_id=world.alpha_mf.id, start_ms=60_000, end_ms=69_500, source="keyword",
                       generator="tfidf-v1", speaker_id=world.anna.id, title="Keep me",
                       status=SnippetStatus.approved)
    db.add_all([stale, approved])
    db.commit()
    stale_id, approved_id = stale.id, approved.id

    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/0/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200, r.text
    summary = r.json()["detect_summary"]
    assert summary["ran"] is True and summary["reason"] is None
    assert summary["removed"] == 1
    assert summary["created"] >= 1

    db.expire_all()
    rows = db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id).all()
    assert stale_id not in {s.id for s in rows}
    new = [s for s in rows if s.source == "keyword" and s.status == SnippetStatus.suggested]
    assert len(new) == summary["created"]
    # The new suggestions carry the speaker just named.
    assert {s.speaker_id for s in new} == {world.ben.id}
    kept = {s.id: s for s in rows}
    assert kept[approved_id].speaker_id == world.anna.id and kept[approved_id].title == "Keep me"
    assert kept[world.SC.id].speaker_id == world.anna.id  # manual, untouched
    job = db.query(SnippetJob).filter_by(media_file_id=world.alpha_mf.id, stage="detect").one()
    assert job.status.value == "done"


def test_redetect_after_naming_a_speaker_keeps_an_edited_clip(db, world, api):
    """A suggestion a person trimmed is not replaced, keeps its speaker, and
    gets no untrimmed twin; the PATCH is what marks it."""
    from apps.api.models.snippet import Snippet

    _clear_the_transcript_span(db, world)
    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/0/speaker",
                                  json={"speaker_id": str(world.anna.id)})
    assert r.json()["detect_summary"]["created"] >= 1
    db.expire_all()
    first = (db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id, source="keyword")
             .order_by(Snippet.start_ms).first())
    span = (first.start_ms + 400, first.end_ms)
    patched = api.as_(world.editor).patch(f"/snippets/{first.id}", json={"start_ms": span[0]})
    assert patched.json()["user_edited"] is True

    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/0/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200
    summary = r.json()["detect_summary"]
    assert summary["ran"] is True
    db.expire_all()
    rows = db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id).all()
    kept = next(s for s in rows if s.id == first.id)
    assert (kept.start_ms, kept.end_ms) == span
    assert kept.speaker_id == world.anna.id, "an edited clip is not rewritten, speaker included"
    for s in rows:
        if s.id == first.id or s.source != "keyword":
            continue
        overlap = min(s.end_ms, span[1]) - max(s.start_ms, span[0])
        assert overlap <= 0 or overlap / min(s.end_ms - s.start_ms, span[1] - span[0]) <= 0.30


def test_a_hand_made_clip_blocks_suggestions_over_it(db, world, api):
    """With SC where it is, Alpha's one window overlaps it: detection runs,
    replaces nothing and creates nothing."""
    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/0/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.json()["detect_summary"] == {"ran": True, "created": 0, "removed": 0, "reason": None}


def test_a_good_redetect_clears_an_earlier_detect_failure(db, world, api):
    add_job(db, world.alpha_mf, "detect", "failed", error="ValueError: old")
    db.commit()
    assert by_name(files(api, world))["Alpha.mov"]["error"] == "Clip detection failed: ValueError: old"
    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.json()["detect_summary"]["ran"] is True
    db.expire_all()
    assert by_name(files(api, world))["Alpha.mov"]["error"] is None


def test_redetect_is_skipped_without_a_transcript_or_while_transcribing(db, world, api):
    from apps.api.models.asset import MediaFile, TranscriptionStatus
    from apps.api.models.snippet import Snippet

    r = api.as_(world.editor).put(f"/media-files/{world.fresh_mf.id}/snippet/tracks/0/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200
    assert r.json()["detect_summary"] == {
        "ran": False, "created": 0, "removed": 0,
        "reason": "No transcript yet; clips are detected when the file is processed.",
    }

    db.query(MediaFile).filter_by(id=world.alpha_mf.id).one().transcription_status = \
        TranscriptionStatus.processing
    db.commit()
    before = db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id).count()
    r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker",
                                  json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200
    summary = r.json()["detect_summary"]
    assert summary["ran"] is False and "transcription is running" in summary["reason"]
    # The speaker is saved all the same.
    assert r.json()["speaker_id"] == str(world.ben.id) and r.json()["segments_relabelled"] == 1
    db.expire_all()
    assert db.query(Snippet).filter_by(media_file_id=world.alpha_mf.id).count() == before


def test_a_failing_detect_keeps_the_speaker_and_reports_it(db, world, api):
    from apps.api.models.snippet import SnippetTrackSpeaker

    with patch("apps.api.tasks.transcribe_tasks.detect_snippets",
               side_effect=ValueError("no windows today")):
        r = api.as_(world.editor).put(f"/media-files/{world.alpha_mf.id}/snippet/tracks/1/speaker",
                                      json={"speaker_id": str(world.ben.id)})
    assert r.status_code == 200
    assert r.json()["detect_summary"] == {
        "ran": False, "created": 0, "removed": 0,
        "reason": "Clip detection failed: ValueError: no windows today",
    }
    db.expire_all()
    assert db.query(SnippetTrackSpeaker).filter_by(
        media_file_id=world.alpha_mf.id, track_index=1).one().speaker_id == world.ben.id
    alpha = by_name(files(api, world))["Alpha.mov"]
    assert alpha["snippet_status"] == "done"
    assert alpha["error"] == "Clip detection failed: ValueError: no windows today"


# ── No speech, track counts and resume ─────────────────────────────────────


def test_no_speech_tracks_are_labelled_and_counted(db, world, api):
    """Alpha has two recorded tracks; track 0 is mapped, so a run transcribes
    exactly track 0. Fresh has no recorded streams and no mapping."""
    add_job(db, world.alpha_mf, "transcribe:track1", "done", error="no speech")
    add_job(db, world.alpha_mf, "transcribe:track0", "done")
    db.commit()
    body = by_name(files(api, world))
    alpha = body["Alpha.mov"]
    assert [t["label"] for t in alpha["tracks"]] == [
        "Lav Anna · 1 ch · de", "Track 2 · stereo · no speech"]
    assert alpha["planned_track_count"] == 1 and alpha["done_track_count"] == 1
    tracks = api.as_(world.viewer).get(f"/media-files/{world.alpha_mf.id}/snippet/tracks").json()
    assert tracks == alpha["tracks"], "one rule for both endpoints"
    fresh = body["Fresh.wav"]
    assert fresh["planned_track_count"] is None and fresh["done_track_count"] == 0


def test_a_no_speech_track_without_recorded_streams_is_still_listed(db, world, api):
    add_job(db, world.fresh_mf, "transcribe:track0", "done")
    add_job(db, world.fresh_mf, "transcribe:track2", "done", error="no speech")
    db.commit()
    rows = api.as_(world.viewer).get(f"/media-files/{world.fresh_mf.id}/snippet/tracks").json()
    assert [(r["track_index"], r["label"]) for r in rows] == [(2, "Track 3 · no speech")]


def _job_rows(db, mf):
    from apps.api.models.snippet import SnippetJob
    db.expire_all()
    return {j.stage: (j.status.value, j.error)
            for j in db.query(SnippetJob).filter(SnippetJob.media_file_id == mf.id)}


def test_process_without_force_resumes_a_failed_file(db, world, api):
    """Fresh failed on track 2 after track 1 was found silent; Alpha's
    transcript is finished. Without force: Fresh is queued with its done
    stages kept, Alpha is skipped. With force: every row of Alpha goes."""
    from apps.api.models.asset import MediaFile, TranscriptionStatus

    mf = db.query(MediaFile).filter_by(id=world.fresh_mf.id).one()
    mf.transcription_status = TranscriptionStatus.failed
    add_job(db, world.fresh_mf, "plan", "done")
    add_job(db, world.fresh_mf, "transcribe:track0", "done")
    add_job(db, world.fresh_mf, "transcribe:track1", "done", error="no speech")
    add_job(db, world.fresh_mf, "transcribe:track2", "failed", error="ConnectionError: reset")
    add_job(db, world.fresh_mf, "transcribe:track3", "running")
    for stage in ("plan", "store", "detect"):
        add_job(db, world.alpha_mf, stage, "done")
    db.commit()

    url = f"/projects/{world.A.id}/snippet/process"
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t-resume")):
        r = api.as_(world.owner).post(url, json={"asset_ids": [str(world.fresh.id), str(world.alpha.id)]})
    out = {i["asset_id"]: (i["queued"], i["reason"]) for i in r.json()["results"]}
    assert out == {str(world.fresh.id): (True, "queue"),
                   str(world.alpha.id): (False, "already transcribed")}
    assert _job_rows(db, world.fresh_mf) == {
        "plan": ("done", None),
        "transcribe:track0": ("done", None),
        "transcribe:track1": ("done", "no speech"),
        "transcribe:track2": ("pending", None),
        "transcribe:track3": ("pending", None),
    }
    assert by_name(files(api, world))["Fresh.wav"]["snippet_status"] == "queued", \
        "kept done rows do not make a waiting file look like it is running"

    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t-force")):
        r = api.as_(world.owner).post(url, json={"asset_ids": [str(world.alpha.id)], "force": True})
    assert r.json()["queued"] == 1
    assert _job_rows(db, world.alpha_mf) == {}, "force: from scratch, as before"


def test_a_failed_file_with_an_older_transcript_is_resumed_not_skipped(db, world, api):
    """Alpha has segments from an earlier run; its latest run failed. A
    retry without force continues it instead of answering "already
    transcribed" (which used to make the web force a full restart)."""
    from apps.api.models.asset import MediaFile, TranscriptionStatus

    mf = db.query(MediaFile).filter_by(id=world.alpha_mf.id).one()
    mf.transcription_status = TranscriptionStatus.failed
    add_job(db, world.alpha_mf, "transcribe:track0", "done")
    add_job(db, world.alpha_mf, "gate", "failed", error="OSError: disk full")
    db.commit()
    with patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               return_value=SimpleNamespace(id="t-retry")):
        r = api.as_(world.owner).post(f"/projects/{world.A.id}/snippet/process",
                                      json={"asset_ids": [str(world.alpha.id)]})
    assert r.json()["results"][0] == {"asset_id": str(world.alpha.id), "queued": True, "reason": "queue"}
    assert _job_rows(db, world.alpha_mf) == {"transcribe:track0": ("done", None),
                                             "gate": ("pending", None)}
