"""Read each stored object once, through zlib.crc32 (§217).

The one thing a streamed zip is not given for free. A `ZIP_STORED` entry's
local header carries its CRC-32 and the central directory at the END needs
it for every entry, so the archive's byte layout — and therefore any answer
to a `Range` request — is undefined until every file's CRC is known. See
services/zip_stream.py for why the data-descriptor trick cannot substitute
for it in a resumable stream.

── Where these run, and why it is `transcoding` ─────────────────────────

`transcoding` is consumed by the `worker` container at concurrency 2, which
is also the transcoder. A CRC pass over a 105 GB original is minutes of
pure I/O, so putting it there unguarded would let two of them hold both
slots and stall the HLS ladder behind them.

The three options were: a new queue consumed by `transcribe_worker`, a new
tiny worker service, or this queue with a hard concurrency cap. This is the
third, and the deciding argument is the repo's own history rather than
elegance: `apply_watermark` (§126), four zip tasks (§143) and
`purge_expired_trash` (§182) each reached production routed onto a queue no
container consumed, and each silently never ran — for months. A new queue
needs a new container in `docker-compose.prod.yml` and a change to the
six-service rebuild rule in CLAUDE.md; if either is missed on the deploy,
every CRC job vanishes into an unconsumed queue and the only symptom is
exports that say `preparing` forever. Sharing `transcribe_worker`'s queue
has the same problem in milder form (its `-Q` list changes, so that
container must be recreated) plus a worse one: concurrency there is 1, so a
40-minute CRC would block transcription outright.

So: `transcoding`, with `_lease` below capping CRC work at
`settings.crc_max_concurrent` (1) across the whole fleet. One transcode
slot therefore always remains free, and the DEPLOY CONSEQUENCE is the
smallest available — no compose change at all, just the `worker` restart
that every deploy already performs.

── Surviving a long run ────────────────────────────────────────────────

`task_acks_late=True` plus a 12 h Redis `visibility_timeout` (§219) means a
task stays unacked for its whole run and is redelivered if it outlives
that. Both are handled: the lease is short and refreshed (so a killed
worker frees it in minutes rather than hours), and the task is idempotent —
a second delivery finds the CRC already verified and returns immediately.
The time limits below sit far under 12 h, so a genuinely wedged read is
killed by Celery before the broker can double-deliver it.
"""
import logging
import threading
import time
import uuid
import zlib
from datetime import datetime, timezone

from celery.exceptions import SoftTimeLimitExceeded

from ..config import settings
from ..database import SessionLocal
from ..models.asset import MediaFile
from ..services import checksum_service, s3_service
from ..services.redis_service import get_redis
from .celery_app import celery_app

logger = logging.getLogger(__name__)

#: Redis key holding the one CRC lease. A fixed key rather than a counting
#: semaphore because the cap is 1: `SET NX` is atomic, needs no Lua, and
#: cannot leak a slot the way an INCR/DECR pair can when the DECR never
#: runs. If `crc_max_concurrent` is ever raised above 1, the slots are
#: numbered and each is its own key — see `_lease`.
LEASE_KEY = "crc32_lease"

#: Ceilings for one object. Ordered the same way build_zip_export's are:
#: soft < hard < the broker's visibility_timeout (43200s, §219), so Celery
#: always resolves a wedged read before Redis can hand the same message to
#: a second worker.
#:
#: Four hours is deliberately generous rather than tight: the owner's
#: largest original is 105 GB, which at four hours is 7.3 MB/s of sustained
#: LAN read — an order of magnitude below what AIStor does on this box. It
#: is a ceiling on a HUNG read, not a budget for a slow one.
CRC_SOFT_TIME_LIMIT = 4 * 60 * 60
CRC_HARD_TIME_LIMIT = CRC_SOFT_TIME_LIMIT + 5 * 60


class _LeaseUnavailable(Exception):
    """Another worker holds the CRC lease."""


