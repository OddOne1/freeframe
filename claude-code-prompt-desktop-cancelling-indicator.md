# Claude Code prompt — desktop: "Cancelling…" indicator on the Transfers panel

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §96 — read it first. Do not run `npm test` or any e2e
script other than `node scripts/test-job-queue.js`.

## Current state (confirmed, don't re-investigate)

- `JobQueue.cancel(id)` (`job-queue.js:181-199`): for a job with
  `status === "running"`, calls `job._cancel()` (the copy engine's own
  cancellation flag, checked only between files — see §96's descoped
  section for why that's staying as-is) but does **not** change
  `job.status`. It stays `"running"` with zero visible change until the
  job's `run()` promise actually settles to `"cancelled"` later,
  possibly much later for a large in-flight file.
- `panel.js`'s `renderJobs()` reads `job.status` to pick a label/dot
  style (`STATUS_LABEL`, `.job-dot` classes) — this is the place a new
  status needs to be added, not a new parallel code path.
- Do NOT touch `copy-engine.js`, `copyOneFileFanOut()`, or the
  cancellation-check granularity anywhere. That gap is real and known
  (documented in §96) but the user has explicitly chosen not to have it
  fixed right now — keep the scope to a status label only.

## Build

1. `JobQueue.cancel(id)` (`job-queue.js:181-199`): when cancelling a
   `"running"` job, in addition to calling `job._cancel()`, set a new
   `job.cancelling = true` flag and call `this.onChange()` immediately
   (so the UI updates right away, same tick as the click — this is the
   whole point). Leave `job.status` as `"running"` until the job
   actually settles; don't invent a new status value that other code
   (`running` getter, `isFinished()`, scheduler) would need to learn
   about — `cancelling` is purely a display flag layered on top of the
   existing `"running"` status.
2. Wherever the job's `run()` promise settles (after cancellation) and
   `job.status` is set to its final value, clear `job.cancelling` at
   the same time (it becomes moot once status changes away from
   `"running"`).
3. `panel.js`'s `renderJobs()`: when rendering a job row with
   `status === "running"`, check `job.cancelling` — if true, show
   "Cancelling…" instead of whatever the normal running label/text is
   (keep the same dot color/style as running, this is just a text
   change, not a new visual state). No change needed to `STATUS_LABEL`
   for other statuses.
4. Confirm the Cancel button itself doesn't need a second click or
   change behavior — this is purely a read of `job.cancelling` for
   display, the button's existing `onCancel` wiring is unchanged.

## Verification

Start a real (or scratch) copy job with at least one large file.
Press Cancel while it's clearly still copying — confirm the row's
label switches to "Cancelling…" immediately (comparable to §94's
~125ms-scale responsiveness — this should be instant since it's not
gated by any progress throttle). Confirm the label correctly switches
away once the job actually finishes cancelling (to whatever the normal
"Cancelled" state shows). Confirm a job that finishes normally (not
cancelled) never shows "Cancelling…". Confirm cancelling a queued
(not yet running) job is unaffected — that path doesn't go through
`cancelling` at all, it should still cancel immediately as it already
does.
