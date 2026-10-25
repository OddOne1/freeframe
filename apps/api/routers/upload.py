import logging
import os
from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends, HTTPException, Query, status, BackgroundTasks
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from sqlalchemy import func
import uuid
from datetime import datetime, timezone
from ..database import get_db
from ..middleware.auth import get_current_user
from ..models.user import User
from ..models.asset import Asset, AssetVersion, MediaFile, AssetType, ProcessingStatus, FileType
from ..models.project import Project
from ..services.s3_service import (
    create_multipart_upload, presign_upload_part,
    complete_multipart_upload, abort_multipart_upload,
    head_object_size, list_multipart_parts, NoSuchUploadError,
    IncompleteListingError,
)
from ..services.upload_completion import (
    PartsIncomplete, parts_for_completion, note_client_disagreement,
    is_upload_gone, error_code_of, PART_REFUSAL_CODES,
)
from ..services.upload_policy import plan_parts, UploadTooLarge
from ..services.permissions import get_project_member, require_project_role
from ..models.project import ProjectRole
from .site_settings import _get_or_create_settings
from ..services.storage_prefix import lock_storage_prefix, prefix_for_project
from ..schemas.upload import (
    InitiateUploadRequest, InitiateUploadResponse,
    PresignPartRequest, PresignPartResponse,
    CompleteUploadRequest, CompleteUploadResponse, AbortUploadRequest,
    UploadedPartsResponse, UploadErrorDetail,
    ALLOWED_MIME_TYPES, mime_to_asset_type,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/upload", tags=["upload"])


def _reconcile_file_size(media_file: MediaFile) -> None:
    """Replace the client's declared size with the object's real one (§180).

    `file_size_bytes` is written at /upload/initiate from a number the
    browser sent, and until now nothing ever checked it. Both storage-quota
    checks in this file and every storage figure in the admin UI are sums of
    that column, so under-reporting walked straight past a quota and
    over-reporting could refuse an upload that would have fit.

    The key HEADed is the one the SERVER generated and stored, not
    `body.s3_key` from the request: the client supplies that too, and
    reconciling against a client-chosen key would check a number against
    whatever object the client pointed at. If the two disagree, this HEAD
    fails and the row is flagged — which is the correct outcome, since the
    object this row claims to describe then does not exist.

    ── When the HEAD fails ──────────────────────────────────────────────
    Retried once, then given up on. The upload itself is NOT failed: the
    bytes are in S3, complete_multipart_upload has already returned, and
    refusing the upload over a size check would throw away a good file to
    protect a number. Nor is the bad value left silently in place —
    `size_verified_at` stays NULL, which is the work queue a backfill reads
    (`WHERE size_verified_at IS NULL`), and the mismatch is logged at ERROR
    with the key so it is findable before that backfill exists.

    One retry rather than several: this runs inside a request the user is
    waiting on, and the failures worth beating this way are the momentary
    ones. A bucket that is genuinely unreachable is not going to answer on
    the fourth try either, and the NULL flag loses nothing by waiting.
    """
    declared = media_file.file_size_bytes
    last_error: Exception | None = None

    for _attempt in (1, 2):
        try:
            actual = head_object_size(media_file.s3_key_raw)
        except Exception as e:  # noqa: BLE001 — every boto3 failure is the same decision here
            last_error = e
            continue

        media_file.file_size_bytes = actual
        media_file.size_verified_at = datetime.now(timezone.utc)
        if actual != declared:
            # Worth a line even though it is handled: a large, consistent
            # gap is either a broken client or someone probing the quota.
            logger.warning(
                "upload size mismatch for %s: client declared %s, S3 has %s",
                media_file.s3_key_raw, declared, actual,
            )
        return

    logger.error(
        "could not verify upload size for %s after 2 attempts (%s); "
        "leaving the client-declared %s bytes unverified for backfill",
        media_file.s3_key_raw, last_error, declared,
    )


def _next_version_number(db: Session, asset_id) -> int:
    """One more than the highest number this asset has EVER used (§236).

    Over ALL rows, soft-deleted ones included. The old query filtered
    `deleted_at IS NULL`, but the unique constraint
    (`uq_asset_versions_asset_version`) spans every row there is — so
    deleting the latest version made the next upload of that asset reuse
    its number and die on the insert. Reproduced against real Postgres:
    two versions, soft-delete v2, initiate -> `duplicate key value
    violates unique constraint "uq_asset_versions_asset_version"`, i.e. a
    500 for the user.

    The numbers of deleted versions are therefore retired rather than
    recycled, which is also the better answer for a reader: "v3" in a
    comment keeps meaning the same upload after v2 is deleted.

    `max()` rather than ORDER BY ... LIMIT 1 because the number, not the
    row, is what is wanted; the index on asset_id serves both.
    """
    highest = (
        db.query(func.max(AssetVersion.version_number))
        .filter(AssetVersion.asset_id == asset_id)
        .scalar()
    )
    return int(highest or 0) + 1


def _add_next_version(db: Session, asset, current_user: User, locked: bool) -> AssetVersion:
    """Insert the next `AssetVersion` for `asset`, flushed and ready.

    `locked` says whether the caller holds `FOR UPDATE` on the asset row.
    It does for an existing asset, and the lock is what makes two
    concurrent initiates of the same asset pick different numbers.

    ── Why there is a retry at all ─────────────────────────────────────
    The lock covers this endpoint against itself, and nothing else.
    `POST /assets/{id}/versions` (routers/assets.py) computes its version
    number the same way and takes NO such lock, so an initiate here racing
    a version upload there can still collide. That endpoint is out of
    scope for §236, so this path absorbs the collision instead of
    pretending it cannot happen.

    ONE retry, and it is cheap: the collision surfaces on this `flush`,
    which happens before `create_multipart_upload` is ever called, so a
    retry costs a rollback and two small queries and can never leave an
    orphaned multipart upload behind. Only the locked path retries — on
    the unlocked one the asset row itself is new and pending in this
    transaction, where a rollback would discard it and there is no second
    writer that could collide anyway.
    """
    for attempt in (1, 2):
        version = AssetVersion(
            asset_id=asset.id,
            version_number=_next_version_number(db, asset.id),
            processing_status=ProcessingStatus.uploading,
            created_by=current_user.id,
            created_by_name=current_user.name,
        )
        db.add(version)
        try:
            db.flush()
            return version
        except IntegrityError:
            db.rollback()
            if not locked or attempt == 2:
                logger.warning(
                    "version number collision on asset %s (locked=%s, attempt %d)",
                    asset.id, locked, attempt, exc_info=True,
                )
                raise HTTPException(
                    status_code=409,
                    detail="Another upload for this file just took the next version "
                           "number. Please try again.",
                )
            # The rollback dropped the row lock, so take it again before
            # reading the highest number a second time.
            asset = (
                db.query(Asset)
                .filter(Asset.id == asset.id, Asset.deleted_at.is_(None))
                .with_for_update()
                .first()
            )
            if asset is None:
                raise HTTPException(status_code=404, detail="Asset not found")
    raise AssertionError("unreachable")


@router.post("/initiate", response_model=InitiateUploadResponse)
def initiate_upload(
    body: InitiateUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # Validate mime type
    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {body.mime_type}")

    # §213 — the part plan, decided here and sent to the client.
    #
    # FIRST, before the project lookup and before `lock_storage_prefix`
    # writes anything: a file that cannot be split into 10,000 parts must
    # leave no asset row, no version row and no multipart upload behind.
    # The old check here compared against a hand-written 2000 GB and then
    # let the client discover the real limit at part 10,001.
    #
    # 413 rather than 400: this is "your payload is too large for this
    # route", which is the status both clients can branch on without
    # reading the message.
    try:
        plan = plan_parts(body.file_size_bytes)
    except UploadTooLarge as e:
        raise HTTPException(status_code=413, detail=e.detail)

    # Verify project access (editor or above)
    project = db.query(Project).filter(Project.id == body.project_id, Project.deleted_at.is_(None)).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    require_project_role(db, body.project_id, current_user, ProjectRole.editor)
    
    # Enforce per-project storage limit if set
    if project.storage_limit_bytes is not None:
        current_storage = db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0))\
            .join(AssetVersion, MediaFile.version_id == AssetVersion.id)\
            .join(Asset, AssetVersion.asset_id == Asset.id)\
            .filter(Asset.project_id == project.id, Asset.deleted_at.is_(None))\
            .scalar()
        if current_storage + body.file_size_bytes > project.storage_limit_bytes:
            raise HTTPException(status_code=400, detail="Project storage limit exceeded")

    # Enforce platform-wide storage limit if set -- same aggregate pattern
    # as the per-project check above, just without the project_id filter.
    # Independent of per-user/per-project limits entirely (task 12);
    # reuses the site_settings singleton rather than re-querying it a
    # different way.
    site_settings = _get_or_create_settings(db)
    if site_settings.total_storage_limit_bytes is not None:
        platform_storage = db.query(func.coalesce(func.sum(MediaFile.file_size_bytes), 0))\
            .join(AssetVersion, MediaFile.version_id == AssetVersion.id)\
            .join(Asset, AssetVersion.asset_id == Asset.id)\
            .filter(Asset.deleted_at.is_(None))\
            .scalar()
        if platform_storage + body.file_size_bytes > site_settings.total_storage_limit_bytes:
            raise HTTPException(status_code=400, detail="Platform storage limit exceeded")

    # ── Freeze the project's storage prefix (§14), in its OWN transaction ──
    #
    # Placement is the whole fix for §27, and both halves of it matter.
    #
    # BEFORE the asset insert: an `INSERT INTO assets` takes a KEY SHARE
    # lock on the referenced projects row for its foreign key. A later
    # `SELECT ... FOR UPDATE` on that same row then conflicts with every
    # OTHER concurrent initiate's KEY SHARE — so two of them deadlock, each
    # holding KEY SHARE and waiting for FOR UPDATE. Reproduced against real
    # Postgres: 12 concurrent initiates to a fresh project gave 2 successes
    # and 10 `DeadlockDetected`, which is the 500 the live batch upload hit.
    #
    # COMMITTED immediately: the previous code held that row lock until the
    # end of the request, which is *after* the S3 CreateMultipartUpload
    # below. Holding a row lock across a network round-trip serialises the
    # entire batch behind one S3 latency each. Committing here drops the
    # lock in microseconds — measured 0.9s vs 5.0s for 12 files.
    #
    # Committing early is safe: nothing else is pending in this transaction
    # yet (the checks above are all reads), and a prefix locked for an
    # upload that later fails costs nothing — it is a naming decision, and
    # `lock_storage_prefix` is idempotent.
    lock_storage_prefix(db, project.id)
    db.commit()

    # Get or create asset
    if body.asset_id:
        # §236 — LOCKED, and locked BEFORE the version number is computed.
        #
        # `version_number` is picked by reading the asset's existing
        # versions, and `AssetVersion` has a unique constraint on
        # (asset_id, version_number). Two initiates for the same asset that
        # read at the same time pick the same number and one of them dies
        # on the insert with an IntegrityError — a 500 after the user has
        # chosen a file. Reproduced against real Postgres (see
        # tests/test_upload_version_numbers.py).
        #
        # A lock held across the `create_multipart_upload` round-trip below
        # is exactly what §27 warns against — but what §27 was about is the
        # PROJECT row, which every concurrent upload in a batch shares, so
        # locking it serialised the whole batch behind one S3 latency each
        # (and deadlocked against the foreign-key KEY SHARE). This lock is
        # on ONE asset. The only requests that contend for it are two new
        # versions of the same file at the same moment, which is precisely
        # the pair that must be serialised; a batch of 50 different files
        # never touches the same row, and a brand-new asset (the `else`
        # branch) takes no lock at all because nothing else can see it yet.
        asset = (
            db.query(Asset)
            .filter(Asset.id == body.asset_id, Asset.deleted_at.is_(None))
            .with_for_update()
            .first()
        )
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        if asset.project_id != body.project_id:
            raise HTTPException(status_code=400, detail="Asset does not belong to the specified project")
    else:
        asset_type = mime_to_asset_type(body.mime_type)
        # §127 — the project's default decides only the STARTING state of
        # this new file's toggle. It is read once, here, and never consulted
        # again for this asset: changing the project setting later must not
        # reach back into files that already exist.
        from ..services.transcription_defaults import default_transcription_enabled
        asset = Asset(
            project_id=body.project_id,
            name=body.asset_name,
            asset_type=asset_type,
            created_by=current_user.id,
            created_by_name=current_user.name,
            folder_id=body.folder_id,
            transcription_enabled=default_transcription_enabled(project),
        )
        db.add(asset)
        db.flush()

    # Build S3 key: raw/{project_id}/{asset_id}/{version_id}/{filename}
    version = _add_next_version(db, asset, current_user, locked=bool(body.asset_id))

    # Locked and committed above; this just reads the frozen values. The
    # commit expired the instance, so touching it refreshes from the row
    # whichever request won the race.
    ext = os.path.splitext(body.original_filename)[1].lower()
    s3_key = f"raw/{prefix_for_project(project)}/{asset.id}/{version.id}/original{ext}"

    # Initiate S3 multipart upload
    upload_id = create_multipart_upload(s3_key, body.mime_type)

    # Create MediaFile record
    file_type_map = {AssetType.image: FileType.image, AssetType.audio: FileType.audio, AssetType.video: FileType.video, AssetType.image_carousel: FileType.image}
    media_file = MediaFile(
        version_id=version.id,
        file_type=file_type_map.get(asset.asset_type, FileType.video),
        original_filename=body.original_filename,
        mime_type=body.mime_type,
        file_size_bytes=body.file_size_bytes,
        s3_key_raw=s3_key,
    )
    db.add(media_file)
    db.commit()

    return InitiateUploadResponse(
        upload_id=upload_id,
        s3_key=s3_key,
        asset_id=asset.id,
        version_id=version.id,
        part_size=plan.part_size,
        total_parts=plan.total_parts,
    )


