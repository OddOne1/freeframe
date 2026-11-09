"""Speech-to-text for video and audio assets.

Kept separate from transcode_tasks.py on purpose: different concern,
wildly different resource profile (a single CPU Whisper pass can run for
minutes on a file the HLS ladder finished in seconds), and it runs on its
own `transcription` queue served by its own `transcribe_worker` container
so one long job can't starve the HLS queue.

This stage is deliberately *not* part of asset readiness. `process_asset`
marks the version `ready` and dispatches this fire-and-forget; playback
never waits on a transcript. Failure here is recorded on
MediaFile.transcription_status and surfaced over SSE, and leaves the asset
perfectly playable.

SocialSnippet projects take a second path through the same task (see
"SocialSnippet pipeline" below): one Whisper pass per audio track with word
timestamps, the track deciding the speaker, a level gate against
microphone bleed, and every stage recorded in snippet_jobs so a retry
resumes where the last attempt stopped. Every other asset takes the
original path, unchanged.
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
import uuid
from datetime import datetime, timezone

from botocore.exceptions import ClientError
from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile, TranscriptionStatus
from ..models.folder import Folder
from ..models.project import Project
from ..models.snippet import (
    SegmentStatus, Snippet, SnippetJob, SnippetJobStatus, SnippetProjectSettings,
    SnippetSpeaker, SnippetStatus, SnippetTrackSpeaker, TranscriptSegment, TranscriptWord,
)
from ..services.snippet_detect import detect_snippets, drop_overlapping
from ..services.snippet_transcribe import (
    NO_SPEECH, NO_SPEECH_FOUND, audio_streams_from_ffprobe, build_initial_prompt,
    combined_segments, dominant_language, folder_in_scope, gate_words_by_track,
    has_speech_level, is_whisper_no_speech_error, rms_profile, select_tracks,
)
from ..services.storage_prefix import prefix_for_project
from ..services.s3_service import get_s3_client, put_object
from ..config import settings
from .transcode_tasks import _publish_event

logger = logging.getLogger(__name__)

# Loading a Whisper model costs several seconds and a few hundred MB, so it
# is loaded once per worker process and reused across tasks rather than
# per-call. With TRANSCRIPTION_CONCURRENCY=1 that means exactly one resident
# model per container.
#
# One slot, keyed by (size, cpu_threads): SocialSnippet files use a larger
# model than everything else, and keeping both resident would hold well over
# a gigabyte for a worker that only ever runs one job at a time. Switching
# between the two costs a reload, which is seconds against a job of minutes.
_model = None
_model_key = None


def _get_model(size: str | None = None, cpu_threads: int | None = None):
    """The resident model, loading it if the wanted one is not loaded.

    With no arguments: exactly the model the original path always used
    (WHISPER_MODEL_SIZE, faster-whisper's own thread default).
    """
    global _model, _model_key
    size = size or settings.whisper_model_size
    key = (size, cpu_threads)
    if _model is None or _model_key != key:
        from faster_whisper import WhisperModel

        # Guard rail, not paranoia: a ".en" checkpoint transcribes every
        # language as though it were English and produces confident garbage
        # for the Spanish/Portuguese/Italian/French/German content this
        # deployment actually handles. Fail loudly at load time instead.
        if size.endswith(".en"):
            raise RuntimeError(
                f"Whisper model {size!r} (WHISPER_MODEL_SIZE / "
                "SNIPPET_WHISPER_MODEL_SIZE) is an English-only checkpoint; "
                "this deployment needs a multilingual model (e.g. 'small')."
            )
        logger.info(
            "Loading faster-whisper model %s (%s, cpu_threads=%s, offline=%s)",
            size, settings.whisper_compute_type, cpu_threads, settings.whisper_offline,
        )
        kwargs = {
            "device": "cpu",
            "compute_type": settings.whisper_compute_type,
            # WHISPER_OFFLINE: never touch the network; the checkpoint must
            # already be in HF_HOME.
            "local_files_only": settings.whisper_offline,
        }
        if cpu_threads:
            kwargs["cpu_threads"] = cpu_threads
        # Drop the old model before loading the new one, so the two are
        # never resident together.
        _model = None
        _model_key = None
        _model = WhisperModel(size, **kwargs)
        _model_key = key
    return _model


def _format_timestamp(seconds: float) -> str:
    """Seconds -> WebVTT `HH:MM:SS.mmm`."""
    if seconds < 0:
        seconds = 0.0
    ms = int(round(seconds * 1000))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    secs, ms = divmod(ms, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def _build_vtt(segments: list[dict]) -> str:
    """Render segments as WebVTT for the <track> element."""
    lines = ["WEBVTT", ""]
    for i, seg in enumerate(segments, start=1):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        lines.append(str(i))
        lines.append(f"{_format_timestamp(seg['start'])} --> {_format_timestamp(seg['end'])}")
        lines.append(text)
        lines.append("")
    return "\n".join(lines)


def _extract_audio(input_path: str, output_path: str) -> None:
    """Extract mono 16 kHz PCM -- what Whisper resamples to internally
    anyway. Doing it up front with ffmpeg keeps a multi-GB source video from
    being decoded into memory by the model loader, and works uniformly for
    video containers and bare audio files.
    """
    subprocess.run(
        [
            "ffmpeg", "-y", "-i", input_path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-c:a", "pcm_s16le", "-f", "wav",
            output_path,
        ],
        check=True,
        capture_output=True,
    )


# ── SocialSnippet pipeline ───────────────────────────────────────────────────
#
# Stages, each one row in snippet_jobs (unique per media file + stage):
#
#   plan                 which audio tracks to transcribe      -> snippet/plan.json
#   transcribe:track{N}  one Whisper pass over track N         -> snippet/raw_track_{N}.json
#   gate                 drop words that are another mic's bleed -> snippet/gated.json
#   store                transcript_segments + transcript_words, transcript.json,
#                        captions.vtt, MediaFile columns
#   detect               `snippets` rows from the stored transcript, no model
#
# `detect` is the one stage whose failure does NOT fail the transcription:
# the transcript is already stored and useful by then, and a clip suggester
# that cannot suggest is not a reason to mark a good transcript failed. Its
# error is recorded on its own snippet_jobs row and the task carries on.
# It writes nothing to S3 either, so it has no stored output to resume
# from -- re-running it is cheap and replaces its own rows.
#
# Every OTHER stage writes its output to S3 before it is marked done, so a retry
# (Celery's, a redelivery after the worker was killed, or a re-queue without
# `force` -- snippet_admin.reprocess keeps done rows then) loads a finished
# stage's output instead of redoing it. Tracks are independent of each
# other: a track that has to run again does not make another track's
# finished output stale, so each track runs only when its own stage is not
# done. What a track that ran DOES make stale is everything that combines
# the tracks, so after any track (or a changed plan) runs, gate and store
# run too.
#
# A track without speech is not a failure. It is decided cheaply first, from
# the RMS profile (`has_speech_level`: no Whisper pass, no model load); a
# track loud enough to pass that but on which Whisper's VAD finds nothing
# makes faster-whisper 1.0.3 raise one specific ValueError, which is read as
# the same answer. Either way the track's stage is done, its raw output has
# `"no_speech": true` and no segments, and its row carries the note
# NO_SPEECH -- so a resume does not ask again. A file on which NO track has
# speech is done with zero segments (store's note: NO_SPEECH_FOUND).
#
# The source file is fetched only by a stage that still has to read it: a
# plan without recorded audio streams, and a track that is not done yet.
# Gate, store and detect never fetch it.
#
# The pure decisions (which tracks, the prompt, the gate, speech or not) are
# in services/snippet_transcribe.py and are tested without Whisper.

SNIPPET_STAGE_PLAN = "plan"
SNIPPET_STAGE_GATE = "gate"
SNIPPET_STAGE_STORE = "store"
SNIPPET_STAGE_DETECT = "detect"
#: RMS frame length for the bleed gate. 100 ms resolves single words (most
#: are 200-600 ms long) while keeping a two-hour profile at 72,000 values.
SNIPPET_RMS_FRAME_MS = 100


def snippet_track_stage(audio_index: int) -> str:
    return f"transcribe:track{audio_index}"


class _SnippetFatal(Exception):
    """A failure a retry cannot fix (no audio, a mapped track that does not
    exist). Recorded, and not retried."""


class _SnippetRefused(Exception):
    """A person has edited this file's transcript. Nothing is changed."""


class _FfmpegError(RuntimeError):
    """ffmpeg or ffprobe exited non-zero. Transient (see `_is_transient`)."""


# ── Which failures a retry can fix ─────────────────────────────────────────
#
# A Celery retry of this task costs the whole remaining run again, and for a
# track that is not done that starts by fetching the original (15-18 minutes
# for a one-hour MXF). So only a failure that can plausibly go away by
# itself is retried:
#
#   transient   network and S3 (botocore errors other than a missing key,
#               ConnectionError), timeouts (TimeoutError,
#               subprocess.TimeoutExpired), ffmpeg/ffprobe exiting non-zero
#               (_FfmpegError, CalledProcessError: a truncated read, a full
#               disk), the database connection dropping (OperationalError),
#               out of memory (MemoryError, or a RuntimeError saying so --
#               how CTranslate2 reports a failed allocation)
#   everything  deterministic: ValueError, KeyError, TypeError, validation,
#   else        a missing S3 object, an unknown model. The same input fails
#               the same way, so the stage fails at once and the task is
#               NOT retried. Re-queue it (resume) after fixing the cause.
#
# Unknown exception types land in the second group on purpose: a retry
# storm on a deterministic error is what cost three source fetches on the
# 57-minute file this rule was written for.

_OOM_MARKERS = ("out of memory", "bad_alloc", "cannot allocate memory")


def _is_transient(exc: BaseException) -> bool:
    from botocore.exceptions import BotoCoreError
    from sqlalchemy.exc import OperationalError

    if isinstance(exc, ClientError):
        code = str((exc.response or {}).get("Error", {}).get("Code", ""))
        return code not in ("NoSuchKey", "404", "NotFound", "NoSuchBucket",
                            "AccessDenied", "403", "InvalidAccessKeyId")
    if isinstance(exc, (BotoCoreError, ConnectionError, TimeoutError,
                        subprocess.TimeoutExpired, subprocess.CalledProcessError,
                        _FfmpegError, OperationalError, MemoryError)):
        return True
    if type(exc) is RuntimeError:
        message = str(exc).lower()
        return any(marker in message for marker in _OOM_MARKERS)
    return False


def _snippet_settings_for(db, asset):
    """The project's SocialSnippet settings when this asset is in scope, else None.

    In scope: the project has settings with `enabled`, and the asset sits in
    the source folder or below it (no source folder = the whole project).
    """
    row = (
        db.query(SnippetProjectSettings)
        .filter(SnippetProjectSettings.project_id == asset.project_id)
        .first()
    )
    if row is None or row.enabled is not True:
        return None

    def _parent_of(folder_id):
        folder = db.query(Folder).filter(Folder.id == folder_id).first()
        return folder.parent_id if folder is not None else None

    if not folder_in_scope(asset.folder_id, row.source_folder_id, _parent_of):
        return None
    return row


def _now():
    return datetime.now(timezone.utc)


def _snippet_job(db, media_file_id, stage: str) -> SnippetJob:
    """The stage's row, created (pending) if it does not exist yet."""
    def _find():
        return (
            db.query(SnippetJob)
            .filter(SnippetJob.media_file_id == media_file_id, SnippetJob.stage == stage)
            .first()
        )

    job = _find()
    if job is None:
        db.add(SnippetJob(
            media_file_id=media_file_id, stage=stage,
            status=SnippetJobStatus.pending, attempts=0,
        ))
        try:
            db.commit()
        except IntegrityError:
            # A duplicate delivery created it first; the unique constraint
            # on (media_file_id, stage) is what makes that safe.
            db.rollback()
        job = _find()
    return job


def _job_start(db, job: SnippetJob) -> None:
    job.status = SnippetJobStatus.running
    job.attempts = (job.attempts or 0) + 1
    job.error = None
    job.started_at = _now()
    job.finished_at = None
    db.commit()


def _job_done(db, job: SnippetJob, note: str | None = None) -> None:
    """Mark the stage done. `note` goes into `error`, which on a DONE row is
    an outcome note, never an error: today only NO_SPEECH / NO_SPEECH_FOUND."""
    job.status = SnippetJobStatus.done
    job.error = note
    job.finished_at = _now()
    db.commit()


def _job_fail(db, media_file_id, stage, message: str) -> None:
    """Record a stage's failure. Re-reads the row: called after a rollback."""
    if stage is None:
        return
    job = _snippet_job(db, media_file_id, stage)
    job.status = SnippetJobStatus.failed
    job.error = (message or "")[:4000]
    job.finished_at = _now()
    db.commit()


def _s3_get_json(s3, key: str):
    """A stage's stored output, or None if it is not there."""
    try:
        obj = s3.get_object(Bucket=settings.s3_bucket, Key=key)
    except ClientError as exc:
        code = str((exc.response or {}).get("Error", {}).get("Code", ""))
        if code in ("NoSuchKey", "404", "NotFound"):
            return None
        raise
    return json.loads(obj["Body"].read())


def _put_json(key: str, data) -> None:
    put_object(key, json.dumps(data, ensure_ascii=False).encode("utf-8"),
               content_type="application/json")


def _ffprobe_streams(path: str) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", path],
            check=True, capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or b"").decode("utf-8", "replace")[-500:]
        raise _FfmpegError(f"ffprobe could not read the source: {tail}") from exc
    return json.loads(out.stdout or b"{}")


