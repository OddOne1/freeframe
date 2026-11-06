"""SocialSnippet configuration: settings, speakers, track mapping, reprocessing.

The one implementation of each rule, called by both the operator scripts
(scripts/snippet_enable_project.py, snippet_set_track_speaker.py,
snippet_reprocess.py) and the HTTP routes (routers/snippet.py). Before
this module the scripts were the only callers and each rule lived in the
script that first needed it; a second copy in the router is how
"anna" and "Anna" come to be one speaker on the command line and two in
the browser.

Nothing here commits except `reprocess`, which has to: it hands work to
Celery between its writes, and a task that starts before the reset is
committed would resume the stages it was meant to redo. Every other
function leaves the transaction to its caller, so a script's --dry-run
and a route's validation failure can still roll back.

Errors are `SnippetAdminError`, a plain message with no traceback. The
scripts print it; the routes answer 422 with it.
"""
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from sqlalchemy import func, null

from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus
from ..models.snippet import (
    EXPORT_ASPECTS, SnippetJob, SnippetProjectSettings, SnippetSpeaker,
    SnippetTrackSpeaker, TranscriptSegment,
)

#: `snippet_speakers.name` and `snippet_project_settings.caption_font`.
NAME_MAX_CHARS = 255


class SnippetAdminError(Exception):
    """A problem with the input or the data, reported without a traceback."""


def clean_text(text: Optional[str]) -> str:
    """Whitespace collapsed to single spaces, ends trimmed."""
    return " ".join((text or "").split())


# ── Speakers ───────────────────────────────────────────────────────────────


def find_or_create_speaker(db, project_id, name: str, created_by=None,
                           label: str = "--name"):
    """(speaker, created). Same project, same name ignoring case = same speaker.

    `label` names the input in the error message: "--name" for the
    scripts, "name" for the routes.
    """
    clean = clean_text(name)
    if not clean:
        raise SnippetAdminError(f"{label} must not be empty.")
    if len(clean) > NAME_MAX_CHARS:
        raise SnippetAdminError(f"{label} is longer than {NAME_MAX_CHARS} characters.")
    speaker = (
        db.query(SnippetSpeaker)
        .filter(SnippetSpeaker.project_id == project_id,
                func.lower(SnippetSpeaker.name) == clean.lower())
        .first()
    )
    if speaker is not None:
        return speaker, False
    speaker = SnippetSpeaker(id=uuid.uuid4(), project_id=project_id, name=clean,
                             created_by=created_by)
    db.add(speaker)
    db.flush()
    return speaker, True


# ── Tracks ─────────────────────────────────────────────────────────────────


def audio_streams(media_file) -> Optional[list]:
    """The audio streams the pipeline recorded, or None when none were."""
    streams = (media_file.technical_metadata or {}).get("audio_streams")
    return streams if isinstance(streams, list) else None


def known_audio_tracks(media_file) -> Optional[list]:
    """The recorded audio-track ordinals, sorted; None when not recorded."""
    streams = audio_streams(media_file)
    if streams is None:
        return None
    return sorted(s.get("audio_index") for s in streams
                  if isinstance(s, dict) and isinstance(s.get("audio_index"), int))


def assign_track_speaker(db, media_file, track: int, speaker, label: str = "--track") -> dict:
    """Map one audio track to `speaker` and relabel its existing segments.

    Replaces any earlier mapping of the track. Segments already transcribed
    on it get the new speaker (speaker only; text untouched). Which tracks
    are transcribed changes only on the next run. Does not commit.
    """
    if track < 0:
        raise SnippetAdminError(f"{label} must be 0 or more.")
    known = known_audio_tracks(media_file)
    if known is not None and track not in known:
        raise SnippetAdminError(f"This file's audio tracks are {known}; there is no track {track}.")

    row = (
        db.query(SnippetTrackSpeaker)
        .filter(SnippetTrackSpeaker.media_file_id == media_file.id,
                SnippetTrackSpeaker.track_index == track)
        .first()
    )
    previous = row.speaker_id if row is not None else None
    if row is None:
        db.add(SnippetTrackSpeaker(media_file_id=media_file.id, track_index=track,
                                   speaker_id=speaker.id))
    else:
        row.speaker_id = speaker.id

    relabelled = (
        db.query(TranscriptSegment)
        .filter(TranscriptSegment.media_file_id == media_file.id,
                TranscriptSegment.track_index == track)
        .update({TranscriptSegment.speaker_id: speaker.id}, synchronize_session=False)
    )
    db.flush()
    return {"previous_speaker_id": previous, "segments_relabelled": relabelled}


