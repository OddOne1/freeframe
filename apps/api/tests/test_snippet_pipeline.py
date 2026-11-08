"""SocialSnippet transcription, end to end, with everything real except Whisper and S3.

What is real here: the task (`transcribe_asset.run`), ffmpeg extracting each
audio track from a two-track Matroska file made by ffmpeg, the RMS reader
and the bleed gate on those tracks, and the database (SQLite with foreign
keys on, every model created by `create_all`).

What is not: `faster_whisper` is replaced in sys.modules by a stub whose
WhisperModel records how it was built and called and returns scripted
segments per track; S3 is a dict. So this proves the pipeline's plumbing,
stage bookkeeping, resume and replace/refuse rules -- NOT that a real
Whisper model transcribes anything. faster-whisper is not installed in the
local test image; the first real transcription has to happen on the server.

The source file:
    track 0: a loud 440 Hz tone for 0-2 s, then silence      (speaker A)
    track 1: the same tone at -20 dB for 0-2 s (bleed),
             then a loud 660 Hz tone for 2-4 s               (speaker B)
The stub "hears" "Hallo zusammen" on both tracks at 0.2-1.6 s, and
"Guten Tag." on track 1 at 2.2-3.5 s. The gate must keep the first on
track 0 only, and the second on track 1.
"""

import io
import json
import re
import shutil
import subprocess
import sys
import types
import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


# ── database ─────────────────────────────────────────────────────────────


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


# ── media ──────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def two_track_source(tmp_path_factory):
    path = tmp_path_factory.mktemp("src") / "interview.mka"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error",
         "-f", "lavfi", "-i", "aevalsrc='if(lt(t,2),0.5*sin(2*PI*440*t),0)':s=48000:d=4",
         "-f", "lavfi", "-i",
         "aevalsrc='if(lt(t,2),0.05*sin(2*PI*440*t),0.5*sin(2*PI*660*t))':s=48000:d=4",
         "-map", "0:a", "-map", "1:a", "-c:a", "pcm_s16le", str(path)],
        check=True,
    )
    return str(path)


# ── S3 ─────────────────────────────────────────────────────────────────


class FakeS3:
    def __init__(self, files):
        self.files = files          # raw key -> local path
        self.objects = {}           # key -> bytes
        self.downloads = []
        self.fail_put = set()       # keys whose next put raises

    def download_file(self, bucket, key, path):
        self.downloads.append(key)
        shutil.copyfile(self.files[key], path)

    def get_object(self, Bucket, Key):  # noqa: N803
        from botocore.exceptions import ClientError
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}

    def put(self, key, body, content_type=None, cache_control=None):
        for suffix in list(self.fail_put):
            if key.endswith(suffix):
                self.fail_put.discard(suffix)
                raise ConnectionError(f"simulated S3 outage writing {key}")
        self.objects[key] = body

    def json(self, suffix):
        keys = [k for k in self.objects if k.endswith(suffix)]
        assert len(keys) == 1, (suffix, sorted(self.objects))
        return json.loads(self.objects[keys[0]])

    def has(self, suffix):
        return any(k.endswith(suffix) for k in self.objects)


# ── the Whisper stub ───────────────────────────────────────────────────────


def _seg(start, end, *words, text=None):
    return SimpleNamespace(
        start=start, end=end,
        text=text if text is not None else "".join(w for _, _, w in words),
        words=[SimpleNamespace(start=s, end=e, word=w, probability=0.95) for s, e, w in words],
    )


HALLO = ((0.2, 0.7, " Hallo"), (0.8, 1.6, " zusammen"))
GUTEN = ((2.2, 2.7, " Guten"), (2.8, 3.5, " Tag."))


class Stub:
    """Stands in for the faster_whisper module."""

    def __init__(self):
        self.inits = []           # (size, kwargs) per WhisperModel(...)
        self.calls = []           # (track or None, kwargs) per transcribe(...)
        self.script = {
            0: lambda: [_seg(0.2, 1.6, *HALLO)],
            1: lambda: [_seg(0.2, 1.6, *HALLO), _seg(2.2, 3.5, *GUTEN)],
            2: lambda: [_seg(0.2, 1.6, *HALLO)],
            3: lambda: [_seg(2.2, 3.5, *GUTEN)],
            None: lambda: [_seg(0.2, 1.6, *HALLO, text=" Hallo zusammen")],
        }
        self.languages = {0: "de", 1: "de", 2: "de", 3: "de", None: "de"}
        stub = self

        class WhisperModel:
            def __init__(self, size, **kwargs):
                stub.inits.append((size, kwargs))

            def transcribe(self, path, **kwargs):
                m = re.search(r"track_(\d+)\.wav$", path)
                track = int(m.group(1)) if m else None
                stub.calls.append((track, kwargs))
                segments = stub.script[track]()   # may raise
                info = SimpleNamespace(language=stub.languages[track],
                                       language_probability=0.97, duration=4.0)
                return iter(segments), info

        self.module = types.ModuleType("faster_whisper")
        self.module.WhisperModel = WhisperModel

    def calls_for(self, track):
        return [c for c in self.calls if c[0] == track]


# ── the world ──────────────────────────────────────────────────────────────


class World:
    pass


