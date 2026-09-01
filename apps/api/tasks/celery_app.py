from celery import Celery
from celery.schedules import crontab
from kombu import Queue
from kombu.exceptions import OperationalError

try:
    from ..config import settings
except ImportError:
    from config import settings

celery_app = Celery(
    "freeframe",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "apps.api.tasks.transcode_tasks",
        "apps.api.tasks.transcribe_tasks",
        "apps.api.tasks.lut_tasks",
        "apps.api.tasks.watermark_tasks",
        "apps.api.tasks.reminder_tasks",
        "apps.api.tasks.email_tasks",
        "apps.api.tasks.purge_tasks",
        "apps.api.tasks.cleanup_tasks",
    ],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    broker_connection_retry_on_startup=True,
    broker_connection_retry=True,
    broker_connection_max_retries=5,
    broker_pool_limit=0,  # Disable connection pooling in web process to avoid stale connections
    # §114 — a task is acked when it FINISHES, not when it is received.
    #
    # Celery's default acks a task the moment a worker picks it up. Every
    # deploy runs `up -d --build`, which SIGTERM/SIGKILLs the worker, so a
    # transcode in flight was already acked and simply vanished: nothing
    # requeued it, and because the process was killed rather than raising,
    # the except/finally that would have marked the version `failed` never
    # ran either. The row sat at `processing` forever with no error anywhere.
    # Traced live against production — `inspect active` and `inspect
    # reserved` were both empty on all three nodes while a row claimed to be
    # processing.
    #
    # reject_on_worker_lost completes the pair: without it a task whose
    # worker dies is marked failed rather than redelivered.
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    # With acks_late, prefetched-but-unstarted tasks are also redelivered on
    # a restart. Fetching one at a time keeps that set to the task actually
    # running, and matters more here than throughput: these are minutes-long
    # ffmpeg jobs, not a high-rate queue where prefetch earns anything.
    worker_prefetch_multiplier=1,
    # Define queues
    task_queues=(
        Queue("default"),
        Queue("transcoding"),
        # Own queue + own worker container: a single CPU Whisper pass runs
        # for minutes and would otherwise block HLS jobs behind it, since
        # Celery concurrency is per-process, not per-queue-within-a-process.
        Queue("transcription"),
        Queue("email_high"),  # Magic codes, invites - immediate
        Queue("email_low"),   # Mentions, comments - can be delayed
    ),
    task_default_queue="default",
    # Route tasks to queues
    task_routes={
        "apps.api.tasks.transcode_tasks.*": {"queue": "transcoding"},
        "apps.api.tasks.transcribe_tasks.*": {"queue": "transcription"},
        # Same ffmpeg/CPU profile as a normal transcode -- shares the
        # existing worker rather than needing its own.
        "apps.api.tasks.lut_tasks.*": {"queue": "transcoding"},
        "apps.api.tasks.email_tasks.send_magic_code_email": {"queue": "email_high"},
        "apps.api.tasks.email_tasks.send_invite_email": {"queue": "email_high"},
        "apps.api.tasks.email_tasks.send_mention_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_comment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_assignment_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_new_version_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_share_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_approval_email": {"queue": "email_low"},
        "apps.api.tasks.email_tasks.send_project_added_email": {"queue": "email_low"},
        # §114 — a task with no route here falls through to
        # task_default_queue="default", and NO CONTAINER CONSUMES "default".
        # docker-compose.prod.yml starts exactly three consumers, for
        # `transcoding`, `transcription` and `email_high,email_low`. Nothing
        # listens on `default` at all, so an unrouted scheduled task is
        # queued by beat and then simply sits there, forever, silently.
        #
        # `purge_expired_trash` and `send_due_date_reminders` are both in
        # that state today and have never executed in production. They are
        # deliberately NOT routed here -- see KNOWN_UNROUTED below, which
        # records why that is a decision rather than an oversight.
        #
        # The sweeper sits with the transcoding worker: it needs the DB, it
        # is not latency-sensitive, and that container is already the one
        # whose stranded work it exists to clean up.
        "apps.api.tasks.cleanup_tasks.*": {"queue": "transcoding"},
    },
    # Rate limiting for email queues (SES limits)
    task_annotations={
        "apps.api.tasks.email_tasks.*": {"rate_limit": "10/s"},  # 10 emails per second
    },
)

