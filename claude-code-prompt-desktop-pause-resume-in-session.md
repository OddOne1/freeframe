# Claude Code prompt — desktop: in-session Pause/Resume on a running job

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §95 — read it first. **Do not start this build until
`claude-code-prompt-desktop-jobs-panel-throttle-fix.md` (§94) has
already landed and been verified in this repo** — check `git log` for
its commit before beginning; if it's not there, stop and say so rather
than building Pause on top of the still-flaky Transfers panel. This is
in-session pause only — it does NOT touch `job-journal.js` or any of
§87's crash-recovery work; a paused job is still a live, running
process, nothing has crashed. Do not run `npm test` or any e2e script
other than `node scripts/test-job-queue.js` and
`node scripts/test-copy.js`.

## Current state (confirmed, don't re-investigate)

- `JobQueue.cancel(id)` (`job-queue.js:181-199`) is the pattern to
  mirror: find the job, call its `_cancel` callback if running (or mark
  cancelled directly if still queued), flip status, `onChange()`.
- The job's `_cancel` callback is set by the job's own `run()` payload,
  inside `main.js`'s `copy:start` handler: `self._cancel = () => {
  cancelled = true; }`, and `isCancelled: () => cancelled` is passed
  into `runCopyJob`.
- `runLeg()`'s per-file loop (`copy-engine.js`) already checks
  `if (isCancelled()) break;` at the top of each iteration — the file
  boundary is the safe point to interrupt at, never mid-file.
- `JobQueue.running` (getter, `:114-116`) filters `status === "running"`
  and is what `_schedule()`'s blocker check (`:276-…`) uses to decide
  whether a queued job can start.
- `copy:cancel`'s IPC handler (`main.js:1282-1289`) and preload's
  `cancelCopy` (`preload.js:102`) are the IPC pattern to mirror for new
  `copy:pause`/`copy:resume` channels.
- Cancel button wiring in `panel.js` (`:272-276`, inside `renderJobs`)
  and its `onCancel` callback threaded from `drawJobs()`
  (`index.html:4118-4122`) are the UI pattern to mirror for Pause/Resume.

## Build

1. `runCopyJob`/`runLeg` (`copy-engine.js`): accept a new
   `waitIfPaused` async callback alongside `isCancelled`. Await it at
   the top of `runLeg()`'s per-file loop, same location as the existing
   `isCancelled()` check, same "between files only" boundary.
2. `main.js`'s `copy:start` handler: add `let paused = false;` and a
   small resume-waiter mechanism — `self._pause = () => { paused =
   true; };`, `self._resume = () => { paused = false; /* wake any
   waiters */ };`, and a `waitIfPaused` implementation that resolves
   immediately when not paused, otherwise resolves on the next
   `_resume` OR `_cancel` call (cancel must always be able to interrupt
   a paused job — a paused job is not un-cancellable). Thread
   `waitIfPaused` into the `runCopyJob(...)` call alongside the existing
   `isCancelled` argument.
3. `JobQueue`: add a `"paused"` status. `pause(id)`/`resume(id)`
   methods mirroring `cancel(id)`'s shape — find the job, call
   `job._pause()`/`job._resume()` if running/paused respectively, flip
   `job.status`, `this.onChange()`. Update the `running` getter to
   EXCLUDE `"paused"` jobs, so `_schedule()` no longer treats a paused
   job as occupying a concurrency slot and other queued jobs can start.
   Decide explicitly what happens for a paused job whose `mode` is
   `"exclusive"` ("Single Transfer") — should pausing free the slot for
   something else even then, or does exclusive mean nothing else runs
   regardless of pause state? State your decision and reasoning in the
   build report; don't silently pick one without saying so.
4. New IPC: `copy:pause`/`copy:resume` handlers in `main.js` (mirror
   `copy:cancel`'s shape — accept an `id`, return whether the action
   took effect), and matching `pauseCopy`/`resumeCopy` in `preload.js`.
5. `panel.js`'s `renderJobs()`: a Pause button beside Cancel when
   `status === "running"` (`:272-276`'s pattern), swapping to a Resume
   button when `status === "paused"`. Wire through `drawJobs()`
   (`index.html:4118-4122`) the same way `onCancel` already is.
6. Confirm `JobQueue.isFinished()` (`:209-211`) correctly still excludes
   `"paused"` (a paused job is not history, it's still in-flight work —
   `removeFinished`/`clearFinished` must continue refusing to touch it,
   same as a running one does today).
7. Confirm the Transfers panel's status label/dot styling
   (`STATUS_LABEL`, `.job-dot` classes in `panel.js`/`panel.css`) gets a
   `"paused"` entry — don't let it fall through to an unstyled/unlabeled
   default.

## Verification

Start a real (or scratch) multi-file copy job. Press Pause mid-copy —
confirm the CURRENT file finishes copying and verifying before the loop
actually stops (check the log/journal shows a clean file boundary, not
a partial file). Confirm the job shows "Paused" with a Resume button,
and that another queued job (with a compatible-or-not mode, per your
§3 decision above) behaves as decided. Press Resume — confirm the job
continues from exactly the next file, not restarting or skipping one.
Pause a job, then Cancel it while paused — confirm Cancel still works
immediately rather than being stuck waiting on the pause. Confirm a
job's journal (§87) still shows a consistent, valid per-file record
across a pause/resume cycle — nothing in Phase 1's journal-writing
should need to change, but verify rather than assume.