def _extract_track(input_path: str, output_path: str, audio_index: int) -> None:
    """One audio track (ffmpeg's 0:a:N) as mono 16 kHz PCM."""
    try:
        subprocess.run(
            [
                "ffmpeg", "-y", "-i", input_path,
                "-map", f"0:a:{audio_index}",
                "-vn", "-ac", "1", "-ar", "16000",
                "-c:a", "pcm_s16le", "-f", "wav",
                output_path,
            ],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as exc:
        tail = (exc.stderr or b"").decode("utf-8", "replace")[-500:]
        raise _FfmpegError(f"ffmpeg could not extract audio track {audio_index}: {tail}") from exc


class _LazySource:
    """The original, downloaded the first time something needs it.

    A retry whose tracks are all finished never downloads the original at
    all. Same worker pattern as the original path: get_s3_client() and
    download_file into a local temp file.
    """

    def __init__(self, s3, key: str, workdir: str):
        self._s3, self._key, self._workdir = s3, key, workdir
        self._path = None

    def path(self) -> str:
        if self._path is None:
            suffix = os.path.splitext(self._key)[1] or ".media"
            path = os.path.join(self._workdir, f"original{suffix}")
            logger.info("SocialSnippet: fetching source %s", self._key)
            self._s3.download_file(settings.s3_bucket, self._key, path)
            self._path = path
        return self._path


class _TrackProgress:
    """transcription_progress as the average across tracks, whole percents only."""

    def __init__(self, db, media_file, project_id, asset_id, version_id, tracks):
        self._db, self._media_file = db, media_file
        self._project_id, self._asset_id, self._version_id = project_id, asset_id, version_id
        self._fractions = {t: 0.0 for t in tracks}
        self._last = None

    def update(self, track, fraction: float) -> None:
        self._fractions[track] = max(0.0, min(1.0, fraction))
        pct = int(sum(self._fractions.values()) / max(1, len(self._fractions)) * 100)
        pct = max(0, min(100, pct))
        if self._last == pct:
            return
        self._last = pct
        _publish_event(self._project_id, "transcription_progress", {
            "asset_id": self._asset_id,
            "version_id": self._version_id,
            "percent": pct,
        })
        try:
            self._media_file.transcription_progress = pct
            self._db.commit()
        except Exception:
            self._db.rollback()

    def finish(self, track) -> None:
        self.update(track, 1.0)


def _edited_segment_count(db, media_file_id) -> int:
    """Segments a person has touched.

    Deliberately NOT through `TranscriptSegment.live()`: that read rule hides
    rows of a trashed asset, and this is a write guard. An edited transcript
    in the bin must still never be overwritten, or a restore brings back
    the AI text instead of the person's.
    """
    return (
        db.query(TranscriptSegment)
        .filter(
            TranscriptSegment.media_file_id == media_file_id,
            TranscriptSegment.status != SegmentStatus.ai,
        )
        .count()
    )


def _refusal_message(count: int) -> str:
    return (
        f"{count} transcript segment(s) of this file were edited by a person. "
        "Re-transcribing would overwrite those edits, and merging edits into a "
        "new transcription is not implemented yet. Nothing was changed."
    )


def _stage_plan(db, s3, media_file_id, technical_metadata, source, plan_key, force: bool):
    """(plan, ran). `ran` is True when the track choice was (re)made.

    A done plan is reused, but its track choice is checked against the
    current speaker mapping using the streams it stored -- so a resume never
    fetches the source for the plan, and a mapping changed since the plan
    was made still decides which tracks run.
    """
    mapped = (
        db.query(SnippetTrackSpeaker)
        .filter(SnippetTrackSpeaker.media_file_id == media_file_id)
        .all()
    )
    job = _snippet_job(db, media_file_id, SNIPPET_STAGE_PLAN)
    stored_streams = None
    if job.status == SnippetJobStatus.done and not force:
        plan = _s3_get_json(s3, plan_key)
        if plan is not None:
            tracks, _reason = select_tracks(plan.get("audio_streams"), mapped)
            if [int(t) for t in plan["tracks"]] == tracks:
                return plan, False
            stored_streams = (plan.get("audio_streams"), plan.get("streams_from"))
    _job_start(db, job)

    if stored_streams is not None:
        streams, streams_from = stored_streams
    else:
        streams = (technical_metadata or {}).get("audio_streams")
        streams_from = "technical_metadata"
    if not isinstance(streams, list):
        # Not every file has had its audio streams recorded. The original is
        # needed for transcription anyway, so probe it here.
        streams = audio_streams_from_ffprobe(_ffprobe_streams(source.path()))
        streams_from = "ffprobe"

    tracks, reason = select_tracks(streams, mapped)
    if not tracks:
        raise _SnippetFatal("This file has no audio track to transcribe.")
    if mapped:
        known = sorted({s.get("audio_index") for s in streams if isinstance(s, dict)} - {None})
        missing = [t for t in tracks if t not in known]
        if missing:
            raise _SnippetFatal(
                f"Audio track(s) {missing} are mapped to speakers, but this file's "
                f"audio tracks are {known}."
            )

    plan = {"tracks": tracks, "reason": reason, "audio_streams": streams, "streams_from": streams_from}
    _put_json(plan_key, plan)
    _job_done(db, job)
    logger.info("SocialSnippet media file %s: tracks %s (%s)", media_file_id, tracks, reason)
    return plan, True


def _stage_transcribe_track(db, s3, media_file_id, track, source, workdir, raw_key,
                            prompt, progress, force: bool):
    job = _snippet_job(db, media_file_id, snippet_track_stage(track))
    if job.status == SnippetJobStatus.done and not force:
        data = _s3_get_json(s3, raw_key)
        if data is not None:
            progress.finish(track)
            return data, False
    _job_start(db, job)

    wav = os.path.join(workdir, f"track_{track}.wav")
    _extract_track(source.path(), wav, track)
    rms = rms_profile(wav, SNIPPET_RMS_FRAME_MS)
    size = settings.snippet_whisper_model_size

    segments = []
    info = None
    no_speech_reason = None
    if not has_speech_level(rms, SNIPPET_RMS_FRAME_MS):
        # Silent by level: no Whisper pass, and no model load for it.
        no_speech_reason = "level"
    else:
        model = _get_model(size, cpu_threads=settings.snippet_whisper_cpu_threads)
        kwargs = {"word_timestamps": True, "vad_filter": True}
        if prompt:
            kwargs["initial_prompt"] = prompt
        try:
            # No `language=`: detected per track, since two people on one
            # recording need not speak the same language.
            segment_iter, info = model.transcribe(wav, **kwargs)
            total = float(getattr(info, "duration", 0) or 0)
            for seg in segment_iter:
                words = []
                for w in getattr(seg, "words", None) or []:
                    prob = getattr(w, "probability", None)
                    words.append({
                        "start": float(w.start),
                        "end": float(w.end),
                        "word": w.word,
                        "probability": float(prob) if prob is not None else None,
                    })
                segments.append({
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": (seg.text or "").strip(),
                    "words": words,
                })
                if total > 0:
                    progress.update(track, float(seg.end) / total)
        except ValueError as exc:
            # faster-whisper 1.0.3, when its VAD removed the whole track,
            # fails in language detection with exactly this error. Only that
            # one, and only before any segment came out, means "no speech";
            # every other ValueError is a real failure and propagates.
            if segments or not is_whisper_no_speech_error(exc):
                raise
            info = None
            no_speech_reason = "vad"
        if not segments and no_speech_reason is None:
            no_speech_reason = "empty"

    no_speech = no_speech_reason is not None
    data = {
        "track_index": track,
        "model": None if no_speech_reason == "level" else size,
        "language": None if no_speech else getattr(info, "language", None),
        "language_probability": None if no_speech else getattr(info, "language_probability", None),
        "duration": (getattr(info, "duration", None) if info is not None
                     else round(len(rms) * SNIPPET_RMS_FRAME_MS / 1000.0, 3)),
        "segments": segments,
        "rms": {"frame_ms": SNIPPET_RMS_FRAME_MS, "values": [round(v, 6) for v in rms]},
    }
    if no_speech:
        data["no_speech"] = True
        data["no_speech_reason"] = no_speech_reason
    _put_json(raw_key, data)
    _job_done(db, job, note=NO_SPEECH if no_speech else None)
    progress.finish(track)
    try:
        os.unlink(wav)
    except OSError:
        pass
    if no_speech:
        logger.info("SocialSnippet media file %s track %s: no speech (%s)",
                    media_file_id, track, no_speech_reason)
    else:
        logger.info(
            "SocialSnippet media file %s track %s: %d segment(s), language=%s",
            media_file_id, track, len(segments), data["language"],
        )
    return data, True


def _stage_gate(db, s3, media_file_id, tracks, raw, gated_key, force: bool):
    job = _snippet_job(db, media_file_id, SNIPPET_STAGE_GATE)
    if job.status == SnippetJobStatus.done and not force:
        data = _s3_get_json(s3, gated_key)
        if data is not None:
            return data, False
    _job_start(db, job)

    track_words = {t: raw[t]["segments"] for t in tracks}
    track_rms = {t: raw[t]["rms"]["values"] for t in tracks}
    frame_ms = raw[tracks[0]]["rms"]["frame_ms"]
    gated = gate_words_by_track(
        track_words, track_rms,
        settings.snippet_gate_margin_db, settings.snippet_gate_min_keep_ratio,
        frame_ms=frame_ms,
    )

    def _counts(by_track):
        segs = sum(len(v) for v in by_track.values())
        words = sum(len(s.get("words") or []) for v in by_track.values() for s in v)
        return segs, words

    before, after = _counts(track_words), _counts(gated)
    data = {
        "margin_db": settings.snippet_gate_margin_db,
        "min_keep_ratio": settings.snippet_gate_min_keep_ratio,
        "dropped_segments": before[0] - after[0],
        "dropped_words": before[1] - after[1],
        "tracks": {
            str(t): {
                "language": raw[t].get("language"),
                "language_probability": raw[t].get("language_probability"),
                "duration": raw[t].get("duration"),
                "segments": gated[t],
            }
            for t in tracks
        },
    }
    _put_json(gated_key, data)
    _job_done(db, job)
    logger.info(
        "SocialSnippet media file %s gate: dropped %d segment(s), %d word(s)",
        media_file_id, data["dropped_segments"], data["dropped_words"],
    )
    return data, True


def _ms(seconds) -> int:
    return max(0, int(round(float(seconds) * 1000)))


def _finish_media_file(media_file) -> None:
    media_file.transcription_task_id = None
    media_file.transcription_progress = 100
    media_file.transcription_status = TranscriptionStatus.ready


def _stage_store(db, media_file, media_file_id, gated_data, output_prefix, force: bool):
    """Segments + words in one transaction, plus the panel's transcript files.

    A done store stage is kept when nothing before it ran (a resume where
    only detect is left): the stored rows are already this run's result.
    """
    job = _snippet_job(db, media_file_id, SNIPPET_STAGE_STORE)
    if job.status == SnippetJobStatus.done and not force:
        count = (
            db.query(TranscriptSegment)
            .filter(TranscriptSegment.media_file_id == media_file_id)
            .count()
        )
        language = media_file.transcript_language
        _finish_media_file(media_file)
        db.commit()
        return language, count, count, None
    _job_start(db, job)

    # Checked again here, not only at the start: a run takes minutes to
    # hours, and someone may have edited the old transcript meanwhile.
    edited = _edited_segment_count(db, media_file_id)
    if edited:
        raise _SnippetRefused(_refusal_message(edited))

    tracks_data = {int(k): v for k, v in gated_data["tracks"].items()}
    gated = {t: v["segments"] for t, v in tracks_data.items()}
    speakers = {
        row.track_index: row.speaker_id
        for row in db.query(SnippetTrackSpeaker)
        .filter(SnippetTrackSpeaker.media_file_id == media_file_id)
        .all()
    }

    # The existing transcript panel's files, in their existing format: one
    # list ordered by time across all tracks.
    segments = combined_segments(gated)
    language, language_probability = dominant_language(tracks_data, gated)
    durations = [v.get("duration") for v in tracks_data.values() if v.get("duration") is not None]
    transcript = {
        "language": language,
        "language_probability": language_probability,
        "duration": max(durations) if durations else None,
        "text": " ".join(s["text"] for s in segments if s["text"]).strip(),
        "segments": segments,
    }
    transcript_key = f"{output_prefix}/transcript.json"
    captions_key = f"{output_prefix}/captions.vtt"
    put_object(
        transcript_key,
        json.dumps(transcript, ensure_ascii=False).encode("utf-8"),
        content_type="application/json",
        cache_control="max-age=86400",
    )
    put_object(
        captions_key,
        _build_vtt(segments).encode("utf-8"),
        content_type="text/vtt",
        cache_control="max-age=86400",
    )

    # One transaction from here to the commit: the old (all-AI) segments
    # go, the new ones and their words arrive, the MediaFile points at the
    # new files and the stage is done -- or none of it happened.
    old_ids = select(TranscriptSegment.id).where(TranscriptSegment.media_file_id == media_file_id)
    # Words first and explicitly: the FK cascade would do it on Postgres,
    # but nothing should depend on the cascade to stay consistent.
    db.query(TranscriptWord).filter(TranscriptWord.segment_id.in_(old_ids)) \
        .delete(synchronize_session=False)
    db.query(TranscriptSegment).filter(TranscriptSegment.media_file_id == media_file_id) \
        .delete(synchronize_session=False)

    seg_rows, word_rows = [], []
    for track in sorted(gated):
        lang = (tracks_data[track].get("language") or None)
        ordered = sorted(gated[track], key=lambda s: (float(s["start"]), float(s["end"])))
        for seq, seg in enumerate(ordered):
            text = (seg.get("text") or "").strip()
            start_ms = _ms(seg["start"])
            segment_id = uuid.uuid4()
            seg_rows.append({
                "id": segment_id,
                "media_file_id": media_file_id,
                "track_index": track,
                "speaker_id": speakers.get(track),
                "seq": seq,
                "start_ms": start_ms,
                "end_ms": max(start_ms, _ms(seg["end"])),
                "language": lang[:10] if lang else None,
                "text_ai": text,
                "text_current": text,
                "status": SegmentStatus.ai,
            })
            for idx, w in enumerate(seg.get("words") or []):
                w_start = _ms(w["start"])
                prob = w.get("probability")
                word_rows.append({
                    "segment_id": segment_id,
                    "idx": idx,
                    "start_ms": w_start,
                    "end_ms": max(w_start, _ms(w["end"])),
                    "word": str(w.get("word") or ""),
                    "probability": None if prob is None else max(0.0, min(1.0, float(prob))),
                })
    if seg_rows:
        db.execute(insert(TranscriptSegment), seg_rows)
    if word_rows:
        db.execute(insert(TranscriptWord), word_rows)

    media_file.s3_key_transcript = transcript_key
    media_file.s3_key_captions = captions_key
    media_file.transcript_language = language
    _finish_media_file(media_file)
    job.status = SnippetJobStatus.done
    # Zero segments is a result, not a failure: no track had speech.
    job.error = None if seg_rows else NO_SPEECH_FOUND
    job.finished_at = _now()
    db.commit()
    return language, len(segments), len(seg_rows), len(word_rows)


# ── detect ───────────────────────────────────────────────────────────────────


def snippet_words_by_track(db, media_file_id) -> dict:
    """``{track: {"speaker", "speaker_id", "words": [...]}}`` for one file.

    Reached through `TranscriptSegment.live`, so a soft-deleted asset's
    transcript is invisible here exactly as it is everywhere else -- that
    rule has one implementation (models/snippet.py), and this is a caller of
    it, not a second copy.

    Words come back ordered by (track, segment seq, word idx), which is what
    services/snippet_detect.py expects.
    """
    segments = (
        TranscriptSegment.live(db)
        .filter(TranscriptSegment.media_file_id == media_file_id)
        .order_by(TranscriptSegment.track_index, TranscriptSegment.seq)
        .all()
    )
    if not segments:
        return {}

    names = {
        speaker_id: name
        for speaker_id, name in db.query(SnippetSpeaker.id, SnippetSpeaker.name).all()
    }
    words_by_segment: dict = {}
    for word in (
        db.query(TranscriptWord)
        .filter(TranscriptWord.segment_id.in_([s.id for s in segments]))
        .order_by(TranscriptWord.segment_id, TranscriptWord.idx)
        .all()
    ):
        words_by_segment.setdefault(word.segment_id, []).append(word)

    tracks: dict = {}
    for segment in segments:
        track = tracks.setdefault(segment.track_index, {
            "speaker": None, "speaker_id": None, "words": [],
        })
        if segment.speaker_id is not None and track["speaker_id"] is None:
            track["speaker_id"] = segment.speaker_id
            track["speaker"] = names.get(segment.speaker_id)
        for word in words_by_segment.get(segment.id, []):
            track["words"].append({
                "start_ms": word.start_ms, "end_ms": word.end_ms, "word": word.word,
            })
    return tracks


def replaceable_snippets():
    """SQL criteria: the clips a detect run may delete and replace.

    THE one statement of the rule, for the pipeline's detect stage,
    scripts/snippet_detect.py (and its --dry-run count), snippet_reprocess.py
    (through the pipeline) and the re-detect after a speaker is named:
    `source='keyword'` AND `status='suggested'` AND never edited by a person.
    Every other clip is kept, and each exclusion is deliberate:

      * source `import`, `manual` or `llm` did not come from this detector,
        so it is not the detector's to replace;
      * a keyword row somebody APPROVED or REJECTED is a decision. Deleting
        it would either lose an approved clip or re-suggest one that was
        already turned down;
      * a keyword row a person trimmed, retitled or re-topiced
        (`user_edited_at`) is their work, approved or not.
    """
    return (
        Snippet.source == "keyword",
        Snippet.status == SnippetStatus.suggested,
        Snippet.user_edited_at.is_(None),
    )


def replace_keyword_snippets(db, media_file_id, rows) -> dict:
    """Swap this file's replaceable suggestions (`replaceable_snippets`) for `rows`.

    The clips that stay are also respected by what is added: a new row that
    overlaps a kept clip by more than snippet_detect.MAX_OVERLAP_RATIO is not
    created (`drop_overlapping`), so a rejected clip is not suggested again
    and an edited one gets no untrimmed twin.

    `quality_score` is stored as detection scored it (0..1, keyword-v2) and
    the row's `reasons` are not stored: they are for the scripts' output.

    Returns {"removed": n, "created": m, "skipped": k}; `skipped` counts the
    rows dropped for overlapping a kept clip.
    """
    removed = (
        db.query(Snippet)
        .filter(Snippet.media_file_id == media_file_id, *replaceable_snippets())
        .delete(synchronize_session=False)
    )
    kept = [
        {"start_ms": start, "end_ms": end}
        for start, end in db.query(Snippet.start_ms, Snippet.end_ms)
        .filter(Snippet.media_file_id == media_file_id)
        .all()
    ]
    rows, skipped = drop_overlapping(rows, kept)
    for row in rows:
        db.add(Snippet(
            id=uuid.uuid4(),
            media_file_id=media_file_id,
            speaker_id=row.get("speaker_id"),
            start_ms=row["start_ms"],
            end_ms=row["end_ms"],
            title=row.get("title"),
            quote=row.get("quote"),
            topics=list(row.get("topics") or []),
            quality_score=row.get("quality_score"),
            viral_score=row.get("viral_score"),
            status=SnippetStatus.suggested,
            source=row.get("source") or "keyword",
            generator=row.get("generator"),
        ))
    db.commit()
    return {"removed": removed or 0, "created": len(rows), "skipped": skipped}


def snippet_detect_input(db, media_file_id) -> dict:
    """The plain dict services/snippet_detect.detect_snippets takes, for one file.

    Its words (`snippet_words_by_track`) and its length, which sets how many
    clips the file may get (snippet_detect.max_clips_for). The length is the
    media file's `duration_seconds`; without one, detection falls back to
    where the last word ends. One place builds this, so the pipeline, the
    dry run and scripts/snippet_detect_compare.py read the same input.
    """
    tracks = snippet_words_by_track(db, media_file_id)
    duration_seconds = (
        db.query(MediaFile.duration_seconds).filter(MediaFile.id == media_file_id).scalar()
    )
    return {
        "media_file_id": str(media_file_id),
        "duration_ms": int(round(duration_seconds * 1000)) if duration_seconds else None,
        "tracks": tracks,
    }


def run_detect_for_media_file(db, media_file_id) -> dict:
    """Detect and store this file's clip suggestions. Raises on failure.

    The whole of the detect stage, without the snippet_jobs bookkeeping, so
    scripts/snippet_detect.py runs exactly what the pipeline runs.
    """
    media_file = snippet_detect_input(db, media_file_id)
    rows = detect_snippets(media_file)
    result = replace_keyword_snippets(db, media_file_id, rows)
    result["tracks"] = sorted(media_file["tracks"])
    return result


def _stage_detect(db, media_file_id):
    """The detect stage: never raises, so transcription cannot fail here.

    A failure is recorded on the stage's own row (status failed, the message
    in `error`) and None comes back; the caller logs it and goes on to
    announce a finished transcription, because the transcript IS finished.
    """
    job = _snippet_job(db, media_file_id, SNIPPET_STAGE_DETECT)
    try:
        _job_start(db, job)
        result = run_detect_for_media_file(db, media_file_id)
        job = _snippet_job(db, media_file_id, SNIPPET_STAGE_DETECT)
        _job_done(db, job)
        return result
    except Exception as exc:  # noqa: BLE001 -- deliberately swallowed; see above
        logger.exception("SocialSnippet detect failed for media file %s", media_file_id)
        try:
            db.rollback()
            _job_fail(db, media_file_id, SNIPPET_STAGE_DETECT, f"{type(exc).__name__}: {exc}")
        except Exception:
            logger.exception("Could not record the detect failure for media file %s",
                             media_file_id)
        return None


def _run_snippet_pipeline(task, db, asset, version, media_file):
    # §173 — plain values, captured before anything can roll back and
    # expire the instances.
    asset_id = str(asset.id)
    version_id = str(version.id)
    project_id = str(asset.project_id)
    project_uuid = asset.project_id
    media_file_id = media_file.id
    raw_key = media_file.s3_key_raw
    technical_metadata = media_file.technical_metadata
    stage = None
    workdir = None

    def _fail_without_retry(message: str, existing_transcript_stays: bool) -> None:
        try:
            db.rollback()
            _job_fail(db, media_file_id, stage, message)
            media_file.transcription_task_id = None
            media_file.transcription_progress = None
            if existing_transcript_stays and media_file.s3_key_transcript:
                # Untouched: the transcript that was there is still there.
                media_file.transcription_status = TranscriptionStatus.ready
            else:
                media_file.transcription_status = TranscriptionStatus.failed
            db.commit()
        except Exception:
            logger.exception("Could not record SocialSnippet failure for version %s", version_id)
        _publish_event(project_id, "transcription_failed", {
            "asset_id": asset_id,
            "version_id": version_id,
            "error": message,
        })

    try:
        edited = _edited_segment_count(db, media_file_id)
        if edited:
            stage = SNIPPET_STAGE_STORE
            raise _SnippetRefused(_refusal_message(edited))

        media_file.transcription_status = TranscriptionStatus.processing
        media_file.transcription_progress = 0
        db.commit()
        _publish_event(project_id, "transcription_processing", {
            "asset_id": asset_id,
            "version_id": version_id,
        })

        project = db.query(Project).filter(Project.id == project_uuid).first()
        output_prefix = f"processed/{prefix_for_project(project)}/{asset_id}/{version_id}"
        snippet_prefix = f"{output_prefix}/snippet"
        speaker_names = [
            name for (name,) in db.query(SnippetSpeaker.name)
            .filter(SnippetSpeaker.project_id == project_uuid)
            .order_by(SnippetSpeaker.name)
            .all()
        ]
        prompt = build_initial_prompt(speaker_names)

        s3 = get_s3_client()
        workdir = tempfile.mkdtemp(prefix="snippet-")
        source = _LazySource(s3, raw_key, workdir)

        stage = SNIPPET_STAGE_PLAN
        plan, ran = _stage_plan(db, s3, media_file_id, technical_metadata, source,
                                f"{snippet_prefix}/plan.json", force=False)
        # `changed`: something the combining stages read has been redone.
        changed = ran
        tracks = [int(t) for t in plan["tracks"]]

        progress = _TrackProgress(db, media_file, project_id, asset_id, version_id, tracks)
        raw = {}
        for track in tracks:
            stage = snippet_track_stage(track)
            # Never forced by another stage: tracks do not depend on each
            # other, so a finished one is kept (see the notes above).
            raw[track], ran = _stage_transcribe_track(
                db, s3, media_file_id, track, source, workdir,
                f"{snippet_prefix}/raw_track_{track}.json", prompt, progress, force=False,
            )
            changed = changed or ran

        stage = SNIPPET_STAGE_GATE
        gated_data, ran = _stage_gate(db, s3, media_file_id, tracks, raw,
                                      f"{snippet_prefix}/gated.json", force=changed)
        changed = changed or ran

        stage = SNIPPET_STAGE_STORE
        language, segment_count, rows, words = _stage_store(
            db, media_file, media_file_id, gated_data, output_prefix, force=changed,
        )
        if words is None:
            logger.info(
                "SocialSnippet asset %s version %s: store was already done (%d segment row(s))",
                asset_id, version_id, rows,
            )
        else:
            logger.info(
                "SocialSnippet asset %s version %s: %d segment row(s), %d word(s), language=%s",
                asset_id, version_id, rows, words, language,
            )
        if rows == 0:
            logger.info("SocialSnippet asset %s version %s: %s on any track",
                        asset_id, version_id, NO_SPEECH_FOUND)

        # The transcript is stored and the file is `ready` at this point.
        # detect runs last and swallows its own failures, so a broken
        # suggester leaves a perfectly good transcript alone -- the reason
        # `stage` is NOT moved to detect here: nothing after this line may
        # be attributed to it by the outer handler.
        detected = _stage_detect(db, media_file_id)
        if detected is None:
            logger.warning(
                "SocialSnippet detect did not finish for asset %s version %s; "
                "the transcript is stored and the file stays ready",
                asset_id, version_id,
            )
        else:
            logger.info(
                "SocialSnippet detect asset %s: %d suggestion(s) created, %d replaced",
                asset_id, detected["created"], detected["removed"],
            )

        complete = {
            "asset_id": asset_id,
            "version_id": version_id,
            "language": language,
            "segment_count": segment_count,
        }
        if rows == 0:
            complete["message"] = NO_SPEECH_FOUND
        _publish_event(project_id, "transcription_complete", complete)

    except _SnippetRefused as exc:
        logger.warning("SocialSnippet transcription refused for version %s: %s", version_id, exc)
        _fail_without_retry(str(exc), existing_transcript_stays=True)
    except _SnippetFatal as exc:
        logger.error("SocialSnippet transcription failed for version %s: %s", version_id, exc)
        _fail_without_retry(str(exc), existing_transcript_stays=False)
    except Exception as exc:
        logger.exception(
            "SocialSnippet transcription failed for asset %s version %s at stage %s",
            asset_id, version_id, stage,
        )
        try:
            # §173 — rollback FIRST; `exc` may be the database error itself.
            db.rollback()
            _job_fail(db, media_file_id, stage, f"{type(exc).__name__}: {exc}")
            media_file.transcription_task_id = None
            media_file.transcription_progress = None
            media_file.transcription_status = TranscriptionStatus.failed
            db.commit()
        except Exception:
            logger.exception("Could not mark transcription failed for version %s", version_id)
        _publish_event(project_id, "transcription_failed", {
            "asset_id": asset_id,
            "version_id": version_id,
            "error": str(exc),
        })
        if _is_transient(exc):
            raise task.retry(exc=exc)
        # Deterministic: the same input fails the same way, so no retry.
        # Re-raised as-is so Celery records the failure.
        logger.error(
            "SocialSnippet stage %s failed with a non-transient %s; not retried",
            stage, type(exc).__name__,
        )
        raise
    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)