def _build_world(Session, source, *, snippet=True, enabled=True, source_folder="none",
                 asset_folder="root", metadata=None, speakers=True):
    """One project, one asset with one version and media file.

    source_folder: "none" (whole project) | "src" (the asset must be inside)
    asset_folder:  "root" (project root) | "src" | "nested" (below src) | "other"
    """
    from apps.api.models.asset import (
        Asset, AssetType, AssetVersion, FileType, MediaFile, ProcessingStatus,
    )
    from apps.api.models.folder import Folder
    from apps.api.models.project import Project, ProjectType
    from apps.api.models.snippet import SnippetProjectSettings, SnippetSpeaker, SnippetTrackSpeaker
    from apps.api.models.user import User, UserGlobalRole, UserStatus

    w = World()
    db = Session()
    user = User(id=uuid.uuid4(), email=f"{uuid.uuid4().hex[:8]}@example.com",
                first_name="T", last_name="U", password_hash="x",
                status=UserStatus.active, role=UserGlobalRole.superuser)
    db.add(user)
    db.flush()
    project = Project(id=uuid.uuid4(), name="P", project_type=ProjectType.personal,
                      created_by=user.id)
    db.add(project)
    db.flush()
    folders = {}
    for name, parent in (("src", None), ("nested", "src"), ("other", None)):
        f = Folder(id=uuid.uuid4(), project_id=project.id, name=name,
                   parent_id=folders[parent].id if parent else None, created_by=user.id)
        db.add(f)
        db.flush()
        folders[name] = f

    asset = Asset(id=uuid.uuid4(), project_id=project.id, name="interview.mka",
                  asset_type=AssetType.audio, created_by=user.id,
                  folder_id=None if asset_folder == "root" else folders[asset_folder].id,
                  transcription_enabled=True)
    db.add(asset)
    db.flush()
    version = AssetVersion(id=uuid.uuid4(), asset_id=asset.id, version_number=1,
                           processing_status=ProcessingStatus.ready, created_by=user.id)
    db.add(version)
    db.flush()
    raw_key = f"raw/{project.id}/{asset.id}/{version.id}/original.mka"
    media = MediaFile(id=uuid.uuid4(), version_id=version.id, file_type=FileType.audio,
                      original_filename="interview.mka", mime_type="audio/x-matroska",
                      file_size_bytes=1, s3_key_raw=raw_key, technical_metadata=metadata)
    db.add(media)
    db.flush()

    if snippet:
        db.add(SnippetProjectSettings(
            project_id=project.id, enabled=enabled,
            source_folder_id=folders["src"].id if source_folder == "src" else None,
        ))
        if speakers:
            anna = SnippetSpeaker(id=uuid.uuid4(), project_id=project.id, name="Anna Ödegaard")
            ben = SnippetSpeaker(id=uuid.uuid4(), project_id=project.id, name="Ben Ćosić")
            db.add_all([anna, ben])
            db.flush()
            db.add_all([
                SnippetTrackSpeaker(media_file_id=media.id, track_index=0, speaker_id=anna.id),
                SnippetTrackSpeaker(media_file_id=media.id, track_index=1, speaker_id=ben.id),
            ])
            w.anna, w.ben = anna.id, ben.id
    db.commit()

    w.Session = Session
    w.project_id, w.asset_id, w.version_id, w.media_file_id = project.id, asset.id, version.id, media.id
    w.folders = {k: v.id for k, v in folders.items()}
    w.s3 = FakeS3({raw_key: source})
    w.events = []
    db.close()
    return w


@pytest.fixture
def stub(monkeypatch):
    from apps.api.tasks import transcribe_tasks
    s = Stub()
    monkeypatch.setitem(sys.modules, "faster_whisper", s.module)
    monkeypatch.setattr(transcribe_tasks, "_model", None)
    monkeypatch.setattr(transcribe_tasks, "_model_key", None)
    return s


def run(w):
    """Run the task once. Returns the exception it raised, or None."""
    from apps.api.tasks import transcribe_tasks

    with patch.object(transcribe_tasks, "SessionLocal", w.Session), \
         patch.object(transcribe_tasks, "get_s3_client", return_value=w.s3), \
         patch.object(transcribe_tasks, "put_object", side_effect=w.s3.put), \
         patch.object(transcribe_tasks, "_publish_event",
                      side_effect=lambda pid, kind, payload: w.events.append((kind, payload))), \
         patch.object(transcribe_tasks.transcribe_asset, "retry",
                      side_effect=RuntimeError("retry called")):
        try:
            transcribe_tasks.transcribe_asset.run(str(w.asset_id), str(w.version_id))
        except Exception as exc:  # noqa: BLE001 -- the test inspects it
            return exc
    return None


def jobs(w):
    from apps.api.models.snippet import SnippetJob
    db = w.Session()
    try:
        return {j.stage: (j.status.value, j.attempts, j.error)
                for j in db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id)}
    finally:
        db.close()


def segments(w):
    from apps.api.models.snippet import TranscriptSegment, TranscriptWord
    db = w.Session()
    try:
        out = []
        for s in (db.query(TranscriptSegment)
                  .filter(TranscriptSegment.media_file_id == w.media_file_id)
                  .order_by(TranscriptSegment.track_index, TranscriptSegment.seq)):
            words = (db.query(TranscriptWord).filter(TranscriptWord.segment_id == s.id)
                     .order_by(TranscriptWord.idx).all())
            out.append(SimpleNamespace(
                id=s.id, track=s.track_index, seq=s.seq, speaker=s.speaker_id,
                start_ms=s.start_ms, end_ms=s.end_ms, language=s.language,
                text_ai=s.text_ai, text_current=s.text_current, status=s.status.value,
                words=[(x.idx, x.start_ms, x.end_ms, x.word, x.probability) for x in words],
            ))
        return out
    finally:
        db.close()


def media(w):
    from apps.api.models.asset import MediaFile
    db = w.Session()
    try:
        m = db.query(MediaFile).filter(MediaFile.id == w.media_file_id).first()
        return SimpleNamespace(status=m.transcription_status.value, progress=m.transcription_progress,
                               transcript=m.s3_key_transcript, captions=m.s3_key_captions,
                               language=m.transcript_language, task_id=m.transcription_task_id)
    finally:
        db.close()


def reset_jobs(w):
    from apps.api.models.snippet import SnippetJob
    db = w.Session()
    db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id).delete()
    db.commit()
    db.close()


