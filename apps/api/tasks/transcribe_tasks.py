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
"""

import json
import logging
import os
import subprocess
import tempfile
import uuid

from .celery_app import celery_app
from ..database import SessionLocal
from ..models.asset import Asset, AssetVersion, MediaFile, TranscriptionStatus
from ..services.s3_service import get_s3_client, put_object
from ..config import settings
from .transcode_tasks import _publish_event

logger = logging.getLogger(__name__)

# Loading a Whisper model costs several seconds and a few hundred MB, so it
# is loaded once per worker process and reused across tasks rather than
# per-call. With TRANSCRIPTION_CONCURRENCY=1 that means exactly one resident
# model per container.
_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        size = settings.whisper_model_size
        # Guard rail, not paranoia: a ".en" checkpoint transcribes every
        # language as though it were English and produces confident garbage
        # for the Spanish/Portuguese/Italian/French/German content this
        # deployment actually handles. Fail loudly at load time instead.
        if size.endswith(".en"):
            raise RuntimeError(
                f"WHISPER_MODEL_SIZE={size!r} is an English-only checkpoint; "
                "this deployment needs a multilingual model (e.g. 'small')."
            )
        logger.info("Loading faster-whisper model %s (%s)", size, settings.whisper_compute_type)
        _model = WhisperModel(size, device="cpu", compute_type=settings.whisper_compute_type)
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

        media_file.transcription_status = TranscriptionStatus.processing
        db.commit()
        _publish_event(str(asset.project_id), "transcription_processing", {
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

            s3.download_file(settings.s3_bucket, media_file.s3_key_raw, tmp_input)
            _extract_audio(tmp_input, tmp_audio)

            model = _get_model()
            # No `language=` argument: auto-detect is the whole point here,
            # the content mix is multilingual.
            segment_iter, info = model.transcribe(tmp_audio, vad_filter=True)

            # faster-whisper yields lazily -- transcription only actually
            # runs as this is consumed.
            segments = [
                {
                    "id": i,
                    "start": float(s.start),
                    "end": float(s.end),
                    "text": (s.text or "").strip(),
                }
                for i, s in enumerate(segment_iter)
            ]

            language = getattr(info, "language", None)
            transcript = {
                "language": language,
                "language_probability": getattr(info, "language_probability", None),
                "duration": getattr(info, "duration", None),
                "text": " ".join(s["text"] for s in segments if s["text"]).strip(),
                "segments": segments,
            }

            output_prefix = f"processed/{asset.project_id}/{asset_id}/{version_id}"
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
            media_file.transcription_status = TranscriptionStatus.failed
            db.commit()
            _publish_event(str(asset.project_id), "transcription_failed", {
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
