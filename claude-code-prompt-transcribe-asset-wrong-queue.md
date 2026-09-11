# Claude Code prompt — transcribe_asset dispatched but never reaches
transcribe_worker, live production

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Third round on
transcription this session — the missing-dependency bug (4aa6d44) and
the home-directory/cache-volume permissions bug (714457c) are both
confirmed fixed and deployed. This is a new, different failure that
only became visible once those two were out of the way.

## Confirmed live evidence, not a guess

`transcribe_worker`'s own startup banner declares:

```
[queues]
  .> transcription    exchange=default(direct) key=default
```

`transcribe_asset.delay(asset_id, version_id)` was called directly
from a Python shell inside the `api` container and returned normally
(printed "dispatched", no exception). Immediately after, checking
Redis directly:

```
redis-cli llen transcription
```

returned `0` — empty queue. Four minutes of following
`transcribe_worker`'s logs live produced zero output: no task-received
line, no error, nothing. The task was sent successfully but never
arrived in the queue this worker is actually consuming from.

## Investigate, don't guess

- Find `transcribe_asset`'s task decorator (`apps/api/tasks/
  transcribe_tasks.py`) and confirm exactly which queue it's
  configured to publish to — does it explicitly say
  `queue='transcription'` to match what `transcribe_worker` declares,
  or does it fall through to Celery's default queue (commonly named
  `celery`) because the decorator or the app's task-routing config
  doesn't set one?
- Check `celery_app.py`'s task routing configuration
  (`task_routes` or equivalent) for whether `transcribe_asset` is
  correctly mapped to the `transcription` queue there, separate from
  whatever the decorator itself says — a mismatch between the two is
  a plausible way for this to happen silently.
- Check whether `.delay()` vs. `.apply_async(queue=...)` matters here
  — `.delay()` uses whatever the task's default routing resolves to,
  so if that default is wrong, `.delay()` would always miss, while an
  explicit `apply_async(queue='transcription', ...)` would still work
  regardless. Confirm which one `upload.py` or wherever transcription
  actually gets triggered from during normal (non-manual) dispatch
  uses, and whether that path has the same bug or a different one.
- This project has already found the exact bug class "decorator
  configured wrong so the task never reaches its intended queue/
  worker" once before this session (the `process_asset` Celery
  decorator bug, da30c8d). Check whether this is the same shape —
  worth being suspicious of copy-paste-adjacent code near that fix, or
  whether `transcribe_asset`'s decorator was ever actually verified
  end-to-end after 4aa6d44/714457c, since both of those rounds fixed
  environment/dependency issues without confirming the task actually
  reaches the worker at all.

## Fix

Once the actual routing mismatch is found, fix it at the real source
(decorator queue argument, task_routes config, or whichever dispatch
call site is wrong) rather than switching the manual test call to use
`apply_async(queue=...)` as a workaround — that would hide the bug for
manual dispatch while leaving real, automatic transcription (triggered
from the actual upload flow) still broken.

## Verification

Real environment: after the fix, trigger transcription both via
`.delay()` in a manual test AND via the actual normal path (a fresh
upload going through its real trigger point) — confirm both actually
land in the `transcription` queue (`redis-cli llen transcription`
should briefly show activity, then drop back to 0 as the worker
consumes it) and that `transcribe_worker`'s logs show the task being
received and completing successfully, with real transcript content
appearing in the asset's Transcript tab afterward. Don't consider this
closed until an upload triggered exactly the way a real user would
upload actually gets a real transcript, not just a manually-dispatched
one. Push and report back.