# `detect` runs after `store` and makes `snippets` rows from the stored
# transcript. It is in this set because a healthy run reaches it; what makes
# it different from the others -- a failure there does NOT fail the
# transcription -- is covered in test_snippet_detect.py.
ALL_DONE = {"plan", "transcribe:track0", "transcribe:track1", "gate", "store", "detect"}


# ── the full run ─────────────────────────────────────────────────────────


def test_a_broken_detect_stage_does_not_fail_the_transcription(
    Session, two_track_source, stub, monkeypatch,
):
    """`detect` is the one stage allowed to fail quietly.

    By the time it runs the transcript is stored and the file is `ready`, so
    a clip suggester that falls over must not undo a good transcription. Its
    error is recorded on its own row and the run still succeeds. The rest of
    the detect behaviour lives in test_snippet_detect.py.
    """
    from apps.api.tasks import transcribe_tasks

    monkeypatch.setattr(
        transcribe_tasks, "detect_snippets",
        lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("suggester fell over")),
    )
    w = _build_world(Session, two_track_source)
    assert run(w) is None, "the task still succeeded"

    j = jobs(w)
    assert j["detect"][0] == "failed"
    assert "suggester fell over" in j["detect"][2]
    # Every OTHER stage is done, and the transcript is in place.
    assert {stage for stage, (status, _a, _e) in j.items() if status == "done"} == (
        ALL_DONE - {"detect"}
    )
    assert segments(w), "the stored transcript survived"
    assert media(w).status == "ready"
    assert [kind for kind, _payload in w.events if kind == "transcription_complete"] == [
        "transcription_complete"
    ], "the completion event was still published"


