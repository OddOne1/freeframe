"""SocialSnippet clip exports: POST /snippets/{id}/exports, GET /exports/{id}.

Access reuses routers/snippet.py's helpers, so the answers match the rest of
the feature: 404 for anything the caller may not see, 403 for a member below
editor on POST, 409 when SocialSnippet is off, 422 for a request that cannot
be rendered (with the reason as it is).

Same inputs, same export: the cache key (services/snippet_export.cache_key)
is unique, so a second identical POST returns the first row. A row that
failed, expired, or went quiet for EXPORT_STALE_AFTER is re-queued in place
(same export_id), which is how "retry" works: post the same request again.
"""

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi import status as http_status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.asset import FileType
from ..models.project import ProjectRole
from ..models.snippet import Snippet, SnippetSpeaker, TranscriptSegment
from ..models.snippet_export import SnippetExport
from ..models.user import User
from ..schemas.snippet import SnippetExportCreatedOut, SnippetExportIn, SnippetExportOut
from ..services import snippet_export as rules
from ..tasks.celery_app import send_task_safe
from ..tasks.snippet_export_tasks import render_snippet_export
from .hls_proxy import proxy_url_for
from .snippet import (
    _duration_ms, _media_file_access, _not_found, _require_enabled, _require_member,
)

router = APIRouter(tags=["socialsnippet"])


def _parse_target(raw_id: str):
    """("snippet", uuid) or ("moment", media_file_id, start_ms); 404 otherwise."""
    if raw_id.startswith("moment:"):
        parts = raw_id.split(":")
        if len(parts) != 3:
            raise _not_found("Snippet not found")
        try:
            return ("moment", uuid.UUID(parts[1]), int(parts[2]))
        except ValueError:
            raise _not_found("Snippet not found") from None
    try:
        return ("snippet", uuid.UUID(raw_id))
    except ValueError:
        raise _not_found("Snippet not found") from None


def _speaker_at(db: Session, media_file_id, at_ms: int) -> Optional[str]:
    """The speaker of the transcript segment under `at_ms`, for a moment's name."""
    seg = (
        db.query(TranscriptSegment)
        .filter(
            TranscriptSegment.media_file_id == media_file_id,
            TranscriptSegment.start_ms <= at_ms,
            TranscriptSegment.end_ms > at_ms,
        )
        .order_by(TranscriptSegment.start_ms)
        .first()
    )
    if seg is None or seg.speaker_id is None:
        return None
    sp = db.query(SnippetSpeaker).filter(SnippetSpeaker.id == seg.speaker_id).first()
    return sp.name if sp else None


def _unprocessable(message: str) -> HTTPException:
    return HTTPException(status_code=422, detail=message)


@router.post("/snippets/{snippet_id}/exports", response_model=SnippetExportCreatedOut)
def create_export(
    snippet_id: str,
    body: SnippetExportIn,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Queue a render, or return the existing export for the same inputs.

    `start_ms`/`end_ms` default to a snippet's saved in/out (the contract
    sends them; the default keeps a client that sends only `aspect`
    working). A moment needs `end_ms`.
    """
    target = _parse_target(snippet_id)
    snippet = None
    if target[0] == "snippet":
        snippet = Snippet.live(db).filter(Snippet.id == target[1]).first()
        if snippet is None:
            raise _not_found("Snippet not found")
        media_file_id = snippet.media_file_id
    else:
        media_file_id = target[1]
    try:
        media_file, asset = _media_file_access(db, media_file_id, current_user, ProjectRole.editor)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise _not_found("Snippet not found") from None
        raise

    if snippet is not None:
        start = body.start_ms if body.start_ms is not None else snippet.start_ms
        end = body.end_ms if body.end_ms is not None else snippet.end_ms
        speaker_name = None
        if snippet.speaker_id:
            sp = db.query(SnippetSpeaker).filter(SnippetSpeaker.id == snippet.speaker_id).first()
            speaker_name = sp.name if sp else None
    else:
        start = body.start_ms if body.start_ms is not None else target[2]
        if body.end_ms is None:
            raise _unprocessable("end_ms is required for a moment.")
        end = body.end_ms
        speaker_name = _speaker_at(db, media_file.id, start)

    try:
        rules.check_aspect(body.aspect)
        if body.captions:
            raise rules.ExportError("captions not available yet")
        if media_file.file_type == FileType.audio:
            raise rules.ExportError("audio-only export not supported yet")
        rules.check_range(start, end, _duration_ms(media_file.duration_seconds))
        framing = rules.normalise_framing(body.framing.model_dump() if body.framing else None)
    except rules.ExportError as exc:
        raise _unprocessable(str(exc)) from None

    caption_style = body.caption_style.model_dump() if body.caption_style else None
    key = rules.cache_key(
        media_file.version_id, start, end, body.aspect, framing, body.captions, caption_style,
    )

    row = db.query(SnippetExport).filter(SnippetExport.cache_key == key).first()
    if row is not None:
        live = row.status == "done" and row.s3_key
        busy = row.status in ("queued", "running") and not rules.is_stale(row.updated_at)
        if live or busy:
            response.status_code = http_status.HTTP_200_OK
            return SnippetExportCreatedOut(export_id=row.id, status=row.status)
        # failed, expired, or lost in a worker restart: render it again.
        row.status, row.progress, row.error = "queued", 0.0, None
        row.s3_key, row.size_bytes, row.expires_at = None, None, None
        row.snippet_id = snippet.id if snippet else row.snippet_id
        row.created_by = current_user.id
    else:
        row = SnippetExport(
            project_id=asset.project_id,
            snippet_id=snippet.id if snippet else None,
            media_file_id=media_file.id,
            asset_version_id=media_file.version_id,
            start_ms=start,
            end_ms=end,
            aspect=body.aspect,
            framing=framing,
            caption_style=caption_style,
            captions=body.captions,
            cache_key=key,
            status="queued",
            progress=0.0,
            download_filename=rules.download_filename(asset.name, speaker_name, start, end, body.aspect),
            created_by=current_user.id,
        )
        db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Two identical POSTs raced; the other one's row is the export.
        db.rollback()
        row = db.query(SnippetExport).filter(SnippetExport.cache_key == key).first()
        if row is None:
            raise
        response.status_code = http_status.HTTP_200_OK
        return SnippetExportCreatedOut(export_id=row.id, status=row.status)

    send_task_safe(render_snippet_export, str(row.id))
    response.status_code = http_status.HTTP_202_ACCEPTED
    return SnippetExportCreatedOut(export_id=row.id, status="queued")


@router.get("/exports/{export_id}", response_model=SnippetExportOut)
def get_export(
    export_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Status, progress, and the download once done.

    Readable by any project member (viewer and up), and still answers after
    the source asset is gone: the row keeps its own key and filename.
    """
    row = db.query(SnippetExport).filter(SnippetExport.id == export_id).first()
    if row is None:
        raise _not_found("Export not found")
    try:
        _require_member(db, row.project_id, current_user, ProjectRole.viewer)
    except HTTPException as exc:
        if exc.status_code == 404:
            raise _not_found("Export not found") from None
        raise
    _require_enabled(db, row.project_id)

    url = None
    if row.status == "done" and row.s3_key:
        url = proxy_url_for(row.s3_key, download_filename=row.download_filename or "clip.mp4")
    return SnippetExportOut(
        status=row.status,
        progress=float(row.progress or 0.0),
        download_url=url,
        error=row.error,
    )
