"""SocialSnippet HTTP API (socialsnippet-api-contract.md, draft v1).

Settings, processing, speakers and tracks, suggest, search, the transcript
range a clip editor reads, and editing one clip. Saves, tags, exports and
transcript editing are not here.

── Who may do what ────────────────────────────────────────────────────────
  read anything            any project member (viewer and up)
  speakers, tracks, clips  editor and up
  the file list            editor and up
  settings, process        the project owner or a superadmin
                           (`is_project_owner_or_superadmin`)

A caller who is not a member gets 404 for the project and for everything
in it, the same answer as "does not exist". A member below the role an
action needs gets 403: they can see the thing, so saying it exists tells
them nothing new. Share-link access is deliberately not supported.

409 when SocialSnippet is not enabled for the project, on everything
except the settings themselves (which is how it gets enabled).

── Order of checks ────────────────────────────────────────────────────────
visibility (404), role (403), enabled (409), then the request's own values
(422). FastAPI's own validation of the query and body runs before the
handler, so a malformed request is a 422 even for a caller who would have
got a 404.

── The read rule ──────────────────────────────────────────────────────────
Every read of an asset-bound table goes through `Model.live(db)` or
`live_media_file_clause` (models/snippet.py): a soft-deleted asset's
transcript, tracks and clips are a 404 here exactly as they are invisible
everywhere else.
"""
import logging
import math
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi import status as http_status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import Asset, AssetType, AssetVersion, MediaFile, TranscriptionStatus
from ..models.folder import Folder
from ..models.project import Project, ProjectRole
from ..models.snippet import (
    Snippet, SnippetSpeaker, SnippetStatus, TranscriptSegment, TranscriptWord,
    live_media_file_clause,
)
from ..models.user import User
from ..schemas.snippet import (
    Clip, ClipGroup, DetectSummary, SearchOut, SnippetFilesOut, SnippetPatch, SnippetProcessIn, SnippetProcessItem,
    SnippetProcessOut, SnippetSettingsOut, SnippetSettingsPatch, SnippetSourceLiteral,
    SnippetStatusLiteral, SpeakerIn, SpeakerOut, SuggestOut, TrackOut, TrackSpeakerIn,
    TrackSpeakerOut, TranscriptOut,
)
from ..services import snippet_admin, snippet_files, snippet_search
from ..services.permissions import (
    folder_chain_is_live, get_project_member, is_project_owner_or_superadmin,
    require_project_role,
)
from ..services.snippet_admin import SnippetAdminError
from .hls_proxy import create_hls_token, proxy_url_for

router = APIRouter(tags=["socialsnippet"])
logger = logging.getLogger(__name__)

#: The longest transcript range one request may read.
TRANSCRIPT_RANGE_MAX_MS = 10 * 60 * 1000
#: The shortest clip PATCH accepts.
CLIP_MIN_MS = 1_000
#: Most topics on one clip.
TOPICS_MAX = 8
#: Longest single topic. Detection writes one to three words.
TOPIC_MAX_CHARS = 100
#: `snippets.title` is String(255).
TITLE_MAX_CHARS = 255


# ── Access ─────────────────────────────────────────────────────────────────


def _not_found(what: str = "Not found") -> HTTPException:
    return HTTPException(status_code=404, detail=what)


def _live_project(db: Session, project_id: uuid.UUID) -> Project:
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        raise _not_found("Project not found")
    return project


def _require_member(db: Session, project_id: uuid.UUID, user: User, minimum: ProjectRole) -> None:
    """404 for a non-member, 403 for a member below `minimum` (require_project_role)."""
    _live_project(db, project_id)
    if get_project_member(db, project_id, user.id) is None:
        raise _not_found("Project not found")
    require_project_role(db, project_id, user, minimum)


def _require_owner(db: Session, project_id: uuid.UUID, user: User) -> None:
    _live_project(db, project_id)
    if is_project_owner_or_superadmin(db, project_id, user):
        return
    if get_project_member(db, project_id, user.id) is None:
        raise _not_found("Project not found")
    raise HTTPException(status_code=403, detail="Only the project owner can do this")