def test_full_run_records_every_stage_and_writes_gated_segments(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    assert run(w) is None

    j = jobs(w)
    assert set(j) == ALL_DONE
    assert all(status == "done" and attempts == 1 and error is None
               for status, attempts, error in j.values()), j

    for suffix in ("snippet/plan.json", "snippet/raw_track_0.json", "snippet/raw_track_1.json",
                   "snippet/gated.json", "/transcript.json", "/captions.vtt"):
        assert w.s3.has(suffix), suffix
    plan = w.s3.json("snippet/plan.json")
    assert plan["tracks"] == [0, 1]
    assert plan["streams_from"] == "ffprobe", "no audio_streams in metadata: probed the file"
    assert [s["channels"] for s in plan["audio_streams"]] == [1, 1]
    raw1 = w.s3.json("snippet/raw_track_1.json")
    assert [len(s["words"]) for s in raw1["segments"]] == [2, 2], "raw output keeps the bleed"
    assert raw1["rms"]["frame_ms"] == 100 and len(raw1["rms"]["values"]) == 40
    gated = w.s3.json("snippet/gated.json")
    assert gated["dropped_segments"] == 1 and gated["dropped_words"] == 2

    segs = segments(w)
    assert [(s.track, s.seq, s.text_ai, s.speaker) for s in segs] == [
        (0, 0, "Hallo zusammen", w.anna),
        (1, 0, "Guten Tag.", w.ben),
    ], "track 1's copy of track 0's words is bleed and must be gone"
    for s in segs:
        assert s.text_current == s.text_ai and s.status == "ai" and s.language == "de"
    assert (segs[0].start_ms, segs[0].end_ms) == (200, 1600)
    assert segs[0].words == [(0, 200, 700, " Hallo", 0.95), (1, 800, 1600, " zusammen", 0.95)]
    assert (segs[1].start_ms, segs[1].end_ms) == (2200, 3500)

    transcript = w.s3.json("/transcript.json")
    assert set(transcript) == {"language", "language_probability", "duration", "text", "segments"}
    assert transcript["segments"] == [
        {"id": 0, "start": 0.2, "end": 1.6, "text": "Hallo zusammen"},
        {"id": 1, "start": 2.2, "end": 3.5, "text": "Guten Tag."},
    ]
    assert transcript["language"] == "de" and transcript["text"] == "Hallo zusammen Guten Tag."
    vtt = next(v for k, v in w.s3.objects.items() if k.endswith("/captions.vtt")).decode()
    assert vtt.startswith("WEBVTT") and "00:00:02.200 --> 00:00:03.500" in vtt

    m = media(w)
    assert (m.status, m.progress, m.language, m.task_id) == ("ready", 100, "de", None)
    assert m.transcript.endswith(f"/{w.asset_id}/{w.version_id}/transcript.json")

    # The model: the SocialSnippet size and threads, online by default.
    assert stub.inits == [("medium", {"device": "cpu", "compute_type": "int8",
                                      "local_files_only": False, "cpu_threads": 8})]
    assert [c[0] for c in stub.calls] == [0, 1]
    for _track, kwargs in stub.calls:
        assert kwargs["word_timestamps"] is True and kwargs["vad_filter"] is True
        assert "language" not in kwargs, "language is detected per track"
        assert kwargs["initial_prompt"] == "Anna Ödegaard, Ben Ćosić."

    kinds = [k for k, _ in w.events]
    assert kinds[0] == "transcription_processing" and kinds[-1] == "transcription_complete"
    percents = [p["percent"] for k, p in w.events if k == "transcription_progress"]
    assert percents == sorted(percents) and percents[-1] == 100
    assert 50 in percents, "track 0 finished = half way: progress is averaged across tracks"
    assert w.events[-1][1]["segment_count"] == 2


def test_recorded_audio_streams_are_used_instead_of_probing(Session, two_track_source, stub):
    metadata = {"audio_stream_count": 2, "audio_streams": [
        {"stream_index": 0, "audio_index": 0, "codec": "pcm_s16le", "channels": 1},
        {"stream_index": 1, "audio_index": 1, "codec": "pcm_s16le", "channels": 1},
    ]}
    w = _build_world(Session, two_track_source, metadata=metadata, speakers=False)
    assert run(w) is None
    assert w.s3.json("snippet/plan.json")["streams_from"] == "technical_metadata"
    segs = segments(w)
    assert [(s.track, s.text_ai, s.speaker) for s in segs] == [
        (0, "Hallo zusammen", None), (1, "Guten Tag.", None),
    ], "unmapped tracks: no speaker, still one track each"
    assert "initial_prompt" not in stub.calls[0][1], "no speakers, no prompt"


# ── resume ───────────────────────────────────────────────────────────────


def test_a_crash_in_track_1_resumes_without_redoing_track_0(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    ok_track1 = stub.script[1]

    def _crash():
        raise ConnectionError("worker lost the S3 connection in track 1")

    stub.script[1] = _crash
    exc = run(w)
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc)

    j = jobs(w)
    assert j["plan"][:2] == ("done", 1)
    assert j["transcribe:track0"][:2] == ("done", 1)
    assert j["transcribe:track1"][:2] == ("failed", 1)
    assert "worker lost the S3 connection in track 1" in j["transcribe:track1"][2]
    assert "gate" not in j and "store" not in j
    assert w.s3.has("snippet/raw_track_0.json") and not w.s3.has("snippet/raw_track_1.json")
    assert segments(w) == []
    assert media(w).status == "failed"
    assert w.events[-1][0] == "transcription_failed"

    stub.script[1] = ok_track1
    assert run(w) is None

    assert len(stub.calls_for(0)) == 1, "track 0 was finished and must not be transcribed again"
    assert len(stub.calls_for(1)) == 2
    j = jobs(w)
    assert set(j) == ALL_DONE
    assert j["transcribe:track0"][:2] == ("done", 1)
    assert j["transcribe:track1"][:2] == ("done", 2)
    assert j["plan"][:2] == ("done", 1), "the plan is reused, not re-made"
    assert [s.text_ai for s in segments(w)] == ["Hallo zusammen", "Guten Tag."]
    assert media(w).status == "ready"


def test_a_failure_after_every_track_resumes_without_downloading_or_transcribing(
        Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    w.s3.fail_put.add("/transcript.json")
    exc = run(w)
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc)
    j = jobs(w)
    assert j["gate"][0] == "done" and j["store"][0] == "failed"
    assert "simulated S3 outage" in j["store"][2]
    assert segments(w) == []
    downloads, calls = len(w.s3.downloads), len(stub.calls)

    assert run(w) is None
    assert len(w.s3.downloads) == downloads, "every track was done: the original is not fetched"
    assert len(stub.calls) == calls, "nothing is transcribed again"
    assert jobs(w)["store"][:2] == ("done", 2)
    assert len(segments(w)) == 2


# ── replace and refuse ───────────────────────────────────────────────────


def test_unedited_segments_are_replaced(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    first = segments(w)

    reset_jobs(w)  # what snippet_reprocess.py does
    stub.script[0] = lambda: [_seg(0.2, 1.6, (0.2, 0.7, " Hallo"), (0.8, 1.6, " allerseits"))]
    assert run(w) is None

    second = segments(w)
    assert [s.text_ai for s in second] == ["Hallo allerseits", "Guten Tag."]
    assert not ({s.id for s in first} & {s.id for s in second}), "old rows are gone, not kept beside"
    from apps.api.models.snippet import TranscriptWord
    db = w.Session()
    assert db.query(TranscriptWord).count() == 4, "no orphaned words from the first run"
    db.close()


def _edit_first_segment(w, text="Hallo zusammen (edited)"):
    from apps.api.models.snippet import SegmentStatus, TranscriptSegment
    db = w.Session()
    seg = (db.query(TranscriptSegment)
           .filter(TranscriptSegment.media_file_id == w.media_file_id,
                   TranscriptSegment.track_index == 0).first())
    seg.text_current = text
    seg.status = SegmentStatus.edited
    db.commit()
    db.close()


def test_an_edited_segment_refuses_the_run_and_nothing_changes(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    _edit_first_segment(w)
    before_segments = segments(w)
    before_objects = dict(w.s3.objects)
    calls = len(stub.calls)
    reset_jobs(w)
    w.events.clear()

    assert run(w) is None, "a refusal is final: no retry"

    assert len(stub.calls) == calls, "refused before any transcription"
    assert segments(w) == before_segments
    assert w.s3.objects == before_objects
    j = jobs(w)
    assert set(j) == {"store"}
    status, _attempts, error = j["store"]
    assert status == "failed" and "edited by a person" in error and "Nothing was changed" in error
    assert media(w).status == "ready", "the existing transcript is still there and still shown"
    assert [k for k, _ in w.events] == ["transcription_failed"]
    assert "edited" in w.events[0][1]["error"]


def test_an_edit_made_during_the_run_is_still_not_overwritten(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    transcript_before = next(v for k, v in w.s3.objects.items() if k.endswith("/transcript.json"))
    reset_jobs(w)

    ok_track1 = stub.script[1]

    def _edit_then_transcribe():
        _edit_first_segment(w)    # someone edits while track 1 is transcribing
        return ok_track1()

    stub.script[1] = _edit_then_transcribe
    assert run(w) is None

    j = jobs(w)
    assert j["transcribe:track1"][0] == "done" and j["gate"][0] == "done"
    assert j["store"][0] == "failed" and "edited by a person" in j["store"][2]
    assert segments(w)[0].text_current == "Hallo zusammen (edited)"
    assert next(v for k, v in w.s3.objects.items() if k.endswith("/transcript.json")) == transcript_before


# ── which path ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("kwargs", [
    {"snippet": False},
    {"enabled": False},
    {"source_folder": "src", "asset_folder": "other"},
    {"source_folder": "src", "asset_folder": "root"},
], ids=["no-settings", "disabled", "other-folder", "project-root"])
def test_everything_else_takes_the_original_path_unchanged(Session, two_track_source, stub, kwargs):
    w = _build_world(Session, two_track_source, **kwargs)
    assert run(w) is None

    assert stub.inits == [("small", {"device": "cpu", "compute_type": "int8",
                                     "local_files_only": False})], \
        "the original model size and no cpu_threads override"
    assert stub.calls == [(None, {"vad_filter": True})], "the original call, exactly"
    assert jobs(w) == {} and segments(w) == []
    transcript = w.s3.json("/transcript.json")
    assert transcript["segments"] == [{"id": 0, "start": 0.2, "end": 1.6, "text": "Hallo zusammen"}]
    assert not any("/snippet/" in k for k in w.s3.objects)
    assert media(w).status == "ready"


@pytest.mark.parametrize("asset_folder", ["src", "nested"])
def test_the_source_folder_and_its_descendants_take_the_new_path(
        Session, two_track_source, stub, asset_folder):
    w = _build_world(Session, two_track_source, source_folder="src", asset_folder=asset_folder)
    assert run(w) is None
    assert set(jobs(w)) == ALL_DONE


def test_offline_mode_loads_the_model_from_local_files_only(
        Session, two_track_source, stub, monkeypatch):
    from apps.api.config import settings
    monkeypatch.setattr(settings, "whisper_offline", True)
    w = _build_world(Session, two_track_source, snippet=False)
    assert run(w) is None
    assert stub.inits[0][1]["local_files_only"] is True


def test_a_mapped_track_that_does_not_exist_fails_without_retrying(Session, two_track_source, stub):
    from apps.api.models.snippet import SnippetTrackSpeaker
    w = _build_world(Session, two_track_source)
    db = w.Session()
    db.add(SnippetTrackSpeaker(media_file_id=w.media_file_id, track_index=5, speaker_id=w.anna))
    db.commit()
    db.close()

    assert run(w) is None, "no retry: a retry would fail the same way"
    status, _a, error = jobs(w)["plan"]
    assert status == "failed" and "track(s) [5]" in error and "tracks are [0, 1]" in error
    assert stub.calls == []
    assert media(w).status == "failed"


# ── routing ──────────────────────────────────────────────────────────────


def test_every_transcribe_task_routes_to_the_transcription_queue():
    """The pipeline adds no task of its own: it runs inside transcribe_asset.
    Asserted through Celery's own router, so a task added to this module
    later without a working route fails here."""
    from apps.api.tasks import transcribe_tasks
    from apps.api.tasks.celery_app import celery_app

    names = [name for name, task in celery_app.tasks.items()
             if getattr(task, "__module__", "") == transcribe_tasks.__name__]
    assert names == ["apps.api.tasks.transcribe_tasks.transcribe_asset"], names
    for name in names:
        route = celery_app.amqp.router.route({}, name)
        queue = route["queue"]
        assert getattr(queue, "name", queue) == "transcription", (name, route)


# ── scripts ──────────────────────────────────────────────────────────────


def test_set_track_speaker_creates_reuses_and_relabels(Session, two_track_source, stub):
    from apps.api.scripts.snippet_set_track_speaker import (
        ScriptError, list_tracks, set_track_speaker,
    )
    w = _build_world(Session, two_track_source, speakers=False)
    assert run(w) is None
    db = w.Session()

    r = set_track_speaker(db, w.media_file_id, 1, "  Carla   Núñez ")
    assert r["speaker_created"] and r["speaker_name"] == "Carla Núñez"
    assert r["segments_relabelled"] == 1
    again = set_track_speaker(db, w.media_file_id, 0, "carla núñez")
    assert not again["speaker_created"] and again["speaker_id"] == r["speaker_id"]
    other = set_track_speaker(db, w.media_file_id, 1, "Dario")
    assert other["previous_speaker_id"] == r["speaker_id"]

    info = list_tracks(db, w.media_file_id)
    assert info["mapping"] == {0: "Carla Núñez", 1: "Dario"}
    assert info["would_transcribe"] == [0, 1]
    assert [str(s.speaker) for s in segments(w)] == [r["speaker_id"], other["speaker_id"]]
    db.close()

    db = w.Session()
    from apps.api.models.asset import MediaFile
    m = db.query(MediaFile).filter(MediaFile.id == w.media_file_id).first()
    m.technical_metadata = {"audio_streams": [{"audio_index": 0, "channels": 1}]}
    db.commit()
    with pytest.raises(ScriptError, match="no track 3"):
        set_track_speaker(db, w.media_file_id, 3, "Eve")
    db.close()


def test_forced_reprocess_resets_stages_and_queues_only_what_is_in_scope(Session, two_track_source, stub):
    from apps.api.scripts.snippet_reprocess import find_candidates, reprocess
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    assert set(jobs(w)) == ALL_DONE

    db = w.Session()
    candidates = find_candidates(db, project_id=w.project_id)
    assert [(c.asset_id, c.enqueue) for c in candidates] == [(str(w.asset_id), True)]

    queued = []
    n = reprocess(db, candidates,
                  lambda a, v: queued.append((a, v)) or SimpleNamespace(id="task-123"),
                  force=True)
    db.close()
    assert n == 1 and queued == [(str(w.asset_id), str(w.version_id))]
    assert jobs(w) == {}, "forced: stages reset, the next run redoes every track"
    m = media(w)
    assert (m.status, m.task_id, m.progress) == ("processing", "task-123", 0)

    # Already running -> skipped; and an edited transcript is never queued.
    db = w.Session()
    assert find_candidates(db, asset_id=w.asset_id)[0].reason == "a transcription is already running"
    db.close()
    assert run(w) is None
    _edit_first_segment(w)
    db = w.Session()
    c = find_candidates(db, asset_id=w.asset_id)[0]
    assert not c.enqueue and "edited" in c.reason
    db.close()


def test_reprocess_skips_projects_without_socialsnippet(Session, two_track_source, stub):
    from apps.api.scripts.snippet_reprocess import find_candidates
    w = _build_world(Session, two_track_source, snippet=False)
    db = w.Session()
    c = find_candidates(db, project_id=w.project_id)
    db.close()
    assert len(c) == 1 and not c[0].enqueue and "not enabled" in c[0].reason


# ── tracks without speech ────────────────────────────────────────────────
#
# A track with no speech must never fail the job. Two ways to find out:
# its level (no Whisper pass at all), or faster-whisper 1.0.3's one
# ValueError when its VAD removed the whole track. Either way the stage is
# done with the note "no speech", and a resume keeps it.

TONE = "0.5*sin(2*PI*440*t)"


def _make_source(path, *expressions, seconds=4):
    """A Matroska file with one mono PCM track per aevalsrc expression ("0" = silence)."""
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for expr in expressions:
        cmd += ["-f", "lavfi", "-i", f"aevalsrc='{expr}':s=48000:d={seconds}"]
    for i in range(len(expressions)):
        cmd += ["-map", f"{i}:a"]
    cmd += ["-c:a", "pcm_s16le", str(path)]
    subprocess.run(cmd, check=True)
    return str(path)


@pytest.fixture(scope="module")
def three_tracks_one_silent(tmp_path_factory):
    return _make_source(
        tmp_path_factory.mktemp("src3") / "three.mka",
        "if(lt(t,2),0.5*sin(2*PI*440*t),0)",
        "if(lt(t,2),0.05*sin(2*PI*440*t),0.5*sin(2*PI*660*t))",
        "0",
    )


@pytest.fixture(scope="module")
def four_tracks(tmp_path_factory):
    return _make_source(tmp_path_factory.mktemp("src4") / "four.mka", TONE, TONE, TONE, TONE)


@pytest.fixture(scope="module")
def silent_wav(tmp_path_factory):
    """A real, generated silent WAV: one track, digital silence."""
    path = tmp_path_factory.mktemp("silent") / "silent.wav"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                    "-t", "4", "-c:a", "pcm_s16le", str(path)], check=True)
    return str(path)