class _lease:
    """Hold the single CRC slot, refreshing it for as long as the read runs.

    A context manager rather than a decorator so the `except` around the
    read can tell "could not get the slot" (requeue, cost nothing) from
    "the read failed" (record the failure) — two outcomes that must not
    share a handler.

    The lease has a TTL and is refreshed by a daemon thread. That pairing is
    the point: a worker SIGKILLed mid-read, which every deploy does, cannot
    run any cleanup, so a lease it holds has to expire by itself. A long
    un-refreshed TTL would block the next CRC job for hours; a short one
    with no refresh would release the slot while the read was still going.
    """

    def __init__(self, label: str):
        self.label = label
        self._token = uuid.uuid4().hex
        self._stop = threading.Event()
        self._thread = None
        self._slot = None

    def __enter__(self):
        r = get_redis()
        for slot in range(max(1, settings.crc_max_concurrent)):
            key = f"{LEASE_KEY}:{slot}"
            if r.set(key, self._token, nx=True, ex=settings.crc_lease_seconds):
                self._slot = key
                break
        if self._slot is None:
            raise _LeaseUnavailable(
                f"all {settings.crc_max_concurrent} CRC slot(s) are busy"
            )
        self._thread = threading.Thread(target=self._refresh, daemon=True)
        self._thread.start()
        return self

    def _refresh(self):
        r = get_redis()
        while not self._stop.wait(settings.crc_lease_refresh_seconds):
            try:
                # Only extend a lease we still own. If it expired and
                # someone else took the slot, extending it would give two
                # readers the same slot — rarer than the bug it prevents,
                # but exactly the kind that only shows up under load.
                if r.get(self._slot) == self._token:
                    r.expire(self._slot, settings.crc_lease_seconds)
                else:
                    logger.warning(
                        "crc lease %s for %s was taken by someone else",
                        self._slot, self.label,
                    )
                    return
            except Exception:
                # Losing a refresh must not fail the read it is only
                # protecting; the worst case is the lease expiring and a
                # second CRC job starting, which is slow, not wrong.
                logger.warning("could not refresh the crc lease", exc_info=True)

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        try:
            r = get_redis()
            if r.get(self._slot) == self._token:
                r.delete(self._slot)
        except Exception:
            logger.warning("could not release the crc lease", exc_info=True)
        return False


def crc32_of_body(body, *, chunk_bytes: int) -> tuple[int, int]:
    """Stream a boto3 body through `zlib.crc32`. Returns (crc, bytes_read).

    Never loads the object into memory: an 8 MiB window over a 105 GB
    original. Pure apart from the read, and separated out so a test can
    drive it with a fake body whose chunking it controls — the chunk size
    must not change the answer, which is the one property a CRC
    implementation can get wrong invisibly.
    """
    crc = 0
    total = 0
    while True:
        chunk = body.read(chunk_bytes)
        if not chunk:
            break
        crc = zlib.crc32(chunk, crc)
        total += len(chunk)
    return crc & 0xFFFFFFFF, total


@celery_app.task(
    bind=True,
    max_retries=2,
    default_retry_delay=120,
    name="compute_object_crc32",
    soft_time_limit=CRC_SOFT_TIME_LIMIT,
    time_limit=CRC_HARD_TIME_LIMIT,
)
def compute_object_crc32(self, s3_key: str, expected_size: int = 0):
    """Read one object and store its CRC-32. Idempotent.

    `expected_size` is what the caller believed the object to be (0 when
    nothing did). It is passed through to `record_checksum`, which refuses
    to write a CRC that disagrees with it OR with the live ContentLength —
    so a partially read or replaced object stores nothing rather than a
    plausible wrong answer.

    Returns a short string for the logs; nothing reads the return value.
    """
    if not s3_key:
        return "no key"

    db = SessionLocal()
    try:
        existing = checksum_service.get_checksum(db, s3_key)
        if checksum_service.is_verified(existing):
            # The idempotency guard, and the reason a redelivered message
            # after the 12 h visibility timeout is harmless.
            return "already verified"
        if checksum_service.has_given_up(existing):
            return "given up"

        try:
            with _lease(s3_key):
                checksum_service.begin_attempt(db, s3_key)
                return _read_and_store(db, s3_key, expected_size)
        except _LeaseUnavailable:
            # Not a failure: the work is still wanted, just not now. Retried
            # rather than dropped, and it does NOT consume an attempt —
            # `begin_attempt` is inside the lease for exactly that reason.
            logger.info("crc for %s deferred: %s", s3_key, "slot busy")
            raise self.retry(countdown=settings.crc_lease_refresh_seconds, max_retries=None)
    finally:
        db.close()


