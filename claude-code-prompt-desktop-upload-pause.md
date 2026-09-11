# Claude Code prompt — desktop: Pause/Resume for upload jobs (§98)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §98 — read it first, and also skim §95 (`main.js:1210-1254`,
`job-queue.js:267-304`) since this fix mirrors that pattern exactly,
just in a different closure. Do not run `npm test` or any e2e script
other than `node scripts/test-job-queue.js`.

## Current state (confirmed, don't re-investigate)

- The bug: on an upload job, clicking Pause does nothing — confirmed by
  screen recording (bytes kept climbing, row stayed "Running"). Root
  cause: `runUpload()` (`main.js:936-938`) only sets `self._cancel`,
  never `self._pause`/`self._resume`. `JobQueue.pause(id)`
  (`job-queue.js:267-269`) silently returns `false` when `job._pause`
  is falsy — no error surfaces anywhere. `panel.js:295` renders the
  Pause button for any `status === "running"` job regardless of `kind`,
  so the button was always visible on uploads despite never working.
- `runUpload()`'s per-file loop is at `main.js:975`,
  `for (const r of rel) { if (cancelled) break; ... }`. This is the
  boundary to hook `waitIfPaused` into — same shape as `runLeg()`'s
  loop in `copy-engine.js` that §95 already modified.
- `uploadFile()` (`freeframe.js:364-427`) uploads ONE file via multiple
  CONCURRENT_PARTS workers running `Promise.all`. Do NOT attempt to
  pause mid-file inside this function — out of scope, harder problem
  (in-flight multipart workers, S3 upload-part state). Pause only
  between files, exactly like local copies.
- §95's pause/resume state (`paused`, `resumeWaiters`, `wake()`,
  `self._pause`, `self._resume`, `waitIfPaused`) lives inside
  `runCopyJob`'s own `payload.run` closure
  (`main.js:1210-1254`) — a different function entirely from
  `runUpload`'s closure (`main.js:936` onward). These two closures do
  not share state today. Build the equivalent state directly inside
  `runUpload`, don't attempt a shared helper across the two — that's a
  bigger refactor than this fix calls for.

## Build

1. Inside `runUpload(self)`, add the same pattern §95 already
   established in the copy-job closure: `let paused = false; let
   resumeWaiters = []; const wake = () => { const w = resumeWaiters;
   resumeWaiters = []; for (const r of w) r(); }; self._pause = () =>
   { paused = true; }; ` and extend the existing `self._cancel` to
   also clear `paused` and call `wake()` (mirror `main.js:1220-1227`
   exactly — cancel must always win over pause, waking a parked loop
   rather than leaving it stuck).
2. Add `self._resume = () => { paused = false; wake(); };`.
3. In the per-file loop (`main.js:975`), await a `waitIfPaused()`
   check BEFORE the existing `if (cancelled) break;` — same ordering
   §95 used in `runLeg()`, same reasoning: a paused-then-cancelled job
   must wake and exit via the cancel check right after, not stay
   blocked.
4. Confirm no changes needed in `JobQueue.pause()`/`resume()` — they
   already operate on `job._pause`/`job._resume` generically. State
   this confirmation explicitly in the build report rather than just
   assuming it.
5. Confirm the exclusive-mode/coexistence behavior from §95 (pausing
   frees the concurrency slot for every mode; resume is gated on the
   scheduler's coexistence check, refused with a `statusNote` if
   something incompatible is running) applies identically to a paused
   upload — this is `JobQueue`-level logic, already generic across
   `kind`, so it should just work, but verify with a real test case
   rather than assuming.
6. Do NOT touch `job-journal.js` or add journaling to `runUpload()` —
   that's §97's separate, not-yet-built scope. Pausing an unjournaled
   upload job is fine; these are independent gaps that happen to live
   in the same function.
7. Update `panel.js` if needed — check whether the existing `if
   (j.status === "running" && onPause)` / `else if (j.status ===
   "paused" && onResume)` rendering (`panel.js:295-305`) already
   handles an upload-kind row correctly once the backend actually
   supports it, or whether anything upload-specific needs adjusting
   (it shouldn't, since the button never checked `kind` in the first
   place — but confirm rather than assume).

## Verification

Start a real upload job with enough files that pausing mid-transfer is
clearly observable (project has one with ~975 files already — use
something comparable). Click Pause mid-upload — confirm the file
currently uploading finishes (its `/upload/complete` call happens)
before the loop stops, and the row switches to "Paused" shortly after
that, not after the whole job finishes. Confirm bytes/file-count stop
advancing once paused (watch the row's progress numbers — they should
freeze, not keep climbing the way they did in the bug report). Click
Resume — confirm the next file starts, not a restart or a skip. Pause
the job again and click Cancel while paused — confirm it cancels
immediately, same as §95's paused-copy-job cancel behavior. Run a
normal upload job with no pause at all — confirm it completes exactly
as before this fix, no behavior change.