def track_label(stream: Optional[dict], track: int) -> str:
    """What a person reads for a track: its title, else "Track N", plus layout and language."""
    stream = stream or {}
    parts = [clean_text(stream.get("title")) or f"Track {track + 1}"]
    layout = stream.get("channel_layout") or (
        f"{stream['channels']} ch" if stream.get("channels") else None
    )
    if layout:
        parts.append(str(layout))
    language = stream.get("language")
    if language and language != "und":
        parts.append(str(language))
    return " · ".join(parts)


def track_rows(db, media_file) -> list:
    """Every track of the file with its label and speaker.

    The recorded audio streams when there are any. Without them (the
    pipeline probes the file itself and may not have run yet), the tracks
    that are mapped or already have segments; and track 0 if nothing is
    known at all, because every audio or video file has one.
    """
    streams = audio_streams(media_file)
    by_index = {
        s["audio_index"]: s for s in (streams or [])
        if isinstance(s, dict) and isinstance(s.get("audio_index"), int)
    }
    mapping = {
        m.track_index: (s.id, s.name)
        for m, s in (
            db.query(SnippetTrackSpeaker, SnippetSpeaker)
            .join(SnippetSpeaker, SnippetSpeaker.id == SnippetTrackSpeaker.speaker_id)
            .filter(SnippetTrackSpeaker.media_file_id == media_file.id)
            .all()
        )
    }
    indices = set(by_index) | set(mapping)
    if streams is None:
        indices |= {
            t for (t,) in (
                db.query(TranscriptSegment.track_index)
                .filter(TranscriptSegment.media_file_id == media_file.id)
                .distinct()
                .all()
            )
        }
        if not indices:
            indices = {0}
    return [
        {
            "track_index": idx,
            "label": track_label(by_index.get(idx), idx),
            "speaker_id": mapping[idx][0] if idx in mapping else None,
            "speaker_name": mapping[idx][1] if idx in mapping else None,
        }
        for idx in sorted(indices)
    ]


# ── Settings ───────────────────────────────────────────────────────────────

#: What a project with no settings row behaves as. Repeats the model's
#: `default=` on purpose: with no row the reader still has to be told what
#: the project is set to, and no row is the same as disabled with every
#: other setting at its default.
DEFAULT_SETTINGS = {
    "enabled": False,
    "source_folder_id": None,
    "export_retention_days": 30,
    "export_aspect": "9:16",
    "caption_font": None,
}

SETTINGS_FIELDS = tuple(DEFAULT_SETTINGS)


def settings_row(db, project_id) -> Optional[SnippetProjectSettings]:
    return (
        db.query(SnippetProjectSettings)
        .filter(SnippetProjectSettings.project_id == project_id)
        .first()
    )


def current_values(row: Optional[SnippetProjectSettings]) -> dict:
    """The row's values, or what a new row would start as. `exists` says which."""
    if row is None:
        return {"exists": False, **DEFAULT_SETTINGS}
    return {"exists": True, **{field: getattr(row, field) for field in SETTINGS_FIELDS}}


def is_enabled(db, project_id) -> bool:
    row = settings_row(db, project_id)
    return row is not None and row.enabled is True


def check_retention_days(days, label: str = "--retention-days", forever_hint: str =
                         "use --retention-forever to keep exports indefinitely") -> None:
    if days is not None and days < 1:
        raise SnippetAdminError(f"{label} must be 1 or more; {forever_hint}.")


def check_export_aspect(aspect, label: str = "--export-aspect") -> None:
    if aspect not in EXPORT_ASPECTS:
        raise SnippetAdminError(f"{label} must be one of {', '.join(EXPORT_ASPECTS)}.")


def clean_caption_font(font, label: str = "--caption-font") -> Optional[str]:
    """Cleaned font name; empty means "no font" (None)."""
    clean = clean_text(font)
    if len(clean) > NAME_MAX_CHARS:
        raise SnippetAdminError(f"{label} is longer than {NAME_MAX_CHARS} characters.")
    return clean or None


def _explicit(value):
    """A None that survives the column's `default=`.

    SQLAlchemy treats an attribute set to None as "no value given" and falls
    back to the column default, so `row.export_retention_days = None` on a
    new row stores 30 -- the model's default -- instead of NULL, and
    "keep forever" would silently do nothing. `null()` is how you ask for
    NULL and mean it. Applied to every nullable field so the next one to
    gain a default does not re-introduce this.
    """
    return null() if value is None else value


