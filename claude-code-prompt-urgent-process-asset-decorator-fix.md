# Claude Code prompt — URGENT: process_asset is not a registered Celery
task, all new upload processing is broken

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is a live
production outage — all new image/video/audio uploads are stuck at
"processing" forever because the dispatch call throws immediately.
`apps/api`. Skip anything not needed to ship this fast; this jumps the
queue ahead of other pending prompts.

## Confirmed root cause (read directly from the file, matches the
production traceback exactly — not a guess)

`apps/api/tasks/transcode_tasks.py:31` —
`@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)` —
is immediately followed by `def _notify_new_version(db, asset, version)`
(line 32), NOT `def process_asset(self, asset_id: str, version_id: str)`
(line 81). The decorator therefore registers `_notify_new_version` as
the Celery task and leaves `process_asset` as a plain, undecorated
Python function.

`apps/api/routers/upload.py:217-219` imports `process_asset` and calls
`send_task_safe(process_asset, str(asset_id), str(version_id))`, which
calls `process_asset.delay(...)` in `celery_app.py:158` —
`AttributeError: 'function' object has no attribute 'delay'`, exactly
matching the production log. The fallback exception handler at
`celery_app.py:166` then also crashes trying to log `task.name` (plain
functions have `__name__`, not `.name`), producing the second stacked
traceback also seen in the logs.

This was introduced when `_notify_new_version` was inserted between the
decorator and `process_asset` in the notifications commit (142e46c) —
classic decorator-binds-to-wrong-function bug from inserting code in
the wrong place. It has been broken since that deploy; nothing caught
it because no fresh upload was tested end-to-end against it until now.

`_notify_new_version` itself is called directly as a plain function
(never via `.delay()`/`.apply_async()` — confirm this with a grep before
assuming, but it takes live SQLAlchemy `db`/`asset`/`version` objects as
args, which are not broker-serializable, so it cannot be a real
dispatched task) — it should not be decorated at all.

## Fix

Move `@celery_app.task(bind=True, max_retries=3, default_retry_delay=60)`
from directly above `_notify_new_version` (line 31) to directly above
`process_asset` (line 81). Remove it from `_notify_new_version` entirely.

Grep the whole codebase for any other call site that might call
`_notify_new_version.delay(...)` or `.apply_async(...)` before removing
its decorator — if one exists, that call site needs to change to a
direct call instead, since it was never actually going to work as a
real dispatched task anyway (non-serializable args). Expected to find
none, but confirm rather than assume given how much is riding on this.

Also harden `celery_app.py`'s `_dispatch_task` exception handlers
(lines 159-166) so a future mis-wired task fails with ONE clear error
message instead of a second crash while trying to report the first:
guard the `task.name`/`task.__name__` access (e.g.
`getattr(task, "name", getattr(task, "__name__", repr(task)))`) so the
log line itself can never throw, regardless of what `task` turns out to
be.

## Verification

This is the one gap that must close before calling this done — a real
upload, not just code inspection:

- Upload a fresh image and a fresh video after the fix, confirm both
  actually leave "processing" and reach `ready`.
- Confirm `_notify_new_version` still fires correctly for a genuine new
  version upload with an assignee set (per its existing intended
  behavior) — this must not regress while fixing the decorator.
- Grep the codebase once more for any other function in this file or
  sibling task files with the same pattern (a decorator followed by an
  unrelated helper before the intended task function) — this exact bug
  class is worth ruling out elsewhere before considering this closed,
  not just patching the one instance that happened to get caught.
- Run whatever automated tests this environment can actually run
  (per the ongoing Python 3.9/no-Docker limitation noted in prior
  rounds) and report honestly what could and couldn't be verified.

Push and report back immediately — this blocks all upload processing
in production until it lands.