def _read_and_store(db, s3_key: str, expected_size: int) -> str:
    client = s3_service.get_s3_client()
    try:
        obj = client.get_object(Bucket=settings.s3_bucket, Key=s3_key)
    except Exception as exc:
        # A missing object is the common case worth naming: an asset deleted
        # between the export request and the read. It marks THIS entry
        # failed and nothing else — the other ninety-nine files in the
        # selection still get their CRCs and the export still becomes
        # servable, exactly as the build path skipped a member it could not
        # read.
        checksum_service.mark_attempt_failed(db, s3_key, f"could not open: {exc}")
        logger.warning("crc for %s: could not open the object (%s)", s3_key, exc)
        return "unreadable"

    body = obj["Body"]
    content_length = obj.get("ContentLength")
    try:
        crc, read = crc32_of_body(body, chunk_bytes=settings.crc_chunk_bytes)
    except SoftTimeLimitExceeded:
        # Deliberately NOT recorded as a per-object failure and NOT
        # retried here: the read had its full budget. The attempt counter
        # was already bumped, so `crc_max_attempts` still bounds it.
        checksum_service.mark_attempt_failed(db, s3_key, "read exceeded its time limit")
        logger.error("crc for %s exceeded its time limit", s3_key)
        raise
    except Exception as exc:
        checksum_service.mark_attempt_failed(db, s3_key, f"read failed: {exc}")
        logger.warning("crc for %s: read failed (%s)", s3_key, exc)
        return "read failed"
    finally:
        # The S3 connection goes back to the pool whatever happened. A
        # leaked body is a socket held for the life of the worker.
        try:
            body.close()
        except Exception:
            pass

    try:
        checksum_service.record_checksum(
            db,
            s3_key,
            crc32=crc,
            bytes_read=read,
            content_length=content_length,
            expected_size=expected_size or None,
        )
    except checksum_service.ChecksumSizeMismatch as exc:
        # The rule that matters most in this file: a CRC of the wrong number
        # of bytes is well-formed and wrong, and a zip carrying it extracts
        # to a file every extractor rejects — after the whole thing has been
        # downloaded.
        checksum_service.mark_attempt_failed(db, s3_key, str(exc))
        logger.error("crc for %s refused: %s", s3_key, exc)
        return "size mismatch"

    logger.info("crc for %s: %08x over %s bytes", s3_key, crc, read)
    return "verified"


@celery_app.task(bind=True, name="backfill_object_crc32")
def backfill_object_crc32(self, cursor: str = ""):
    """Give every already-uploaded object a CRC, slowly and resumably.

    THE MIGRATION DOES NOT BACKFILL. The owner's library already holds
    hundreds of GB with no CRC, and reading it inside a migration would be
    a deploy that appears to hang for hours with the api not yet started.
    Start this by hand instead, once:

        docker compose -f docker-compose.prod.yml --env-file .env.prod \\
          -p freeframe exec worker \\
          celery -A apps.api.tasks.celery_app call backfill_object_crc32

    It walks `media_files` by id, takes the first
    `crc_backfill_objects_per_run` objects that still need reading, does
    them one at a time, and re-queues itself after
    `crc_backfill_pause_seconds`. So one invocation drains the whole
    library at a rate the transcoder can live with, and there is nothing to
    remember to run again.

    Resumable by construction rather than by bookkeeping: the cursor is
    just "the last media_file id looked at", and anything already verified
    is skipped on sight — so a deploy in the middle costs at most the
    object being read, a crash costs nothing, and starting it twice is
    harmless. `crc_backfill_enabled=False` stops it at the next hop.
    """
    if not settings.crc_backfill_enabled:
        logger.warning("crc backfill is disabled; stopping")
        return {"stopped": "disabled"}

    db = SessionLocal()
    done = 0
    scanned = 0
    last_id = cursor or ""
    try:
        query = db.query(MediaFile).order_by(MediaFile.id)
        if cursor:
            query = query.filter(MediaFile.id > uuid.UUID(cursor))

        wanted = max(1, settings.crc_backfill_objects_per_run)
        # Read rows in modest pages rather than all of them: this runs on a
        # worker that is also encoding, and `media_files` is the biggest
        # table in the schema.
        for media_file in query.yield_per(200):
            scanned += 1
            last_id = str(media_file.id)
            keys = checksum_service.downloadable_keys_for_media_file(media_file)
            # `file_size_bytes` describes the RAW upload only, so it is
            # passed as the expected size for that key and for nothing else.
            # Handing it to a proxy's read would make `record_checksum`
            # refuse a perfectly good CRC.
            raw_key = media_file.s3_key_raw or media_file.s3_key_processed
            for key in checksum_service.needs_checksum(db, keys):
                expected = (
                    int(media_file.file_size_bytes or 0) if key == raw_key else 0
                )
                compute_object_crc32.apply_async(args=[key, expected])
                done += 1
                if done >= wanted:
                    break
            if done >= wanted:
                break
    except Exception:
        logger.exception("crc backfill failed while scanning; it will resume")
        return {"error": True, "cursor": cursor}
    finally:
        db.close()

    if done == 0 and scanned == 0:
        logger.warning("crc backfill finished: nothing left to read")
        return {"done": 0, "finished": True}

    # Re-queue, from where this run stopped. `apply_async` with a countdown
    # rather than a beat entry: this is a one-off drain the owner starts
    # deliberately, and a scheduled copy of it would keep re-scanning the
    # whole table forever after it had finished.
    backfill_object_crc32.apply_async(
        args=[last_id if done >= max(1, settings.crc_backfill_objects_per_run) else ""],
        countdown=settings.crc_backfill_pause_seconds,
    )
    logger.warning(
        "crc backfill: queued %s object(s) after scanning %s media file(s); "
        "continuing from %s in %ss",
        done, scanned, last_id or "the start", settings.crc_backfill_pause_seconds,
    )
    return {"done": done, "scanned": scanned, "cursor": last_id}