@pytest.fixture(scope="module")
def two_silent_tracks(tmp_path_factory):
    return _make_source(tmp_path_factory.mktemp("src2s") / "silent2.mka", "0", "0")


def _labels(w):
    from apps.api.models.asset import MediaFile
    from apps.api.services import snippet_admin
    db = w.Session()
    try:
        mf = db.query(MediaFile).filter(MediaFile.id == w.media_file_id).first()
        return {r["track_index"]: r["label"] for r in snippet_admin.track_rows(db, mf)}
    finally:
        db.close()


def test_a_silent_track_among_speech_tracks_is_skipped_by_level(
        Session, three_tracks_one_silent, stub):
    w = _build_world(Session, three_tracks_one_silent, speakers=False)
    assert run(w) is None, "a silent track does not fail the job"

    assert [c[0] for c in stub.calls] == [0, 1], "no Whisper pass on the silent track"
    j = jobs(w)
    assert j["transcribe:track2"] == ("done", 1, "no speech")
    assert j["transcribe:track0"] == ("done", 1, None) and j["transcribe:track1"] == ("done", 1, None)
    assert j["store"] == ("done", 1, None) and j["detect"][0] == "done"
    raw2 = w.s3.json("snippet/raw_track_2.json")
    assert raw2["no_speech"] is True and raw2["no_speech_reason"] == "level"
    assert raw2["segments"] == [] and raw2["model"] is None and raw2["language"] is None
    assert len(raw2["rms"]["values"]) == 40, "stored like any per-track result"
    assert [(s.track, s.text_ai) for s in segments(w)] == [(0, "Hallo zusammen"), (1, "Guten Tag.")]
    assert media(w).status == "ready"
    assert w.events[-1][0] == "transcription_complete" and "message" not in w.events[-1][1]

    labels = _labels(w)
    assert labels[2].endswith(" · no speech") and "no speech" not in labels[0] + labels[1]

    from apps.api.scripts.snippet_set_track_speaker import _print_list, list_tracks
    db = w.Session()
    info = list_tracks(db, w.media_file_id)
    db.close()
    assert info["labels"][2].endswith("no speech")