def write_settings(db, project_id, after: dict) -> bool:
    """Upsert the row to `after`. Returns True when a row was created. Does not commit."""
    row = settings_row(db, project_id)
    created = row is None
    if created:
        row = SnippetProjectSettings(project_id=project_id)
        db.add(row)
    row.enabled = after["enabled"]
    row.source_folder_id = _explicit(after["source_folder_id"])
    row.export_retention_days = _explicit(after["export_retention_days"])
    row.export_aspect = after["export_aspect"]
    row.caption_font = _explicit(after["caption_font"])
    return created


# ── Reprocessing ───────────────────────────────────────────────────────────


@dataclass
class Candidate:
    asset_id: str
    asset_name: str
    version_id: Optional[str]
    media_file_id: Optional[str]
    enqueue: bool
    reason: str


def latest_live_version(db, asset_id):
    """The newest version that is not in the trash."""
    return (
        db.query(AssetVersion)
        .filter(AssetVersion.asset_id == asset_id, AssetVersion.deleted_at.is_(None))
        .order_by(AssetVersion.version_number.desc())
        .first()
    )


def _has_transcript(db, media_file_id) -> bool:
    return (
        db.query(TranscriptSegment.id)
        .filter(TranscriptSegment.media_file_id == media_file_id)
        .first()
        is not None
    )


def find_candidates(db, project_id=None, asset_id=None, asset_ids=None,
                    skip_transcribed: bool = False) -> list:
    """Every asset in scope, with what would happen to it.

    Scope is one of: a project (`project_id`), one asset (`asset_id`), or a
    list of assets that must all belong to `project_id` (`asset_ids`;
    ids that are not live assets of that project are left out, and the
    caller reports them). `skip_transcribed` leaves out a file that already
    has a SocialSnippet transcript, for "process what is new" rather than
    "redo".
    """
    from ..tasks.transcribe_tasks import _edited_segment_count, _snippet_settings_for

    query = db.query(Asset).filter(Asset.deleted_at.is_(None))
    if asset_id is not None:
        query = query.filter(Asset.id == asset_id)
    elif asset_ids is not None:
        query = query.filter(Asset.project_id == project_id, Asset.id.in_(list(asset_ids)))
    else:
        query = query.filter(Asset.project_id == project_id)
    assets = query.order_by(Asset.name).all()

    out = []
    for asset in assets:
        def _skip(reason, version=None, media_file=None):
            out.append(Candidate(
                str(asset.id), asset.name,
                str(version.id) if version else None,
                str(media_file.id) if media_file else None,
                False, reason,
            ))

        if asset.asset_type not in (AssetType.video, AssetType.audio):
            _skip(f"not video or audio ({asset.asset_type.value})")
            continue
        if _snippet_settings_for(db, asset) is None:
            _skip("SocialSnippet is not enabled for this project, or the asset is outside its source folder")
            continue
        version = latest_live_version(db, asset.id)
        media_file = (
            db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
            if version else None
        )
        if media_file is None:
            _skip("no media file", version)
            continue
        if not asset.transcription_enabled:
            _skip("transcription is turned off for this file", version, media_file)
            continue
        if media_file.transcription_status == TranscriptionStatus.processing:
            _skip("a transcription is already running", version, media_file)
            continue
        edited = _edited_segment_count(db, media_file.id)
        if edited:
            _skip(f"{edited} edited transcript segment(s); merging is not implemented yet",
                  version, media_file)
            continue
        if skip_transcribed and _has_transcript(db, media_file.id):
            _skip("already transcribed", version, media_file)
            continue
        out.append(Candidate(str(asset.id), asset.name, str(version.id), str(media_file.id),
                             True, "queue"))
    return out


def reprocess(db, candidates, enqueue: Callable) -> int:
    """Reset each candidate's stages and queue it. Returns how many were queued.

    `enqueue(asset_id, version_id)` returns the Celery result. Commits: the
    reset has to be visible before the task can start.
    """
    queued = 0
    for c in candidates:
        if not c.enqueue:
            continue
        media_file_id = uuid.UUID(c.media_file_id)
        db.query(SnippetJob).filter(SnippetJob.media_file_id == media_file_id) \
            .delete(synchronize_session=False)
        db.commit()
        result = enqueue(c.asset_id, c.version_id)
        # Same as the per-file toggle: the id makes the run revocable.
        media_file = db.query(MediaFile).filter(MediaFile.id == media_file_id).first()
        media_file.transcription_task_id = result.id
        media_file.transcription_status = TranscriptionStatus.processing
        media_file.transcription_progress = 0
        db.commit()
        queued += 1
    return queued
