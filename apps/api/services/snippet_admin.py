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
committed would see stage rows it was meant not to (a forced run would
resume stages it was meant to redo). Every other
function leaves the transaction to its caller, so a script's --dry-run
and a route's validation failure can still roll back.

Errors are `SnippetAdminError`, a plain message with no traceback. The
scripts print it; the routes answer 422 with it.
"""
import uuid
from dataclasses import dataclass
from typing import Callable, Optional

from sqlalchemy import func, null

from ..models.asset import (
    Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus, TranscriptionStatus,
)
from ..models.snippet import (
    EXPORT_ASPECTS, SnippetJob, SnippetJobStatus, SnippetProjectSettings, SnippetSpeaker,
    SnippetTrackSpeaker, TranscriptSegment,
)
from .snippet_transcribe import NO_SPEECH, select_tracks

#: tasks/transcribe_tasks.py's `snippet_track_stage(N)` is this plus N.
#: Repeated rather than imported: importing the tasks module pulls in
#: Celery and boto3. tests/test_snippet_files.py compares them.
TRACK_STAGE_PREFIX = "transcribe:track"


def track_of_stage(stage: str) -> Optional[int]:
    """N for a "transcribe:trackN" stage, else None."""
    if not stage.startswith(TRACK_STAGE_PREFIX):
        return None
    rest = stage[len(TRACK_STAGE_PREFIX):]
    return int(rest) if rest.isdigit() else None

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


def track_label(stream: Optional[dict], track: int, no_speech: bool = False) -> str:
    """What a person reads for a track: its title, else "Track N", plus layout
    and language, and "no speech" when the last run found none on it."""
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
    if no_speech:
        parts.append(NO_SPEECH)
    return " · ".join(parts)


def is_no_speech_job(stage: str, status, note: Optional[str]) -> bool:
    """A done track stage whose note says the track had no speech."""
    return (track_of_stage(stage) is not None and status == SnippetJobStatus.done
            and note == NO_SPEECH)


def no_speech_tracks(db, media_file_id) -> set:
    """The tracks of this file the pipeline found no speech on."""
    return {
        track_of_stage(stage)
        for stage, status, note in (
            db.query(SnippetJob.stage, SnippetJob.status, SnippetJob.error)
            .filter(SnippetJob.media_file_id == media_file_id)
            .all()
        )
        if is_no_speech_job(stage, status, note)
    }


def track_rows(db, media_file) -> list:
    """Every track of the file with its label and speaker.

    The recorded audio streams when there are any. Without them (the
    pipeline probes the file itself and may not have run yet), the tracks
    that are mapped, already have segments, or were found to have no
    speech; and track 0 if nothing is known at all, because every audio or
    video file has one. A track the pipeline found no speech on says so in
    its label.
    """
    streams = audio_streams(media_file)
    mapping = {
        m.track_index: (s.id, s.name)
        for m, s in (
            db.query(SnippetTrackSpeaker, SnippetSpeaker)
            .join(SnippetSpeaker, SnippetSpeaker.id == SnippetTrackSpeaker.speaker_id)
            .filter(SnippetTrackSpeaker.media_file_id == media_file.id)
            .all()
        )
    }
    segment_tracks = set()
    if streams is None:
        segment_tracks = {
            t for (t,) in (
                db.query(TranscriptSegment.track_index)
                .filter(TranscriptSegment.media_file_id == media_file.id)
                .distinct()
                .all()
            )
        }
    return build_track_rows(streams, mapping, segment_tracks,
                            no_speech_tracks(db, media_file.id))


def build_track_rows(streams: Optional[list], mapping: dict, segment_tracks,
                     no_speech=frozenset()) -> list:
    """`track_rows` without the database: the same rule over values already read.

    `mapping` is {track_index: (speaker_id, speaker_name)}; `segment_tracks`
    the track indices that have segments (only consulted when `streams` is
    None); `no_speech` the tracks found to have no speech. GET
    /projects/{id}/snippet/files reads these for a whole page of files in a
    few queries and builds every file's rows here, so the two endpoints
    cannot come to list a file's tracks differently.
    """
    by_index = {
        s["audio_index"]: s for s in (streams or [])
        if isinstance(s, dict) and isinstance(s.get("audio_index"), int)
    }
    indices = set(by_index) | set(mapping)
    if streams is None:
        # A track found to have no speech has no segments, but it exists.
        indices |= set(segment_tracks) | set(no_speech)
        if not indices:
            indices = {0}
    return [
        {
            "track_index": idx,
            "label": track_label(by_index.get(idx), idx, no_speech=idx in no_speech),
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


#: Why a file whose latest version is not `ready` cannot be processed yet.
#: One wording for POST /snippet/process (the `reason` it answers with) and
#: GET /snippet/files (`not_ready_reason`, which the web shows on the
#: disabled row), so the two say the same thing about the same file.
NOT_READY_REASONS = {
    ProcessingStatus.uploading: "the file is still uploading",
    ProcessingStatus.processing: "the file is still being processed",
    ProcessingStatus.failed: "the file's own processing failed; fix that first",
}


def not_ready_reason(processing_status) -> Optional[str]:
    """None when the version is ready, else why SocialSnippet must wait."""
    if processing_status == ProcessingStatus.ready:
        return None
    return NOT_READY_REASONS.get(processing_status, "the file is not ready yet")


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


def _run_unfinished(db, media_file) -> bool:
    """The last run did not finish: it failed, or a stage of it is not done.

    Such a file is resumable even when an older transcript is still there,
    so "process what is new" (`skip_transcribed`) does not skip it.
    """
    if media_file.transcription_status == TranscriptionStatus.failed:
        return True
    return (
        db.query(SnippetJob.id)
        .filter(SnippetJob.media_file_id == media_file.id,
                SnippetJob.status != SnippetJobStatus.done)
        .first()
        is not None
    )


def planned_tracks(streams: Optional[list], mapping) -> Optional[list]:
    """The tracks the next run transcribes, when that is known from the
    recorded streams or the mapping; None when neither is known (the
    pipeline then probes the file itself)."""
    if streams is None and not mapping:
        return None
    tracks, _reason = select_tracks(streams, list(mapping))
    return tracks


def find_candidates(db, project_id=None, asset_id=None, asset_ids=None,
                    skip_transcribed: bool = False) -> list:
    """Every asset in scope, with what would happen to it.

    Scope is one of: a project (`project_id`), one asset (`asset_id`), or a
    list of assets that must all belong to `project_id` (`asset_ids`;
    ids that are not live assets of that project are left out, and the
    caller reports them). `skip_transcribed` leaves out a file that already
    has a SocialSnippet transcript AND whose last run finished, for
    "process what is new and continue what stopped" rather than "redo".
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
        if version is not None:
            # The transcode has to have finished first: an upload still in
            # flight has no complete original to read, and a failed one may
            # have none at all. Checked before anything that depends on the
            # media file, so the reason is the one a person can act on.
            not_ready = not_ready_reason(version.processing_status)
            if not_ready is not None:
                _skip(not_ready, version)
                continue
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
        if (skip_transcribed and _has_transcript(db, media_file.id)
                and not _run_unfinished(db, media_file)):
            _skip("already transcribed", version, media_file)
            continue
        out.append(Candidate(str(asset.id), asset.name, str(version.id), str(media_file.id),
                             True, "queue"))
    return out