def test_set_track_speaker_list_prints_no_speech(Session, three_tracks_one_silent, stub, capsys):
    from apps.api.scripts.snippet_set_track_speaker import main
    w = _build_world(Session, three_tracks_one_silent, speakers=False)
    assert run(w) is None
    with patch("apps.api.scripts.snippet_set_track_speaker.SessionLocal", w.Session):
        assert main(["--media-file-id", str(w.media_file_id), "--list"]) == 0
    out = capsys.readouterr().out
    lines = {ln.split(":")[0].strip(): ln for ln in out.splitlines() if ln.strip().startswith("track ")}
    assert "no speech" in lines["track 2"], out
    assert "no speech" not in lines["track 0"] and "no speech" not in lines["track 1"], out


def test_whispers_no_speech_error_marks_the_track_and_the_job_goes_on(
        Session, two_track_source, stub):
    """Loud enough for the level check, but Whisper's VAD removes it all:
    faster-whisper 1.0.3 raises ValueError('max() arg is an empty sequence')."""
    w = _build_world(Session, two_track_source)

    def _vad_removed_everything():
        raise ValueError("max() arg is an empty sequence")

    stub.script[1] = _vad_removed_everything
    assert run(w) is None, "not failed, not retried"
    j = jobs(w)
    assert j["transcribe:track1"] == ("done", 1, "no speech")
    raw1 = w.s3.json("snippet/raw_track_1.json")
    assert raw1["no_speech"] is True and raw1["no_speech_reason"] == "vad"
    assert raw1["model"] == "medium", "Whisper did run on it"
    assert [(s.track, s.text_ai) for s in segments(w)] == [(0, "Hallo zusammen")]
    assert media(w).status == "ready" and len(w.s3.downloads) == 1

    # A resume keeps the marker: track 1 is not asked again.
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus
    db = w.Session()
    db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id,
                                SnippetJob.stage.in_(["gate", "store", "detect"])) \
        .update({SnippetJob.status: SnippetJobStatus.pending}, synchronize_session=False)
    db.commit()
    db.close()
    calls = len(stub.calls)
    assert run(w) is None
    assert len(stub.calls) == calls and jobs(w)["transcribe:track1"] == ("done", 1, "no speech")