@router.post("/presign-part", response_model=PresignPartResponse)
def presign_part(
    body: PresignPartRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.part_number < 1 or body.part_number > 10000:
        raise HTTPException(status_code=400, detail="Part number must be between 1 and 10000")

    # Verify the s3_key belongs to an upload initiated by this user
    media_file = db.query(MediaFile).filter(MediaFile.s3_key_raw == body.s3_key).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found")
    version = db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    if not version or version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    url = presign_upload_part(body.s3_key, body.upload_id, body.part_number)
    return PresignPartResponse(presigned_url=url, part_number=body.part_number)


def _authorize_upload_key(db: Session, s3_key: str, current_user: User) -> MediaFile:
    """The authorisation presign-part does, as one function (§213).

    `GET /upload/parts` must be exactly as hard to call as
    `/presign-part`: it reveals how much of a file someone else has
    uploaded, and a second, hand-written copy of this check is how one of
    the two ends up weaker than the other. Same lookups, same 404/403,
    same order.
    """
    media_file = db.query(MediaFile).filter(MediaFile.s3_key_raw == s3_key).first()
    if not media_file:
        raise HTTPException(status_code=404, detail="Upload not found")
    version = db.query(AssetVersion).filter(AssetVersion.id == media_file.version_id).first()
    if not version or version.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized for this upload")
    return media_file


@router.get("/parts", response_model=UploadedPartsResponse)
def list_uploaded_parts(
    s3_key: str = Query(...),
    upload_id: str = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """What has already arrived, so a resumed upload sends only the rest (§213).

    THE SERVER'S LIST IS THE SOURCE OF TRUTH, deliberately — not a
    client-side record of which parts it believes it sent. A client's own
    log can only ever be a claim about a request it made; this is the
    store's answer about bytes it holds, including parts that landed from
    a process that then died before it could write anything down.

    A guessed `upload_id` lists nothing: the authorisation above is on the
    s3_key's own MediaFile and its version's creator, so an upload_id that
    does not belong to that key simply is not found at the store and comes
    back as a gone session rather than as somebody else's parts.
    """
    _authorize_upload_key(db, s3_key, current_user)
    try:
        parts = list_multipart_parts(s3_key, upload_id)
    except NoSuchUploadError:
        # A STABLE, MACHINE-READABLE CODE. Both clients branch on this to
        # start a fresh upload rather than failing, and branching on
        # prose ("NoSuchUpload" appearing in a message) is how that breaks
        # the first time the wording changes.
        raise HTTPException(
            status_code=404,
            detail={
                "code": "no_such_upload",
                "message": "That upload session no longer exists. Start a new upload for this file.",
            },
        )
    return UploadedPartsResponse(parts=parts)


def _error(code: str, message: str) -> dict:
    """An `UploadErrorDetail` as a `detail=` dict (§236)."""
    return UploadErrorDetail(code=code, message=message).model_dump(exclude_none=True)


#: The two answers that say "this upload session is gone, start over". Both
#: clients already branch on this exact code from `GET /upload/parts`.
_GONE = _error(
    "no_such_upload",
    "That upload session no longer exists. Start a new upload for this file.",
)


def _assembled_at_store(s3_key: str, declared_bytes: int, version_id) -> bool | None:
    """Is the finished object already sitting at this key, at the right size?

    THREE answers, and the third one is the point:

    * ``True``  — an object of exactly `declared_bytes` is at the key, so
      `CompleteMultipartUpload` already succeeded and only the database
      commit was lost. The caller carries on to the DB transition.
    * ``False`` — the store answered, and there is nothing there (or
      something of the wrong length). The upload really is gone.
    * ``None``  — the store could not be asked. NOT evidence of absence.
      Every caller's `False` branch tells a client to start a fresh upload,
      and for a 100 GB master that has in fact completed, a timed-out HEAD
      must not be what throws it away.

    Size, not ETag: a completed multipart object's ETag is a composite
    whose exact form is not guaranteed across S3 implementations, while
    ContentLength is.

    THE KEY IS THE VERSION'S OWN, never `body.s3_key` — the caller has
    already bound the two. A HEAD against a client-chosen key would let a
    caller point this proof at any object it liked and have a short upload
    declared complete.
    """
    try:
        actual = head_object_size(s3_key)
    except ClientError as e:
        if is_upload_gone(e):
            return False
        logger.warning(
            "could not check whether upload %s already completed at %s",
            version_id, s3_key, exc_info=True,
        )
        return None
    except BotoCoreError:
        # Never reached the store at all: EndpointConnectionError,
        # ConnectTimeoutError, ReadTimeoutError.
        logger.warning(
            "could not reach storage to check upload %s at %s",
            version_id, s3_key, exc_info=True,
        )
        return None
    return int(actual) == int(declared_bytes)


@router.post("/complete", response_model=CompleteUploadResponse)
def complete_upload(
    body: CompleteUploadRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Assemble the parts the STORE holds into the object (§236).

    Four things changed here, and each of them was a way for this endpoint
    to do the wrong thing with a body it trusted.

    ── 1. The part list is the store's ─────────────────────────────────
    It used to be the client's, passed straight through. S3 checks that
    each ETag a client names belongs to a part it holds; it does NOT check
    that the list is the whole file. A client that omitted a part — a bug,
    a lost response, a resume that skipped one — got a 200 and an object
    assembled from the parts it named. §180 then overwrote
    `file_size_bytes` with the truncated length and the transcoder
    produced a perfectly good rendition of a half file. Verified against
    this code: the short list reached `complete_multipart_upload`
    unchanged, the store was never consulted, and the row ended up at the
    truncated size with status `processing`.

    `strict=True` on the listing, never the lenient default: for the
    resume path a short list costs a client some re-sent parts, but HERE a
    short list would mean completing a short FILE. See
    `list_multipart_parts`' own docstring — the mode belongs to the
    caller because what a short answer costs depends entirely on what the
    caller does with it.

    ── 2. The body's ids are checked against the version's ─────────────
    Authorisation proved the caller owns `version_id`. It proved nothing
    about `body.asset_id` or `body.s3_key`, which were used anyway:
    `_trigger_processing(body.asset_id, ...)` dispatched the transcode at
    whatever asset the body named, and `process_asset` derives its output
    prefix and its event-stream project from that id. So one editor could
    have their version's renditions written under another project's prefix
    and their version id pushed onto that project's event stream. Both ids
    are now bound to the version, and the dispatch reads the VERSION's
    values rather than relying on the check.

    ── 3. There is a state machine, under a row lock ───────────────────
    The desktop client retries /complete indefinitely by design
    (`apps/desktop/src/main/freeframe.js`), so a lost response means a
    second call against an upload the store has already consumed: an
    unhandled `ClientError` and a 500 for an upload that SUCCEEDED. Now
    `processing`/`ready` is an idempotent 200 that dispatches nothing, and
    `failed` is a 409 the client can show. The `SELECT ... FOR UPDATE` is
    what makes two simultaneous completes dispatch exactly one transcode
    rather than two — the check and the transition are one critical
    section. It locks ONE version row, which only a duplicate of this very
    request contends for, so it serialises nothing that should run in
    parallel.

    ── 4. A completion that happened at the store but was never recorded ─
    `CompleteMultipartUpload` can succeed with the process dying before
    the commit. The upload id is then consumed and the version still reads
    `uploading`. One HEAD of the version's OWN key settles it: an object
    of exactly the declared size means the work is done, and the only
    thing left is the transition. §215's sweeper reaches the same
    conclusion from the other side — it refuses to fail a ghost row whose
    object exists, because "the upload completed at the store and the
    commit was lost" needs a person. After this change the client's own
    retry is that person.
    """
    # §236 — LOCKED. The status check and the status write have to be one
    # critical section, or two concurrent completes both read `uploading`
    # and both dispatch a transcode for the same version.
    version = (
        db.query(AssetVersion)
        .filter(
            AssetVersion.id == body.version_id,
            AssetVersion.deleted_at.is_(None),
        )
        .with_for_update()
        .first()
    )
    if not version:
        # §236 — "Upload not found", the same words a request whose key or
        # asset id does not belong to this version gets below. An unknown
        # version and a mismatched body must be indistinguishable, or this
        # endpoint answers "which of these ids is the real one".
        raise HTTPException(status_code=404, detail="Upload not found")
    if version.created_by != current_user.id:
        # 403 as before, deliberately: this one DOES say the version
        # exists, and it has to — the two clients and §213's
        # `_authorize_upload_key` already draw that line the same way, and
        # collapsing it would mean an owner's own typo reads as a
        # permission problem.
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()

    # §236 — the body's own copies of the key and the asset id, checked
    # against the version that was actually authorised.
    #
    # ONE answer for all three failures, and it is the SAME message an
    # unknown version gets: "Upload not found". A distinct message per
    # cause would turn this endpoint into an oracle — "wrong asset" tells
    # the caller the asset exists, "wrong key" tells it the key does not
    # belong here — and no client needs to tell them apart.
    if (
        media_file is None
        or media_file.s3_key_raw != body.s3_key
        or body.asset_id != version.asset_id
    ):
        logger.warning(
            "upload completion refused for version %s (user %s): "
            "key_matches=%s asset_matches=%s",
            version.id, current_user.id,
            media_file is not None and media_file.s3_key_raw == body.s3_key,
            body.asset_id == version.asset_id,
        )
        raise HTTPException(status_code=404, detail="Upload not found")

    s3_key = media_file.s3_key_raw
    declared = int(media_file.file_size_bytes or 0)

    def _finish() -> CompleteUploadResponse:
        """The transition, with the SERVER's values throughout."""
        # §180 — the object exists now, so its size is knowable. Done
        # BEFORE the commit below, in the same transaction that marks the
        # version as processing: the row becomes final and reconciled in
        # one step, so no quota check can ever read a committed-but-
        # unreconciled number. Every reader of this column (the two checks
        # in initiate_upload above, site_settings' platform total,
        # projects' per-project totals) is a live SQL SUM computed per
        # request, so they all pick this up from here on.
        _reconcile_file_size(media_file)

        version.processing_status = ProcessingStatus.processing
        # §219 — DISPATCHED, not started. `processing` here means "queued":
        # the Celery task below may wait hours behind other transcodes, and
        # nothing touches this row while it does. NULL is what tells the
        # stuck-processing sweeper not to apply its 45-minute silence rule
        # to a file that is merely waiting its turn. Only process_asset
        # fills it in.
        version.processing_started_at = None
        # Commits the status AND releases the row lock, so a duplicate
        # /complete waiting on it reads `processing` and dispatches nothing.
        db.commit()

        # §236 — the VERSION's ids, not the body's. With the check above in
        # place these are equal, which is the point: the dispatch is
        # correct on its own rather than by way of a check somewhere else.
        background_tasks.add_task(_trigger_processing, version.asset_id, version.id)
        # §217 — and the CRC-32 the streamed batch download needs. After
        # the commit, so the size it is checked against is the reconciled
        # one.
        if media_file.s3_key_raw:
            background_tasks.add_task(
                _trigger_crc, media_file.s3_key_raw, media_file.file_size_bytes
            )
        return CompleteUploadResponse(
            status=ProcessingStatus.processing.value,
            asset_id=version.asset_id,
            version_id=version.id,
        )

    # ── the state machine ───────────────────────────────────────────────
    status_now = version.processing_status
    if status_now in (ProcessingStatus.processing, ProcessingStatus.ready):
        # IDEMPOTENT, and nothing is dispatched. The first call already did
        # the work; this is its retry arriving after a lost response. The
        # version's OWN status is reported rather than a hardcoded
        # "processing", so one that has since gone `ready` does not read as
        # still transcoding.
        logger.info(
            "upload %s completed again after it had already finished; "
            "reporting %s and dispatching nothing",
            version.id, status_now.value,
        )
        return CompleteUploadResponse(
            status=status_now.value,
            asset_id=version.asset_id,
            version_id=version.id,
        )
    if status_now != ProcessingStatus.uploading:
        # `failed` — which is what §215's sweeper writes when it decides an
        # upload was abandoned, and what /upload/abort writes on a cancel.
        # An object happening to sit at the key does not override that:
        # somebody or something resolved this version as broken, and
        # quietly completing it would paper over the disagreement instead
        # of surfacing it. A new upload is the way back.
        raise HTTPException(
            status_code=409,
            detail=_error(
                "upload_failed",
                "This upload was already marked failed. Start a new upload for "
                "this file.",
            ),
        )

    # ── the part list, from the store ───────────────────────────────────
    already_assembled = False
    try:
        stored = list_multipart_parts(s3_key, body.upload_id, strict=True)
    except NoSuchUploadError:
        assembled = _assembled_at_store(s3_key, declared, version.id)
        if assembled is None:
            raise HTTPException(
                status_code=502,
                detail=_error(
                    "storage_unavailable",
                    "Could not reach storage to finish this upload. Please retry.",
                ),
                headers={"Retry-After": "5"},
            )
        if not assembled:
            raise HTTPException(status_code=404, detail=_GONE)
        logger.warning(
            "upload %s was already assembled at %s (%d bytes) but never recorded; "
            "completing the database side only", version.id, s3_key, declared,
        )
        stored = []
        already_assembled = True
    except IncompleteListingError:
        # §215a — the listing could not be walked to the end, so "these are
        # the parts" is not something this code is in a position to say.
        # Completing from a possibly short list is the truncation this
        # whole endpoint was changed to prevent, so it refuses instead. The
        # upload is left OPEN and untouched: nothing is lost, and the next
        # attempt may well page cleanly.
        logger.error(
            "could not list the parts of upload %s at %s to completion; "
            "refusing to complete from a possibly short list",
            version.id, s3_key, exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail=_error(
                "parts_unverifiable",
                "Storage could not list this upload's parts in full, so it cannot "
                "be completed safely. Please retry.",
            ),
            headers={"Retry-After": "5"},
        )
    except (ClientError, BotoCoreError):
        logger.warning(
            "could not list the parts of upload %s at %s", version.id, s3_key,
            exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail=_error(
                "storage_unavailable",
                "Could not reach storage to finish this upload. Please retry.",
            ),
            headers={"Retry-After": "5"},
        )

    if not already_assembled:
        # Observation only — nothing branches on the client's list.
        note_client_disagreement(body.parts, stored, version.id, s3_key)

        try:
            parts = parts_for_completion(stored, declared)
        except PartsIncomplete as e:
            # 409, and the upload is LEFT OPEN: not aborted, status not
            # changed, nothing dispatched. The person has just spent
            # minutes or hours moving these bytes, and the parts that did
            # arrive are what a resume is built on — so the answer names
            # what is missing and lets the client send the rest.
            logger.warning(
                "refusing to complete upload %s (user %s, key %s): %s",
                version.id, current_user.id, s3_key, e.log_note,
            )
            raise HTTPException(status_code=409, detail=e.detail)

        try:
            complete_multipart_upload(s3_key, body.upload_id, parts)
        except ClientError as e:
            code = error_code_of(e)
            if is_upload_gone(e):
                # The same race as above, one step later: something else
                # completed this upload between the listing and this call.
                assembled = _assembled_at_store(s3_key, declared, version.id)
                if assembled is None:
                    raise HTTPException(
                        status_code=502,
                        detail=_error(
                            "storage_unavailable",
                            "Could not reach storage to finish this upload. Please "
                            "retry.",
                        ),
                        headers={"Retry-After": "5"},
                    )
                if not assembled:
                    raise HTTPException(status_code=404, detail=_GONE)
            elif code in PART_REFUSAL_CODES:
                # The store looked at the list and refused it — a part's
                # ETag no longer matches, a part is under the 5 MiB
                # minimum, the order is wrong. Retrying the identical
                # request cannot help, so 409 rather than 502; the upload
                # stays open so the offending part can be re-sent.
                logger.warning(
                    "storage refused the part list for upload %s at %s: %s",
                    version.id, s3_key, code, exc_info=True,
                )
                raise HTTPException(
                    status_code=409,
                    detail=_error(
                        "parts_rejected",
                        "Storage refused this upload's parts "
                        f"({code}). Send the file's parts again, then complete it.",
                    ),
                )
            else:
                # A timeout, a 503, an AccessDenied: no verdict on the
                # upload, which stays open and resumable. Never a bare 500
                # with a stack — both clients read the status.
                logger.warning(
                    "completing upload %s at %s failed: %s", version.id, s3_key, code,
                    exc_info=True,
                )
                raise HTTPException(
                    status_code=502,
                    detail=_error(
                        "storage_error",
                        "Storage could not finish this upload. Please retry.",
                    ),
                    headers={"Retry-After": "5"},
                )
        except BotoCoreError:
            logger.warning(
                "could not reach storage to complete upload %s at %s",
                version.id, s3_key, exc_info=True,
            )
            raise HTTPException(
                status_code=502,
                detail=_error(
                    "storage_unavailable",
                    "Could not reach storage to finish this upload. Please retry.",
                ),
                headers={"Retry-After": "5"},
            )

    return _finish()


def _trigger_processing(asset_id: uuid.UUID, version_id: uuid.UUID):
    """Dispatch Celery task to process the uploaded asset."""
    from ..tasks.transcode_tasks import process_asset
    from ..tasks.celery_app import send_task_safe
    send_task_safe(process_asset, str(asset_id), str(version_id))


def _trigger_crc(s3_key: str, size: int):
    """Ask for this object's CRC-32 now, so a download never waits for it (§217).

    A streamed batch download cannot answer a single `Range` request until
    it knows the CRC of every file in it (services/zip_stream.py), and
    reading a 105 GB original takes minutes. Doing it HERE — once, right
    after the bytes land and while nothing is waiting — is what makes the
    common case instant: by the time anyone asks for a batch download, the
    answer is already in `object_checksums`.

    A background task rather than inline, and dispatched after the commit,
    for the same reason the transcode is: the person who just finished a
    multi-hour upload is waiting on this response.

    Lazy computation still exists and still matters — it covers everything
    uploaded before §217 and anything whose dispatch was lost — so a
    failure here costs a slower first download, never a broken one.
    """
    from ..tasks.celery_app import send_task_safe
    from ..tasks.crc_tasks import compute_object_crc32
    send_task_safe(compute_object_crc32, s3_key, int(size or 0))


@router.post("/abort", status_code=status.HTTP_204_NO_CONTENT)
def abort_upload(
    body: AbortUploadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Throw away an upload that is still in progress (§236).

    This endpoint means ONE thing in both clients: the user cancelled, or
    discarded an interrupted session (`cancelUpload` / `discardInterrupted`
    in `apps/web/stores/upload-store.ts`, `disposeUpload("cancel")` in the
    desktop app). Neither of them calls it from a completion failure any
    more — §213 made a failed upload stay resumable — which is why a
    cancel can safely be taken at its word here.

    What it must not do is act on a version that is no longer in progress.
    It had no state check at all: a `processing` or `ready` version was
    flipped to `failed` and an S3 abort was fired at whatever
    `body.s3_key` said, for an upload the store had already consumed.
    Reproduced against this code: a `ready` version, an arbitrary key, a
    204 back, `AbortMultipartUpload` called with the client's key, and a
    good version left reading `failed` — which is the status §114's reaper
    deletes the stored object for.

    So: `uploading` is the only state that may be aborted, the key is the
    version's own, a store that has already forgotten the upload is
    treated as already gone, and `failed` answers 204 because a cancel
    repeated is still a cancel.

    `processing`/`ready` get a 409 and NOTHING is touched — not the row,
    not the store. The deliberate difference from upstream, which treats
    an abort of an assembled upload as a completion and dispatches a
    transcode: upstream's client fires abort from every completion
    failure, so it had to guess what the caller meant. Ours only ever
    sends it for a cancel, so a 409 is the honest answer and there is
    nothing to guess.
    """
    # Locked for the same reason /complete is: the state check and the
    # status write must not straddle another request's transition.
    version = (
        db.query(AssetVersion)
        .filter(
            AssetVersion.id == body.version_id,
            AssetVersion.deleted_at.is_(None),
        )
        .with_for_update()
        .first()
    )
    if not version:
        # §236 — "Upload not found", the same words a request whose key does
        # not belong to this version gets below. An unknown
        # version and a mismatched body must be indistinguishable, or this
        # endpoint answers "which of these ids is the real one".
        raise HTTPException(status_code=404, detail="Upload not found")
    if version.created_by != current_user.id:
        # 403 as before, deliberately: this one DOES say the version
        # exists, and it has to — the two clients and §213's
        # `_authorize_upload_key` already draw that line the same way, and
        # collapsing it would mean an owner's own typo reads as a
        # permission problem.
        raise HTTPException(status_code=403, detail="Not authorized for this upload")

    media_file = db.query(MediaFile).filter(MediaFile.version_id == version.id).first()
    # §236 — the key is bound to the version, exactly as in /complete, and
    # with the same single message: ownership was proved for the version,
    # never for whatever key the body carried.
    if media_file is None or media_file.s3_key_raw != body.s3_key:
        logger.warning(
            "upload abort refused for version %s (user %s): the key in the request "
            "is not this version's", version.id, current_user.id,
        )
        raise HTTPException(status_code=404, detail="Upload not found")

    status_now = version.processing_status
    if status_now == ProcessingStatus.failed:
        # Idempotent. A second cancel, or a cancel of something §215's
        # sweeper already reaped, has nothing left to do and is not an
        # error. The store side is idempotent too — AbortMultipartUpload on
        # a gone upload is handled below — so there is nothing to repeat.
        return
    if status_now != ProcessingStatus.uploading:
        raise HTTPException(
            status_code=409,
            detail=_error(
                "upload_not_abortable",
                f"This upload is already {status_now.value} and cannot be "
                "cancelled.",
            ),
        )

    try:
        abort_multipart_upload(media_file.s3_key_raw, body.upload_id)
    except ClientError as e:
        if not is_upload_gone(e):
            # The parts are still in the bucket. Reporting success would
            # hide that, and failing the row would hide it behind a
            # terminal status — so say nothing happened and let the caller
            # (or §215) try again.
            logger.warning(
                "could not abort upload %s at %s: %s",
                version.id, media_file.s3_key_raw, error_code_of(e), exc_info=True,
            )
            raise HTTPException(
                status_code=502,
                detail=_error(
                    "storage_error",
                    "Storage could not cancel this upload. Please retry.",
                ),
                headers={"Retry-After": "5"},
            )
        # Already gone at the store — nothing to free. The ROW still has to
        # be resolved: it is the thing that says `uploading`, and leaving it
        # there is what §215's ghost pass exists to clean up.
        logger.info(
            "upload %s was already gone at the store when it was cancelled",
            version.id,
        )
    except BotoCoreError:
        logger.warning(
            "could not reach storage to abort upload %s at %s",
            version.id, media_file.s3_key_raw, exc_info=True,
        )
        raise HTTPException(
            status_code=502,
            detail=_error(
                "storage_unavailable",
                "Could not reach storage to cancel this upload. Please retry.",
            ),
            headers={"Retry-After": "5"},
        )

    version.processing_status = ProcessingStatus.failed
    db.commit()