def _require_enabled(db: Session, project_id: uuid.UUID) -> None:
    if not snippet_admin.is_enabled(db, project_id):
        raise HTTPException(status_code=409, detail="SocialSnippet is not enabled for this project")


def _media_file_access(db: Session, media_file_id: uuid.UUID, user: User,
                       minimum: ProjectRole) -> tuple:
    """(media_file, asset) of a live asset the caller may act on, or 404/403/409."""
    media_file = (
        db.query(MediaFile)
        .filter(MediaFile.id == media_file_id, live_media_file_clause(MediaFile.id))
        .first()
    )
    if media_file is None:
        raise _not_found("Media file not found")
    asset = (
        db.query(Asset)
        .join(AssetVersion, AssetVersion.asset_id == Asset.id)
        .filter(AssetVersion.id == media_file.version_id)
        .first()
    )
    if asset is None:
        raise _not_found("Media file not found")
    try:
        _require_member(db, asset.project_id, user, minimum)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise _not_found("Media file not found") from None
        raise
    _require_enabled(db, asset.project_id)
    return media_file, asset


def _unprocessable(exc: Exception) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


def _duration_ms(duration_seconds: Optional[float]) -> Optional[int]:
    """The file's length in whole ms, rounded up; None when it was never probed."""
    if not duration_seconds or duration_seconds <= 0:
        return None
    return int(math.ceil(duration_seconds * 1000))


# ── Clip objects ───────────────────────────────────────────────────────────


class _UrlCache:
    """Stream and thumbnail URLs, built once per file per request.

    The same rule as GET /assets/{id}/stream and the share viewer: a video
    with an HLS rendition plays through /stream/hls/master.m3u8, everything
    else through `proxy_url_for` on the processed file, else the original.
    An audio file's `s3_key_thumbnail` is waveform JSON, not an image, so
    audio has no thumbnail (routers/assets.py does the same). Relative
    URLs, as every other media URL this API returns; the web resolves them
    with `resolveApiMediaUrl`.
    """

    def __init__(self):
        self._cache: dict = {}

    def urls(self, info: snippet_search.FileInfo) -> tuple:
        if info.media_file_id not in self._cache:
            stream = None
            if info.s3_key_processed:
                if info.asset_type == AssetType.video:
                    stream = f"/stream/hls/master.m3u8?token={create_hls_token(info.s3_key_processed)}"
                else:
                    stream = proxy_url_for(info.s3_key_processed)
            elif info.s3_key_raw:
                stream = proxy_url_for(info.s3_key_raw)
            thumb = None
            if info.asset_type != AssetType.audio and info.s3_key_thumbnail:
                thumb = proxy_url_for(info.s3_key_thumbnail)
            self._cache[info.media_file_id] = (stream, thumb)
        return self._cache[info.media_file_id]


def _clip(hit: snippet_search.Hit, info: snippet_search.FileInfo, speakers: dict,
          urls: _UrlCache) -> Clip:
    stream, thumb = urls.urls(info)
    speaker = None
    if hit.speaker_id is not None and hit.speaker_id in speakers:
        speaker = {"id": hit.speaker_id, "name": speakers[hit.speaker_id]}
    s = hit.snippet
    return Clip(
        id=hit.id,
        kind=hit.kind,
        asset_id=info.asset_id,
        asset_name=info.asset_name,
        media_file_id=hit.media_file_id,
        speaker=speaker,
        start_ms=hit.start_ms,
        end_ms=hit.end_ms,
        duration_ms=hit.duration_ms,
        title=s.title if s is not None else None,
        quote=s.quote if s is not None else hit.text,
        topics=list(s.topics or []) if s is not None else [],
        quality_score=s.quality_score if s is not None else None,
        viral_score=s.viral_score if s is not None else None,
        source=s.source if s is not None else None,
        generator=s.generator if s is not None else None,
        status=s.status.value if s is not None else None,
        user_edited=s is not None and s.user_edited_at is not None,
        stream_url=stream,
        thumbnail_url=thumb,
    )