@pytest.mark.parametrize("message", [
    "max() arg is an empty sequence (not quite)",
    "could not broadcast input array",
])
def test_any_other_value_error_fails_the_stage_at_once_without_retry(
        Session, two_track_source, stub, message):
    """Regression: only the one exact message is "no speech". Every other
    ValueError propagates -- and, being deterministic, is not retried."""
    w = _build_world(Session, two_track_source)

    def _broken():
        raise ValueError(message)

    stub.script[1] = _broken
    exc = run(w)
    assert type(exc) is ValueError and str(exc) == message, "propagated as-is, not via retry()"
    j = jobs(w)
    assert j["transcribe:track1"][0] == "failed" and message in j["transcribe:track1"][2]
    assert j["transcribe:track0"][0] == "done", "the finished track is kept for a resume"
    assert media(w).status == "failed"
    assert w.events[-1][0] == "transcription_failed"
    assert len(w.s3.downloads) == 1


def test_a_transient_error_is_retried(Session, two_track_source, stub):
    w = _build_world(Session, two_track_source)
    w.s3.fail_put.add("snippet/gated.json")
    exc = run(w)
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc)
    assert jobs(w)["gate"][0] == "failed"


@pytest.mark.parametrize("source", ["silent_wav", "two_silent_tracks"])
def test_no_speech_on_any_track_is_done_with_zero_segments(Session, stub, request, source):
    """Real ffmpeg on a generated silent file: done, not failed, zero
    segments, "no speech found", and a detect stage that creates nothing."""
    w = _build_world(Session, request.getfixturevalue(source), speakers=False)
    assert run(w) is None

    assert stub.inits == [] and stub.calls == [], "the model is never even loaded"
    j = jobs(w)
    tracks = [s for s in j if s.startswith("transcribe:")]
    assert tracks and all(j[t] == ("done", 1, "no speech") for t in tracks)
    assert j["gate"][0] == "done"
    assert j["store"] == ("done", 1, "no speech found")
    assert j["detect"] == ("done", 1, None), "detect ran on nothing and did not fail"
    assert segments(w) == []
    from apps.api.models.snippet import Snippet
    db = w.Session()
    assert db.query(Snippet).filter(Snippet.media_file_id == w.media_file_id).count() == 0
    db.close()
    m = media(w)
    assert (m.status, m.progress, m.task_id) == ("ready", 100, None)
    transcript = w.s3.json("/transcript.json")
    assert transcript["segments"] == [] and transcript["text"] == ""
    kind, payload = w.events[-1]
    assert kind == "transcription_complete"
    assert payload["segment_count"] == 0 and payload["message"] == "no speech found"

    from apps.api.models.asset import TranscriptionStatus
    from apps.api.models.snippet import SnippetJob
    from apps.api.services.snippet_files import JobView, derive_status
    db = w.Session()
    views = [JobView(r.stage, r.status, r.error, r.updated_at)
             for r in db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id)]
    db.close()
    assert derive_status(TranscriptionStatus.ready, views, 0) == ("done", None)


# ── resume ───────────────────────────────────────────────────────────────


def test_a_transient_failure_on_track_2_of_4_resumes_from_track_2(Session, four_tracks, stub):
    w = _build_world(Session, four_tracks, speakers=False)
    ok = stub.script[2]
    stub.script[2] = lambda: (_ for _ in ()).throw(ConnectionError("S3 read timed out"))
    exc = run(w)
    assert isinstance(exc, RuntimeError) and "retry called" in str(exc)
    j = jobs(w)
    assert [j[f"transcribe:track{t}"][0] for t in (0, 1, 2)] == ["done", "done", "failed"]
    assert "transcribe:track3" not in j

    stub.script[2] = ok
    assert run(w) is None, "the Celery retry"
    assert [len(stub.calls_for(t)) for t in range(4)] == [1, 1, 2, 1], \
        "tracks 0 and 1 are not transcribed again"
    j = jobs(w)
    assert j["transcribe:track0"][:2] == ("done", 1) and j["transcribe:track1"][:2] == ("done", 1)
    assert j["transcribe:track2"][:2] == ("done", 2) and j["transcribe:track3"][:2] == ("done", 1)
    assert media(w).status == "ready"


