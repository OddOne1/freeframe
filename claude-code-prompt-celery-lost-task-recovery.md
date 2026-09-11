# Claude Code prompt — recover from Celery tasks killed mid-run + fix
broken Celery healthchecks

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Touches
`apps/api` and `docker-compose.prod.yml`. Run backend tests at the end
(flag if the same Python 3.9/no-pytest/no-Docker environment limitation
from prior rounds applies — confirm what you can, note what you can't).

## Confirmed root cause (live investigation, not guessed)

A video/image stuck permanently at `processing_status = processing`
was traced live against production: `celery -A apps.api.tasks.celery_app
inspect active` and `inspect reserved` both came back empty across all
three worker nodes — the task is not running, not queued, just gone.
CPU was near-idle at the time (confirmed via TrueNAS monitoring), ruling
out "still working, just slow." `docker ps` confirmed no duplicate/
orphaned container — the `worker` and `email_worker` containers had
both restarted ~34 minutes prior (matching a deploy), which is the
likely moment the task was lost: Celery's default behavior acks a task
as soon as a worker receives it, not when it completes, so a container
killed mid-task (via `docker-compose up -d --build`, which sends
SIGTERM/SIGKILL to the running process) loses that task permanently —
it's already acked, so nothing requeues it, and because the process was
killed rather than raising a Python exception, the `except`/`finally`
block that would normally flip `processing_status` to `failed` never
ran. The row is left stuck forever with no error surfaced anywhere.

Check `apps/api/tasks/celery_app.py` for current `acks_late`/
`task_reject_on_worker_lost` config — confirm whether either is already
set (if so the analysis above needs revisiting) or genuinely absent
(matches what was observed).

## Build

### 1. Stop losing tasks on worker restart

Set `task_acks_late = True` and `task_reject_on_worker_lost = True` in
the Celery app config (`celery_app.py`). This makes a task get acked
only after it completes — if the worker process dies mid-task, the
broker redelivers it to another worker instead of losing it silently.
Be deliberate about idempotency implications: `_process_video`/
`_process_image`/`_process_audio` will now potentially run twice for
the same version if a worker dies partway through a real (not
container-restart-induced) crash — check whether the transcode/thumbnail
functions are safe to re-run from scratch (they should be, since they
write to deterministic S3 keys and set status at the end, but confirm
rather than assume) or need an idempotency guard (e.g. skip if
`processing_status` is already `ready` when the task starts).

### 2. Add a stale-task sweeper as a backstop

Even with #1, a task can still get definitively lost in edge cases
(e.g. a worker crash during the ack-late window itself, or a task that
genuinely hangs rather than dies). Add a periodic Celery Beat job,
following the existing pattern in `apps/api/tasks/cleanup_tasks.py`
(the reaper/retention-GC/orphan-sweeper jobs already there — match
their structure, logging, and disabled-by-default-with-env-toggle
conventions if that pattern exists), that finds any `AssetVersion` with
`processing_status = processing` where `updated_at` (or equivalent) is
older than some reasonable threshold (make this configurable via env
var, default something like 30-60 minutes — transcodes shouldn't
normally take that long, but check against real ffmpeg ladder timing
expectations before picking a number) and flips it to `failed`, so it's
at least visible and the user can re-upload instead of it silently
haunting the system forever. Log what it catches, the same way the
existing cleanup tasks log their outcomes — this directly feeds into
the "production logs almost nothing" gap flagged earlier from the
upstream issues review (§262-equivalent), so make sure these log lines
would actually be visible in production (check the current Celery log
level for the `worker`/`beat` services in `docker-compose.prod.yml`).

### 3. Fix broken healthchecks on Celery services

`docker-compose.prod.yml`: `worker`, `email_worker`, `beat`, and
`transcribe_worker` all currently report `(unhealthy)` in `docker ps`
even when demonstrably functioning correctly (confirmed live —
`transcribe_worker` answered `celery inspect stats` instantly and has
processed real tasks over a 2-day uptime, yet shows unhealthy). Find
each service's `healthcheck:` block and diagnose why it fails for a
process with no HTTP server to poll — likely an HTTP-based check
copy-pasted from `api`/`web` that doesn't apply to a Celery worker.
Replace with something that actually reflects Celery worker health,
e.g. `celery -A apps.api.tasks.celery_app inspect ping -d celery@$$HOSTNAME`
(or the whole-fleet `inspect ping`) as the healthcheck command, adjusted
so `beat` (which isn't a worker and won't respond to `inspect ping`) gets
an appropriate check for a scheduler process instead (e.g. checking its
own process is alive, or that its schedule file is being written to
periodically — check what's reasonable for `beat` specifically rather
than reusing the worker check for it).

## Verification

This needs real Celery + Postgres — flag clearly what could and
couldn't be verified in whatever environment is available, matching the
honesty of prior rounds' verification sections rather than claiming
more than was actually checked:

- Start a real transcode, kill the `worker` container mid-task
  (`docker restart` or `docker stop`/`up` timed to land mid-run), confirm
  the task gets redelivered and completes on restart rather than
  vanishing.
- Manually set an `AssetVersion` row to `processing` with an old
  `updated_at` in a test DB, run the sweeper, confirm it flips to
  `failed` and logs the outcome.
- After deploy, confirm `docker ps` shows `worker`/`email_worker`/`beat`/
  `transcribe_worker` as healthy, not unhealthy, once the healthcheck
  fix is live.
- Report pass/fail counts for whatever automated tests could run in
  this environment, and explicitly list what still needs a real
  Postgres+Celery pass (per §37) before this is fully trusted.