def _snippet_hit(s: Snippet) -> snippet_search.Hit:
    return snippet_search.Hit(
        kind="snippet", media_file_id=s.media_file_id, start_ms=s.start_ms, end_ms=s.end_ms,
        speaker_id=s.speaker_id, rank=0.0, quality=s.quality_score, viral=s.viral_score,
        topics=list(s.topics or []), snippet=s,
    )


# ── Settings ───────────────────────────────────────────────────────────────


def _settings_out(values: dict) -> SnippetSettingsOut:
    return SnippetSettingsOut(**{k: values[k] for k in snippet_admin.SETTINGS_FIELDS})


@router.get("/projects/{project_id}/snippet/settings", response_model=SnippetSettingsOut)
def get_snippet_settings(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if is_project_owner_or_superadmin(db, project_id, current_user):
        _live_project(db, project_id)
    else:
        _require_member(db, project_id, current_user, ProjectRole.viewer)
    return _settings_out(snippet_admin.current_values(snippet_admin.settings_row(db, project_id)))


@router.patch("/projects/{project_id}/snippet/settings", response_model=SnippetSettingsOut)
def patch_snippet_settings(
    project_id: uuid.UUID,
    body: SnippetSettingsPatch,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Change any of the settings. Enabling does NOT queue any transcription:
    a whole project's worth would hold the transcription worker for days.
    Use POST /projects/{id}/snippet/process for the files wanted."""
    _require_owner(db, project_id, current_user)
    after = snippet_admin.current_values(snippet_admin.settings_row(db, project_id))
    given = body.model_fields_set
    try:
        if "enabled" in given:
            if body.enabled is None:
                raise SnippetAdminError("enabled must be true or false.")
            after["enabled"] = body.enabled
        if "source_folder_id" in given:
            folder_id = body.source_folder_id
            if folder_id is not None:
                folder = db.query(Folder).filter(Folder.id == folder_id).first()
                # One answer for "no such folder", "another project's" and
                # "in the trash": a source folder outside the project would
                # put every asset out of scope, and the caller learns nothing
                # about folders they cannot see.
                if (folder is None or folder.project_id != project_id
                        or not folder_chain_is_live(db, folder_id)):
                    raise SnippetAdminError("source_folder_id is not a folder of this project.")
            after["source_folder_id"] = folder_id
        if "export_retention_days" in given:
            snippet_admin.check_retention_days(
                body.export_retention_days, label="export_retention_days",
                forever_hint="send null to keep exports indefinitely",
            )
            after["export_retention_days"] = body.export_retention_days
        if "export_aspect" in given:
            if body.export_aspect is None:
                raise SnippetAdminError("export_aspect must not be null.")
            snippet_admin.check_export_aspect(body.export_aspect, label="export_aspect")
            after["export_aspect"] = body.export_aspect
        if "caption_font" in given:
            after["caption_font"] = snippet_admin.clean_caption_font(
                body.caption_font, label="caption_font"
            )
    except SnippetAdminError as exc:
        db.rollback()
        raise _unprocessable(exc) from None
    if given:
        snippet_admin.write_settings(db, project_id, after)
        db.commit()
    return _settings_out(after)


@router.post("/projects/{project_id}/snippet/process", response_model=SnippetProcessOut)
def process_assets(
    project_id: uuid.UUID,
    body: SnippetProcessIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Queue SocialSnippet transcription for exactly these assets (at most 20).

    The rules are snippet_reprocess.py's (services/snippet_admin.py): in
    scope, a video or audio file whose latest version is `ready`,
    transcription on, nothing running, no edited segments. A file that already has a transcript is skipped unless
    `force`; with `force` it is transcribed afresh. Each asset answers with
    whether it was queued and why not; an id that is not a live asset of
    this project answers "not found".
    """
    _require_owner(db, project_id, current_user)
    _require_enabled(db, project_id)
    wanted = list(dict.fromkeys(body.asset_ids))
    candidates = snippet_admin.find_candidates(
        db, project_id=project_id, asset_ids=wanted, skip_transcribed=not body.force,
    )
    from ..tasks.transcribe_tasks import transcribe_asset

    queued = snippet_admin.reprocess(db, candidates, transcribe_asset.delay)
    by_id = {c.asset_id: c for c in candidates}
    results = []
    for asset_id in wanted:
        c = by_id.get(str(asset_id))
        if c is None:
            results.append(SnippetProcessItem(asset_id=asset_id, queued=False, reason="not found"))
        else:
            results.append(SnippetProcessItem(asset_id=asset_id, queued=c.enqueue, reason=c.reason))
    return SnippetProcessOut(queued=queued, results=results)


@router.get("/projects/{project_id}/snippet/files", response_model=SnippetFilesOut)
def list_snippet_files(
    project_id: uuid.UUID,
    q: Optional[str] = Query(default=None, max_length=200),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The project's video and audio files inside the source folder, by name,
    with how far SocialSnippet has got with each (services/snippet_files.py).

    Editor and up: the list exists to start processing and name speakers,
    which a viewer or reviewer cannot do. `q` matches the file name.
    """
    _require_member(db, project_id, current_user, ProjectRole.editor)
    _require_enabled(db, project_id)
    row = snippet_admin.settings_row(db, project_id)
    result = snippet_files.list_files(
        db, project_id, row.source_folder_id if row is not None else None,
        q, page, page_size,
    )
    return SnippetFilesOut(total=result.total, items=result.items)


# ── Speakers and tracks ────────────────────────────────────────────────────


@router.get("/projects/{project_id}/snippet/speakers", response_model=list[SpeakerOut])
def list_speakers(
    project_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_member(db, project_id, current_user, ProjectRole.viewer)
    _require_enabled(db, project_id)
    people = snippet_search.roster(db, project_id)
    return [SpeakerOut(id=sid, name=name)
            for sid, name in sorted(people.items(), key=lambda p: (p[1].lower(), str(p[0])))]


@router.post("/projects/{project_id}/snippet/speakers", response_model=SpeakerOut)
def create_speaker(
    project_id: uuid.UUID,
    body: SpeakerIn,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """201 with the new speaker, or 200 with the existing one when the name
    matches ignoring case and spacing."""
    _require_member(db, project_id, current_user, ProjectRole.editor)
    _require_enabled(db, project_id)
    try:
        speaker, created = snippet_admin.find_or_create_speaker(
            db, project_id, body.name, created_by=current_user.id, label="name",
        )
        db.commit()
    except SnippetAdminError as exc:
        db.rollback()
        raise _unprocessable(exc) from None
    except IntegrityError:
        # Two requests creating the same name at once: the unique index on
        # (project_id, lower(name)) let one in. Answer with that one.
        db.rollback()
        speaker, created = snippet_admin.find_or_create_speaker(
            db, project_id, body.name, label="name",
        )
        db.commit()
    response.status_code = http_status.HTTP_201_CREATED if created else http_status.HTTP_200_OK
    return SpeakerOut(id=speaker.id, name=speaker.name)


@router.get("/media-files/{media_file_id}/snippet/tracks", response_model=list[TrackOut])
def list_tracks(
    media_file_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    media_file, _asset = _media_file_access(db, media_file_id, current_user, ProjectRole.viewer)
    return [TrackOut(**row) for row in snippet_admin.track_rows(db, media_file)]


@router.put("/media-files/{media_file_id}/snippet/tracks/{track_index}/speaker",
            response_model=TrackSpeakerOut)
def set_track_speaker(
    media_file_id: uuid.UUID,
    track_index: int,
    body: TrackSpeakerIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Map the track to a speaker of the same project and relabel the
    segments already transcribed on it (as snippet_set_track_speaker.py),
    then re-run clip detection for the file so its suggestions carry the
    speaker (`detect_summary`; see `_redetect`)."""
    media_file, asset = _media_file_access(db, media_file_id, current_user, ProjectRole.editor)
    speaker = (
        db.query(SnippetSpeaker)
        .filter(SnippetSpeaker.id == body.speaker_id,
                SnippetSpeaker.project_id == asset.project_id)
        .first()
    )
    if speaker is None:
        raise _not_found("Speaker not found")
    try:
        result = snippet_admin.assign_track_speaker(
            db, media_file, track_index, speaker, label="track_index",
        )
    except SnippetAdminError as exc:
        db.rollback()
        raise _unprocessable(exc) from None
    db.commit()
    detect_summary = _redetect(db, media_file)
    row = next(r for r in snippet_admin.track_rows(db, media_file) if r["track_index"] == track_index)
    return TrackSpeakerOut(**row, segments_relabelled=result["segments_relabelled"],
                           detect_summary=detect_summary)


def _redetect(db: Session, media_file: MediaFile) -> DetectSummary:
    """Re-run the pipeline's detect stage for one file, after its speakers changed.

    `_stage_detect` (tasks/transcribe_tasks.py) is the stage itself: the same
    `run_detect_for_media_file` scripts/snippet_detect.py calls, plus the
    stage's snippet_jobs row, so a detect failure recorded by an earlier
    run is cleared by a good one here and the file list stops reporting
    it. No Whisper and no network. What it may replace is the one rule in
    `replaceable_snippets` (untouched keyword suggestions); approved,
    rejected, imported, hand-made and person-edited clips are left alone,
    and no new suggestion overlaps one of them.

    Never raises: the speaker change is already committed, and a suggester
    that fails must not turn a saved change into an error. Not run while a
    transcription is in flight (its own detect stage runs at the end and
    reads the new speaker from the relabelled segments), nor for a file
    with no transcript, which has nothing to detect from.
    """
    if media_file.transcription_status == TranscriptionStatus.processing:
        return DetectSummary(ran=False, reason="A transcription is running; it will "
                             "detect clips with this speaker when it finishes.")
    has_transcript = (
        TranscriptSegment.live(db)
        .filter(TranscriptSegment.media_file_id == media_file.id)
        .first()
        is not None
    )
    if not has_transcript:
        return DetectSummary(ran=False, reason="No transcript yet; clips are detected "
                             "when the file is processed.")
    from ..models.snippet import SnippetJob
    from ..tasks.transcribe_tasks import SNIPPET_STAGE_DETECT, _stage_detect

    media_file_id = media_file.id
    # The relabel is a bulk UPDATE that does not touch segment objects the
    # session already holds; detection must read the new speaker, not a
    # cached one. A no-op with the app's sessions (they expire on commit),
    # and what keeps this right under a session that does not.
    db.expire_all()
    result = _stage_detect(db, media_file_id)
    if result is None:
        job = (
            db.query(SnippetJob)
            .filter(SnippetJob.media_file_id == media_file_id,
                    SnippetJob.stage == SNIPPET_STAGE_DETECT)
            .first()
        )
        message = job.error if job is not None and job.error else "no message"
        logger.warning("Re-detect after a speaker change failed for media file %s: %s",
                       media_file_id, message)
        return DetectSummary(ran=False, reason=f"Clip detection failed: {message}")
    return DetectSummary(ran=True, created=result["created"], removed=result["removed"])


# ── Suggest and search ─────────────────────────────────────────────────────


@router.get("/projects/{project_id}/snippet/suggest", response_model=SuggestOut)
def suggest(
    project_id: uuid.UUID,
    q: str = Query(default="", max_length=200),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_member(db, project_id, current_user, ProjectRole.viewer)
    _require_enabled(db, project_id)
    return snippet_search.suggest(db, project_id, q)


@router.get("/projects/{project_id}/snippet/search", response_model=SearchOut)
def search(
    project_id: uuid.UUID,
    q: Optional[str] = Query(default=None, max_length=200),
    speaker_id: list[uuid.UUID] = Query(default=[]),
    topic: list[str] = Query(default=[]),
    min_ms: Optional[int] = Query(default=None, ge=0),
    max_ms: Optional[int] = Query(default=None, ge=0),
    source: list[SnippetSourceLiteral] = Query(default=[]),
    status: list[SnippetStatusLiteral] = Query(default=[]),
    sort: Literal["relevance", "quality", "viral", "length_asc", "length_desc"] = "relevance",
    group: Literal["none", "speaker", "topic"] = "none",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=24, ge=1, le=60),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clips and moments, grouped, sorted and paginated.

    `status` is an addition to the contract: by default suggested and
    approved clips are shown and rejected ones are not; naming statuses
    shows exactly those (and no moments, which have no status).
    """
    _require_member(db, project_id, current_user, ProjectRole.viewer)
    _require_enabled(db, project_id)
    if min_ms is not None and max_ms is not None and min_ms > max_ms:
        raise HTTPException(status_code=422, detail="min_ms must not be greater than max_ms.")
    result = snippet_search.search(db, project_id, snippet_search.SearchParams(
        q=q, speaker_ids=speaker_id, topics=topic, min_ms=min_ms, max_ms=max_ms,
        sources=list(source), statuses=list(status), sort=sort, group=group,
        page=page, page_size=page_size,
    ))
    urls = _UrlCache()
    return SearchOut(
        total=result.total, page=page, page_size=page_size,
        groups=[
            ClipGroup(key=key, label=label,
                      items=[_clip(h, result.files[h.media_file_id], result.speakers, urls)
                             for h in hits])
            for key, label, hits in result.groups
        ],
    )


# ── Clip detail and edit ───────────────────────────────────────────────────


@router.get("/media-files/{media_file_id}/snippet/transcript", response_model=TranscriptOut)
def get_transcript_range(
    media_file_id: uuid.UUID,
    from_ms: int = Query(default=0, ge=0),
    to_ms: Optional[int] = Query(default=None, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The segments overlapping [from_ms, to_ms), each with all of its words.

    At most 10 minutes per request; `to_ms` defaults to 10 minutes after
    `from_ms`. A `to_ms` past the end of the file is fine (the range just
    ends there); a `from_ms` past it is a 422.
    """
    media_file, asset = _media_file_access(db, media_file_id, current_user, ProjectRole.viewer)
    to = to_ms if to_ms is not None else from_ms + TRANSCRIPT_RANGE_MAX_MS
    if to <= from_ms:
        raise HTTPException(status_code=422, detail="to_ms must be after from_ms.")
    if to - from_ms > TRANSCRIPT_RANGE_MAX_MS:
        raise HTTPException(status_code=422, detail="The range may be at most 10 minutes.")
    duration = _duration_ms(media_file.duration_seconds)
    if duration is not None and from_ms >= duration:
        raise HTTPException(status_code=422, detail="from_ms is past the end of the file.")

    segments = (
        TranscriptSegment.live(db)
        .filter(TranscriptSegment.media_file_id == media_file.id,
                TranscriptSegment.start_ms < to,
                TranscriptSegment.end_ms > from_ms)
        .order_by(TranscriptSegment.start_ms, TranscriptSegment.track_index,
                  TranscriptSegment.seq)
        .all()
    )
    words: dict = {}
    if segments:
        for w in (
            TranscriptWord.live(db)
            .filter(TranscriptWord.segment_id.in_([s.id for s in segments]))
            .order_by(TranscriptWord.segment_id, TranscriptWord.idx)
            .all()
        ):
            words.setdefault(w.segment_id, []).append(
                {"start_ms": w.start_ms, "end_ms": w.end_ms, "word": w.word}
            )
    names = snippet_search.roster(db, asset.project_id) if segments else {}
    language = media_file.transcript_language
    if not language:
        counted = Counter(s.language for s in segments if s.language)
        language = counted.most_common(1)[0][0] if counted else None
    return TranscriptOut(
        language=language,
        segments=[
            {
                "id": s.id,
                "track_index": s.track_index,
                "speaker_name": names.get(s.speaker_id) if s.speaker_id else None,
                "start_ms": s.start_ms,
                "end_ms": s.end_ms,
                "text": s.text_current,
                "status": s.status.value,
                "words": words.get(s.id, []),
            }
            for s in segments
        ],
    )


def _clean_topics(raw) -> list:
    out, seen = [], set()
    for t in raw or []:
        clean = snippet_admin.clean_text(t)
        if not clean or clean.lower() in seen:
            continue
        if len(clean) > TOPIC_MAX_CHARS:
            raise SnippetAdminError(f"A topic may be at most {TOPIC_MAX_CHARS} characters.")
        seen.add(clean.lower())
        out.append(clean)
    if len(out) > TOPICS_MAX:
        raise SnippetAdminError(f"A clip may have at most {TOPICS_MAX} topics.")
    return out


@router.patch("/snippets/{snippet_id}", response_model=Clip)
def patch_snippet(
    snippet_id: uuid.UUID,
    body: SnippetPatch,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Title, topics, status and in/out points of one clip.

    New times must keep start before end, at least 1 s apart, inside the
    file (when its length is known). `source` and `generator` are left as
    they are: they say where the clip came from, not who last trimmed it.

    `user_edited_at` is set (UTC now) when the title, topics, start or end
    actually changes; a status change alone, or values equal to the stored
    ones, leave it as it is. Clip detection keeps an edited clip like an
    approved one (tasks/transcribe_tasks.replaceable_snippets).
    """
    snippet = Snippet.live(db).filter(Snippet.id == snippet_id).first()
    if snippet is None:
        raise _not_found("Snippet not found")
    try:
        media_file, asset = _media_file_access(
            db, snippet.media_file_id, current_user, ProjectRole.editor,
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            raise _not_found("Snippet not found") from None
        raise

    given = body.model_fields_set
    edited = False
    try:
        if "title" in given:
            title = snippet_admin.clean_text(body.title)
            if len(title) > TITLE_MAX_CHARS:
                raise SnippetAdminError(f"title may be at most {TITLE_MAX_CHARS} characters.")
            if (title or None) != snippet.title:
                snippet.title = title or None
                edited = True
        if "topics" in given:
            topics = _clean_topics(body.topics)
            if topics != list(snippet.topics or []):
                snippet.topics = topics
                edited = True
        if "status" in given:
            if body.status is None:
                raise SnippetAdminError("status must not be null.")
            snippet.status = SnippetStatus(body.status)
        if "start_ms" in given or "end_ms" in given:
            if ("start_ms" in given and body.start_ms is None) or (
                    "end_ms" in given and body.end_ms is None):
                raise SnippetAdminError("start_ms and end_ms must not be null.")
            start = body.start_ms if "start_ms" in given else snippet.start_ms
            end = body.end_ms if "end_ms" in given else snippet.end_ms
            if start < 0:
                raise SnippetAdminError("start_ms must be 0 or more.")
            if start >= end:
                raise SnippetAdminError("start_ms must be before end_ms.")
            if end - start < CLIP_MIN_MS:
                raise SnippetAdminError("A clip must be at least 1 second long.")
            duration = _duration_ms(media_file.duration_seconds)
            if duration is not None and end > duration:
                raise SnippetAdminError("end_ms is past the end of the file.")
            if (start, end) != (snippet.start_ms, snippet.end_ms):
                snippet.start_ms, snippet.end_ms = start, end
                edited = True
    except SnippetAdminError as exc:
        db.rollback()
        raise _unprocessable(exc) from None
    if edited:
        snippet.user_edited_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(snippet)

    files = snippet_search.file_infos(db, [snippet.media_file_id])
    speakers = snippet_search.roster(db, asset.project_id)
    return _clip(_snippet_hit(snippet), files[snippet.media_file_id], speakers, _UrlCache())