def test_requeueing_a_failed_file_resumes_and_force_starts_over(Session, four_tracks, stub):
    """snippet_reprocess.py without --force keeps every done stage, the
    "no speech" one included; with --force everything restarts."""
    from apps.api.scripts.snippet_reprocess import find_candidates, main, reprocess
    w = _build_world(Session, four_tracks, speakers=False)
    stub.script[1] = lambda: (_ for _ in ()).throw(ValueError("max() arg is an empty sequence"))
    ok = stub.script[2]
    stub.script[2] = lambda: (_ for _ in ()).throw(ValueError("a deterministic bug"))
    exc = run(w)
    assert type(exc) is ValueError, "deterministic: no retry, the job stops"
    assert media(w).status == "failed"
    assert jobs(w)["transcribe:track1"] == ("done", 1, "no speech")

    # Queue it again, as snippet_reprocess.py does (no --force).
    queued = []
    with patch("apps.api.scripts.snippet_reprocess.SessionLocal", w.Session), \
         patch("apps.api.tasks.transcribe_tasks.transcribe_asset.delay",
               side_effect=lambda a, v: queued.append(a) or SimpleNamespace(id="t-resume")):
        assert main(["--asset-id", str(w.asset_id)]) == 0
    assert queued == [str(w.asset_id)]
    j = jobs(w)
    assert j["plan"][0] == "done" and j["transcribe:track0"][0] == "done"
    assert j["transcribe:track1"] == ("done", 1, "no speech"), "the no-speech marker is kept"
    assert j["transcribe:track2"] == ("pending", 1, None), "the failed stage is back to pending"
    assert media(w).status == "processing"

    stub.script[2] = ok
    downloads = len(w.s3.downloads)
    assert run(w) is None
    assert [len(stub.calls_for(t)) for t in range(4)] == [1, 1, 2, 1]
    assert len(w.s3.downloads) == downloads + 1, "fetched once, for tracks 2 and 3"
    assert jobs(w)["transcribe:track1"] == ("done", 1, "no speech")
    assert media(w).status == "ready"

    # --force: every stage row goes, every track is transcribed again.
    db = w.Session()
    n = reprocess(db, find_candidates(db, asset_id=w.asset_id),
                  lambda a, v: SimpleNamespace(id="t-force"), force=True)
    db.close()
    assert n == 1 and jobs(w) == {}
    assert run(w) is None
    assert [len(stub.calls_for(t)) for t in range(4)] == [2, 2, 3, 2]


def test_a_resume_with_only_store_and_detect_left_downloads_nothing(
        Session, two_track_source, stub, monkeypatch):
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus
    from apps.api.tasks import transcribe_tasks
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    assert len(w.s3.downloads) == 1

    db = w.Session()
    db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id,
                                SnippetJob.stage.in_(["store", "detect"])) \
        .update({SnippetJob.status: SnippetJobStatus.pending}, synchronize_session=False)
    db.commit()
    db.close()
    monkeypatch.setattr(transcribe_tasks, "_model", None)
    monkeypatch.setattr(transcribe_tasks, "_model_key", None)
    inits, calls = len(stub.inits), len(stub.calls)

    assert run(w) is None
    assert w.s3.downloads == [w.s3.downloads[0]], "the source was not fetched again"
    assert len(stub.inits) == inits and len(stub.calls) == calls, "no model load, no Whisper"
    j = jobs(w)
    assert j["store"][:2] == ("done", 2) and j["detect"][:2] == ("done", 2)
    assert j["gate"][:2] == ("done", 1), "the gate's stored output was reused"
    assert len(segments(w)) == 2 and media(w).status == "ready"


def test_a_resume_with_only_detect_left_keeps_the_stored_transcript(
        Session, two_track_source, stub):
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    ids = {s.id for s in segments(w)}
    db = w.Session()
    db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id,
                                SnippetJob.stage == "detect") \
        .update({SnippetJob.status: SnippetJobStatus.failed}, synchronize_session=False)
    db.commit()
    db.close()
    assert run(w) is None
    assert {s.id for s in segments(w)} == ids, "store was done: its rows are not rewritten"
    j = jobs(w)
    assert j["store"][:2] == ("done", 1) and j["detect"][:2] == ("done", 2)
    assert len(w.s3.downloads) == 1 and media(w).status == "ready"


def test_a_changed_mapping_on_resume_replans_from_the_stored_streams(Session, two_track_source, stub):
    """The plan is checked against the current mapping without fetching the
    source (its streams came from ffprobe and are in plan.json)."""
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus, SnippetTrackSpeaker
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    db = w.Session()
    db.query(SnippetTrackSpeaker).filter(SnippetTrackSpeaker.media_file_id == w.media_file_id,
                                         SnippetTrackSpeaker.track_index == 1).delete()
    db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id,
                                SnippetJob.stage == "store") \
        .update({SnippetJob.status: SnippetJobStatus.failed}, synchronize_session=False)
    db.commit()
    db.close()
    calls = len(stub.calls)

    assert run(w) is None
    assert len(w.s3.downloads) == 1 and len(stub.calls) == calls
    plan = w.s3.json("snippet/plan.json")
    assert plan["tracks"] == [0] and plan["streams_from"] == "ffprobe"
    assert jobs(w)["plan"][:2] == ("done", 2) and jobs(w)["gate"][:2] == ("done", 2)
    assert [s.track for s in segments(w)] == [0]


def test_reprocess_without_force_keeps_done_rows_and_resets_the_rest(Session, two_track_source, stub):
    from apps.api.models.snippet import SnippetJob, SnippetJobStatus
    from apps.api.scripts.snippet_reprocess import find_candidates, reprocess
    w = _build_world(Session, two_track_source)
    assert run(w) is None
    db = w.Session()
    for stage, status in (("gate", SnippetJobStatus.failed), ("store", SnippetJobStatus.running)):
        db.query(SnippetJob).filter(SnippetJob.media_file_id == w.media_file_id,
                                    SnippetJob.stage == stage) \
            .update({SnippetJob.status: status, SnippetJob.error: "x"}, synchronize_session=False)
    db.commit()
    n = reprocess(db, find_candidates(db, asset_id=w.asset_id),
                  lambda a, v: SimpleNamespace(id="task-9"))
    db.close()
    assert n == 1
    j = jobs(w)
    assert j["plan"][0] == j["transcribe:track0"][0] == j["transcribe:track1"][0] == "done"
    assert j["detect"][0] == "done"
    assert j["gate"] == ("pending", 1, None) and j["store"] == ("pending", 1, None)
    m = media(w)
    assert (m.status, m.task_id) == ("processing", "task-9")