celery_app.conf.beat_schedule = {
    "due-date-reminders": {
        "task": "send_due_date_reminders",
        "schedule": crontab(minute="0"),  # every hour
    },
    # Safety net for the countdown-scheduled graded-export deletes -- an
    # in-memory ETA task does not survive the worker restart that every
    # deploy performs. See tasks/lut_tasks.py::sweep_lut_exports.
    "sweep-lut-exports": {
        "task": "sweep_lut_exports",
        # Twice a day (00:30 and 12:30), offset from the reminder job above.
        # This is only the backstop cadence -- the countdown delete still
        # runs an hour after each export, so the sweep normally finds
        # nothing. It only matters for exports orphaned by a worker restart,
        # which then survive up to ~12h instead of ~1h before being cleared.
        "schedule": crontab(minute="30", hour="*/12"),
    },
    # 30-day Recently Deleted retention. Daily is ample: the window is
    # measured in days, so the worst case is an item surviving its
    # thirtieth day by a few hours, which nobody can perceive and which
    # errs towards keeping data rather than destroying it early.
    #
    # 03:15 keeps it clear of both jobs above and out of working hours —
    # this one deletes real footage and issues a lot of S3 calls.
    "purge-expired-trash": {
        "task": "purge_expired_trash",
        "schedule": crontab(minute="15", hour="3"),
    },
    # §114 — the backstop for anything acks_late still cannot save (a worker
    # lost inside the ack window itself, or a task that hangs rather than
    # dies). Every 15 minutes: frequent enough that a stuck row surfaces
    # while the user still remembers uploading it, cheap enough to not care
    # — it is one indexed query that normally matches nothing.
    "sweep-stuck-processing": {
        "task": "sweep_stuck_processing",
        "schedule": crontab(minute="*/15"),
    },
}


import threading
import logging

_task_logger = logging.getLogger("celery.dispatch")


def _task_label(task):
    """A name for the log line that cannot itself throw.

    `task.name` only exists on a registered Celery task. When the thing
    handed to send_task_safe is NOT one -- which is exactly the case worth
    logging about -- reading `.name` raises inside the error handler, so the
    real failure is replaced by a second traceback from the code trying to
    report it. That happened for real: a decorator that had drifted onto the
    wrong function left process_asset a plain function, and the resulting
    AttributeError was reported only as a crash in this logger.
    """
    return getattr(task, "name", None) or getattr(task, "__name__", None) or repr(task)


def _dispatch_task(task, args, kwargs):
    """Actually send the task to Celery broker (runs in background thread)."""
    try:
        task.delay(*args, **kwargs)
    except (OperationalError, ConnectionError, OSError):
        try:
            with celery_app.producer_or_acquire() as producer:
                task.apply_async(args=args, kwargs=kwargs, producer=producer)
        except Exception:
            _task_logger.warning(
                "Failed to dispatch task %s after retry", _task_label(task), exc_info=True
            )
    except Exception:
        # exc_info because the label alone does not say WHY. "Failed to
        # dispatch task process_asset" with no traceback is what turned a
        # one-line bug into a production outage nobody could see the cause
        # of; the AttributeError underneath names it immediately.
        _task_logger.warning(
            "Failed to dispatch task %s", _task_label(task), exc_info=True
        )


def send_task_safe(task, *args, **kwargs):
    """Send a Celery task in a background thread so it never blocks the API response.

    Broker connections can take seconds (especially with pool_limit=0).
    This ensures the API returns immediately while the task is dispatched async.
    """
    thread = threading.Thread(
        target=_dispatch_task,
        args=(task, args, kwargs),
        daemon=True,
    )
    thread.start()

# §114 — scheduled tasks knowingly left on the unconsumed `default` queue.
#
# Both are real bugs, found while wiring the stuck-processing sweeper, and
# both are one line away from being fixed. Neither line is safe to add
# without someone deciding to:
#
#   purge_expired_trash       Its first successful run permanently deletes
#                             every asset and folder soft-deleted more than
#                             30 days ago -- DB rows and the S3 objects with
#                             them. Because the job has never run, that is
#                             the entire accumulated Recently Deleted backlog
#                             since the feature shipped, destroyed in one
#                             tick at 03:15 with no preview and no undo.
#
#   send_due_date_reminders   Starts emailing real users on the hour. The
#                             first runs would fire reminders for due dates
#                             that are long past.
#
# Enabling either is an operational decision with a blast radius, not a
# refactor. tests/test_celery_wiring.py asserts every OTHER scheduled task
# reaches a consumed queue, and treats these two as known -- so the check
# stays green and honest, and removing a name from this set is what turns
# the fix on.
KNOWN_UNROUTED = {"purge_expired_trash", "send_due_date_reminders"}

