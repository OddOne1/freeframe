"""SocialSnippet's file list: which files of a project it knows about, and how far each is.

Called by GET /projects/{id}/snippet/files (routers/snippet.py); no HTTP here.
Runs on SQLite and Postgres alike: nothing below needs full-text search.

── What is listed ──────────────────────────────────────────────────────────
Every live video or audio asset of the project inside the source folder
(the folder itself and everything below it; the whole project when there
is none), with its latest live version's media file. An asset in the trash,
or under a trashed folder, is not listed. A file the owner hid from
SocialSnippet is left out unless asked for (`hidden`), and flagged when
listed. The scope rule is `folder_in_scope` (services/snippet_transcribe.py),
the same one the pipeline uses to decide whether a file takes the
SocialSnippet path, so a file is listed here exactly when processing it
would run this pipeline.

── Where `snippet_status` comes from ───────────────────────────────────────
No column says it; it is read off what the pipeline leaves behind (see
`derive_status`):

  * the file's `snippet_jobs` rows, one per stage;
  * whether it has transcript segments;
  * `media_files.transcription_status`, for what the jobs alone cannot
    say: `snippet_admin.reprocess` sets it to `processing` when it queues
    the task. A forced run's job rows are deleted first, so until the
    worker picks the task up the file has no jobs at all; a resumed run
    keeps its done rows and puts the rest back to pending. Either way no
    stage is running or failed, and only the status says it is queued.

── Cost ────────────────────────────────────────────────────────────────────
A fixed number of statements however many files are on the page: the
folders, a count, the page, then one grouped query each for segments,
clips, jobs and track speakers over the page's media files. The test
suite counts them.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, func, or_, select

from ..models.asset import (
    Asset, AssetType, AssetVersion, MediaFile, ProcessingStatus, TranscriptionStatus,
)
from ..models.folder import Folder
from ..models.snippet import (
    Snippet, SnippetHiddenAsset, SnippetJob, SnippetJobStatus, SnippetSpeaker, SnippetStatus,
    SnippetTrackSpeaker, TranscriptSegment,
)
from . import snippet_admin
from .search import LIKE_ESCAPE, like_contains
from .snippet_transcribe import folder_in_scope

#: tasks/transcribe_tasks.py's SNIPPET_STAGE_STORE and SNIPPET_STAGE_DETECT.
#: Repeated rather than imported: importing the tasks module pulls in Celery
#: and boto3 for two strings. tests/test_snippet_files.py compares them.
STORE_STAGE = "store"
DETECT_STAGE = "detect"

#: GET /snippet/files?hidden=...
HIDDEN_MODES = ("exclude", "include", "only")

#: The values `snippet_status` takes.
NOT_PROCESSED, QUEUED, RUNNING, DONE, FAILED = (
    "not_processed", "queued", "running", "done", "failed",
)


# ── Status ─────────────────────────────────────────────────────────────────


@dataclass
class JobView:
    """The parts of one snippet_jobs row that the status is read from."""

    stage: str
    status: SnippetJobStatus
    error: Optional[str] = None
    updated_at: Optional[datetime] = None


def _utc(stamp: Optional[datetime]) -> datetime:
    """Comparable across drivers: SQLite hands back naive datetimes (UTC),
    Postgres aware ones."""
    if stamp is None:
        return datetime.min.replace(tzinfo=timezone.utc)
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def derive_status(transcription_status, jobs: Iterable[JobView],
                  segment_count: int) -> tuple:
    """(snippet_status, error) for one media file. Pure; the order is the rule.

    1. Any stage running: `running`.
    2. `transcription_status` is `processing` with no stage running:
       `running` when a stage has failed (a Celery retry of a transient
       error is under way), else `queued`. Done rows do not count as
       started: a resumed file keeps its done rows while it waits in the
       queue. The price is that a file whose worker is between two stages
       (milliseconds), or reloading finished stages on a resume (seconds),
       reads `queued` for that moment.
    3. A stage other than detect failed: `failed`, with that stage's error.
       This includes a run the task refused because a person edited the
       transcript; the old transcript is still there, and the error says why.
    4. `transcription_status` is `failed` with no failed stage (the task
       failed before its first stage): `failed`.
    5. Segments, or a finished `store` stage (a file with no speech has no
       segments): `done`. A failed detect stage does not undo that -- the
       pipeline itself keeps a good transcript when only the clip suggester
       broke -- but its error is passed on, so the row can say clips are
       missing and why.
    6. Otherwise `not_processed`.
    """
    jobs = list(jobs)
    if any(j.status == SnippetJobStatus.running for j in jobs):
        return RUNNING, None
    if transcription_status == TranscriptionStatus.processing:
        retrying = any(j.status == SnippetJobStatus.failed for j in jobs)
        return (RUNNING if retrying else QUEUED), None
    failed = [j for j in jobs if j.status == SnippetJobStatus.failed]
    pipeline_failed = [j for j in failed if j.stage != DETECT_STAGE]
    if pipeline_failed:
        latest = max(pipeline_failed, key=lambda j: _utc(j.updated_at))
        return FAILED, latest.error or f"The {latest.stage} stage failed."
    if transcription_status == TranscriptionStatus.failed:
        return FAILED, "Transcription failed before any stage started."
    store_done = any(j.stage == STORE_STAGE and j.status == SnippetJobStatus.done for j in jobs)
    if segment_count > 0 or store_done:
        detect_failed = [j for j in failed if j.stage == DETECT_STAGE]
        if detect_failed:
            return DONE, "Clip detection failed: " + (detect_failed[0].error or "no message")
        return DONE, None
    return NOT_PROCESSED, None


# ── Folders ────────────────────────────────────────────────────────────────


@dataclass
class Folders:
    """The project's folders, read once, and what is derived from them."""

    parent: dict = field(default_factory=dict)
    name: dict = field(default_factory=dict)
    trashed: set = field(default_factory=set)

    def path(self, folder_id) -> str:
        """"/" for the project root, else "/Parent/Child"."""
        parts, seen, current = [], set(), folder_id
        while current is not None and current not in seen and current in self.name:
            seen.add(current)
            parts.append(self.name[current])
            current = self.parent.get(current)
        return "/" + "/".join(reversed(parts))

    def chain_is_live(self, folder_id) -> bool:
        """Neither the folder nor any folder above it is in the trash
        (`permissions.folder_chain_is_live`, over rows already read)."""
        seen, current = set(), folder_id
        while current is not None and current not in seen:
            if current in self.trashed or current not in self.name:
                return False
            seen.add(current)
            current = self.parent.get(current)
        return True

    def listable(self, source_folder_id) -> list:
        """The live folders whose assets are in scope."""
        return [
            fid for fid in self.name
            if self.chain_is_live(fid)
            and folder_in_scope(fid, source_folder_id, self.parent.get)
        ]