@celery_app.task(bind=True, max_retries=2, default_retry_delay=120)
def transcribe_asset(self, asset_id: str, version_id: str):
    """Transcribe one asset version, writing transcript.json + captions.vtt.

    Both derivatives land under the same
    `processed/{project_id}/{asset_id}/{version_id}/` prefix process_asset
    already uses, so cleanup that walks that prefix picks them up for free.
    """
    db = SessionLocal()
    tmp_input = None
    tmp_audio = None
    try:
        version = db.query(AssetVersion).filter(AssetVersion.id == uuid.UUID(version_id)).first()
        if not version:
            return  # version cleaned up while this sat in the queue

        asset = db.query(Asset).filter(Asset.id == uuid.UUID(asset_id)).first()
        media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
        if not asset or not media_file:
            return

        # §127 — the toggle may have been switched off while this sat in the
        # queue. revoke() covers a task that has not started, but only while
        # the worker still holds the revoked set; this is the durable check,
        # and it costs one already-loaded boolean.
        if not asset.transcription_enabled:
            logger.info(
                "Transcription disabled for asset %s; skipping queued run", asset_id
            )
            media_file.transcription_task_id = None
            media_file.transcription_progress = None
            db.commit()
            return

        # SocialSnippet: its own pipeline for files in the project's chosen
        # source folder. Everything below this branch is the original path,
        # and every other asset still takes it.
        snippet_settings = _snippet_settings_for(db, asset)
        if snippet_settings is not None:
            return _run_snippet_pipeline(self, db, asset, version, media_file)

        # §173 — captured once, as a plain string. The failure handler needs
        # it after a rollback, which expires every instance in the session;
        # reading `asset.project_id` there would issue a fresh SELECT that
        # fails too when the connection is what broke, taking the retry with
        # it. Holding a str keeps the handler free of any ORM access.
        project_id = str(asset.project_id)
        media_file.transcription_status = TranscriptionStatus.processing
        media_file.transcription_progress = 0
        db.commit()
        _publish_event(project_id, "transcription_processing", {
            "asset_id": asset_id,
            "version_id": version_id,
        })

        try:
            s3 = get_s3_client()
            suffix = os.path.splitext(media_file.s3_key_raw)[1] or ".media"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
                tmp_input = f.name
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                tmp_audio = f.name

            # §126 — milestones. Everything between here and the segment
            # count below can take minutes, and at the old log level none of
            # it was visible, so a working transcription looked exactly like
            # a task that never arrived.
            logger.info("Transcribing asset %s version %s: fetching source", asset_id, version_id)
            s3.download_file(settings.s3_bucket, media_file.s3_key_raw, tmp_input)
            _extract_audio(tmp_input, tmp_audio)
            logger.info("Audio extracted for %s; loading model", asset_id)

            model = _get_model()
            # No `language=` argument: auto-detect is the whole point here,
            # the content mix is multilingual.
            segment_iter, info = model.transcribe(tmp_audio, vad_filter=True)

            # faster-whisper yields lazily -- transcription only actually
            # runs as this is consumed. §127 turns that into a progress
            # signal: each segment carries an end timestamp, so the fraction
            # of the audio already transcribed is known as it goes.
            #
            # Throttled to whole percents, the same shape §113 used for
            # transcode progress: a long recording yields thousands of
            # segments and an unthrottled write would be a commit per segment.
            total = float(getattr(info, "duration", 0) or 0)
            last_pct = {"v": None}

            def _report(end_seconds: float) -> None:
                if total <= 0:
                    return
                pct = max(0, min(100, int(end_seconds / total * 100)))
                if last_pct["v"] == pct:
                    return
                last_pct["v"] = pct
                _publish_event(str(asset.project_id), "transcription_progress", {
                    "asset_id": asset_id,
                    "version_id": version_id,
                    "percent": pct,
                })
                try:
                    media_file.transcription_progress = pct
                    db.commit()
                except Exception:
                    db.rollback()

            segments = []
            for i, seg in enumerate(segment_iter):
                segments.append({
                    "id": i,
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": (seg.text or "").strip(),
                })
                _report(float(seg.end))

            media_file.transcription_progress = 100
            language = getattr(info, "language", None)
            logger.info(
                "Transcribed asset %s version %s: %d segment(s), language=%s",
                asset_id, version_id, len(segments), language,
            )
            transcript = {
                "language": language,
                "language_probability": getattr(info, "language_probability", None),
                "duration": getattr(info, "duration", None),
                "text": " ".join(s["text"] for s in segments if s["text"]).strip(),
                "segments": segments,
            }

            # Frozen at upload initiation (§14); read, never re-derived.
            project = db.query(Project).filter(Project.id == asset.project_id).first()
            output_prefix = f"processed/{prefix_for_project(project)}/{asset_id}/{version_id}"
            transcript_key = f"{output_prefix}/transcript.json"
            captions_key = f"{output_prefix}/captions.vtt"

            put_object(
                transcript_key,
                json.dumps(transcript, ensure_ascii=False).encode("utf-8"),
                content_type="application/json",
                cache_control="max-age=86400",
            )
            put_object(
                captions_key,
                _build_vtt(segments).encode("utf-8"),
                content_type="text/vtt",
                cache_control="max-age=86400",
            )

            media_file.s3_key_transcript = transcript_key
            media_file.s3_key_captions = captions_key
            media_file.transcript_language = language
            # §127 — the run is over, so the cancellation handle must go
            # with it. A stale id here would let a later toggle-off revoke a
            # task id that has since been reused by something else.
            media_file.transcription_task_id = None
            media_file.transcription_status = TranscriptionStatus.ready
            db.commit()

            _publish_event(str(asset.project_id), "transcription_complete", {
                "asset_id": asset_id,
                "version_id": version_id,
                "language": language,
                "segment_count": len(segments),
            })

        except Exception as exc:
            logger.exception("Transcription failed for asset %s version %s", asset_id, version_id)
            try:
                # §173 — rollback FIRST. The progress writes above commit
                # repeatedly during a run that takes minutes, so `exc` may
                # well BE a database error; on an aborted transaction every
                # statement raises InFailedSqlTransaction, including the one
                # recording the failure. Same trap that left build_zip_export
                # stuck at "building". The inner progress-commit block at the
                # top of this file already gets this right.
                db.rollback()
                media_file.transcription_task_id = None
                media_file.transcription_progress = None
                media_file.transcription_status = TranscriptionStatus.failed
                db.commit()
            except Exception:
                # A failure to record must not replace `exc` or skip the retry.
                logger.exception(
                    "Could not mark transcription failed for version %s", version_id
                )
            _publish_event(project_id, "transcription_failed", {
                "asset_id": asset_id,
                "version_id": version_id,
                "error": str(exc),
            })
            raise self.retry(exc=exc)

    finally:
        db.close()
        for path in (tmp_input, tmp_audio):
            if path and os.path.exists(path):
                try:
                    os.unlink(path)
                except OSError:
                    pass