def reprocess(db, candidates, enqueue: Callable, force: bool = False) -> int:
    """Queue each candidate, resuming or from scratch. Returns how many were queued.

    Without `force` (the default): every stage row that is done is KEPT --
    a transcribed track, a track marked "no speech", a finished gate -- so
    the task only redoes what is missing. The rows that are not done
    (failed, or left running by an interrupted worker) go back to pending,
    which is also what makes the Files tab read the file as queued.

    With `force`: every stage row is deleted, so the task redoes every
    stage. That is the point after changing the model, the gate settings or
    the track-to-speaker mapping.

    `enqueue(asset_id, version_id)` returns the Celery result. Commits: the
    reset has to be visible before the task can start.
    """
    queued = 0
    for c in candidates:
        if not c.enqueue:
            continue
        media_file_id = uuid.UUID(c.media_file_id)
        jobs = db.query(SnippetJob).filter(SnippetJob.media_file_id == media_file_id)
        if force:
            jobs.delete(synchronize_session=False)
        else:
            jobs.filter(SnippetJob.status != SnippetJobStatus.done).update(
                {SnippetJob.status: SnippetJobStatus.pending, SnippetJob.error: None,
                 SnippetJob.started_at: None, SnippetJob.finished_at: None},
                synchronize_session=False,
            )
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