def read_folders(db, project_id) -> Folders:
    f = Folders()
    for fid, parent_id, name, deleted_at in (
        db.query(Folder.id, Folder.parent_id, Folder.name, Folder.deleted_at)
        .filter(Folder.project_id == project_id)
        .all()
    ):
        f.parent[fid] = parent_id
        f.name[fid] = name
        if deleted_at is not None:
            f.trashed.add(fid)
    return f


# ── The list ───────────────────────────────────────────────────────────────


@dataclass
class FilesPage:
    total: int
    items: list


def _duration_ms(duration_seconds) -> Optional[int]:
    if not duration_seconds or duration_seconds <= 0:
        return None
    return int(math.ceil(duration_seconds * 1000))


def list_files(db, project_id, source_folder_id, q: Optional[str], page: int,
               page_size: int, hidden: str = "exclude") -> FilesPage:
    """One page of the project's in-scope video and audio files, by name.

    `hidden`: "exclude" leaves out the files hidden from SocialSnippet,
    "include" lists them with the rest, "only" lists nothing else. `total`
    counts what is listed. The one SocialSnippet read that reaches a hidden
    file's rows: everything below uses `live_clause`, not `visible_clause`,
    so a hidden file shows its real segment and clip counts here and can be
    told apart and restored.
    """
    if hidden not in HIDDEN_MODES:
        raise ValueError(f"hidden must be one of {HIDDEN_MODES}")
    folders = read_folders(db, project_id)
    in_scope = Asset.folder_id.in_(folders.listable(source_folder_id))
    if source_folder_id is None:
        in_scope = or_(Asset.folder_id.is_(None), in_scope)

    latest = (
        select(AssetVersion.asset_id, func.max(AssetVersion.version_number).label("vn"))
        .where(AssetVersion.deleted_at.is_(None))
        .group_by(AssetVersion.asset_id)
        .subquery()
    )
    criteria = [
        Asset.project_id == project_id,
        Asset.deleted_at.is_(None),
        Asset.asset_type.in_([AssetType.video, AssetType.audio]),
        in_scope,
    ]
    clean_q = snippet_admin.clean_text(q)
    if clean_q:
        criteria.append(Asset.name.ilike(like_contains(clean_q), escape=LIKE_ESCAPE))
    is_hidden = Asset.id.in_(
        select(SnippetHiddenAsset.asset_id).where(SnippetHiddenAsset.project_id == project_id)
    )
    if hidden == "exclude":
        criteria.append(~is_hidden)
    elif hidden == "only":
        criteria.append(is_hidden)

    def _base(*columns):
        return (
            db.query(*columns)
            .select_from(Asset)
            .join(latest, latest.c.asset_id == Asset.id)
            .join(AssetVersion, and_(AssetVersion.asset_id == Asset.id,
                                     AssetVersion.version_number == latest.c.vn,
                                     AssetVersion.deleted_at.is_(None)))
            .outerjoin(MediaFile, MediaFile.version_id == AssetVersion.id)
            .filter(*criteria)
        )

    total = _base(func.count(Asset.id)).scalar() or 0
    rows = (
        _base(Asset, AssetVersion.processing_status, MediaFile, is_hidden.label("hidden"))
        .order_by(func.lower(Asset.name), Asset.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    mf_ids = [mf.id for _a, _s, mf, _h in rows if mf is not None]

    segments: dict = {}       # media file -> {track: segment count}
    clips: dict = {}          # media file -> clip count
    jobs: dict = {}           # media file -> [JobView]
    mapping: dict = {}        # media file -> {track: (speaker_id, name)}
    if mf_ids:
        for mf_id, track, n in (
            db.query(TranscriptSegment.media_file_id, TranscriptSegment.track_index,
                     func.count(TranscriptSegment.id))
            .filter(TranscriptSegment.media_file_id.in_(mf_ids), TranscriptSegment.live_clause())
            .group_by(TranscriptSegment.media_file_id, TranscriptSegment.track_index)
            .all()
        ):
            segments.setdefault(mf_id, {})[track] = n
        # Rejected clips are not counted: the clip browser does not show them
        # unless asked (snippet_search.DEFAULT_STATUSES).
        for mf_id, n in (
            db.query(Snippet.media_file_id, func.count(Snippet.id))
            .filter(Snippet.media_file_id.in_(mf_ids), Snippet.live_clause(),
                    Snippet.status != SnippetStatus.rejected)
            .group_by(Snippet.media_file_id)
            .all()
        ):
            clips[mf_id] = n
        for mf_id, stage, status, error, updated_at in (
            db.query(SnippetJob.media_file_id, SnippetJob.stage, SnippetJob.status,
                     SnippetJob.error, SnippetJob.updated_at)
            .filter(SnippetJob.media_file_id.in_(mf_ids), SnippetJob.live_clause())
            .all()
        ):
            jobs.setdefault(mf_id, []).append(JobView(stage, status, error, updated_at))
        for mf_id, track, speaker_id, name in (
            db.query(SnippetTrackSpeaker.media_file_id, SnippetTrackSpeaker.track_index,
                     SnippetSpeaker.id, SnippetSpeaker.name)
            .join(SnippetSpeaker, SnippetSpeaker.id == SnippetTrackSpeaker.speaker_id)
            .filter(SnippetTrackSpeaker.media_file_id.in_(mf_ids),
                    SnippetTrackSpeaker.live_clause())
            .all()
        ):
            mapping.setdefault(mf_id, {})[track] = (speaker_id, name)

    items = []
    for asset, processing_status, mf, is_hidden_row in rows:
        mf_id = mf.id if mf is not None else None
        file_jobs = jobs.get(mf_id, [])
        by_track = segments.get(mf_id, {})
        segment_count = sum(by_track.values())
        planned, done_tracks = None, 0
        if mf is None:
            snippet_status, error, tracks = NOT_PROCESSED, None, []
        else:
            snippet_status, error = derive_status(mf.transcription_status, file_jobs, segment_count)
            streams = snippet_admin.audio_streams(mf)
            file_mapping = mapping.get(mf_id, {})
            no_speech = {
                snippet_admin.track_of_stage(j.stage) for j in file_jobs
                if snippet_admin.is_no_speech_job(j.stage, j.status, j.error)
            }
            tracks = snippet_admin.build_track_rows(
                streams, file_mapping, set(by_track), no_speech,
            )
            # For the Files tab's estimate: what a run transcribes, and how
            # much of that a resume keeps.
            planned = snippet_admin.planned_tracks(streams, file_mapping)
            finished = {
                snippet_admin.track_of_stage(j.stage) for j in file_jobs
                if j.status == SnippetJobStatus.done
                and snippet_admin.track_of_stage(j.stage) is not None
            }
            done_tracks = len(finished & set(planned)) if planned is not None else 0
        stamps = [s for s in [asset.updated_at, *(j.updated_at for j in file_jobs)] if s]
        items.append({
            "asset_id": asset.id,
            "media_file_id": mf_id,
            "name": asset.name,
            "kind": asset.asset_type.value,
            "folder_path": folders.path(asset.folder_id),
            "duration_ms": _duration_ms(mf.duration_seconds) if mf is not None else None,
            "asset_status": (processing_status or ProcessingStatus.uploading).value,
            "not_ready_reason": snippet_admin.not_ready_reason(processing_status),
            "snippet_status": snippet_status,
            "segment_count": segment_count,
            "snippet_count": clips.get(mf_id, 0),
            "error": error,
            "updated_at": max(stamps, key=_utc) if stamps else None,
            "tracks": tracks,
            "planned_track_count": len(planned) if planned is not None else None,
            "done_track_count": done_tracks,
            "hidden": bool(is_hidden_row),
        })
    return FilesPage(total=total, items=items)
