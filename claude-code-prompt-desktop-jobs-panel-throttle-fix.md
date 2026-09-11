# Claude Code prompt — desktop: throttle jobs:changed on byte ticks so Cancel stays clickable

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §94 — read it first, and read §85 (`onProgress`/render-thrash
fix) for the precedent this mirrors — same bug shape, different file,
different fix strategy (throttle at the source vs. surgical DOM update).
Do not run `npm test` or any e2e script other than
`node scripts/test-job-queue.js` (the existing pure-node script for
`job-queue.js` — check it exists and covers `updateProgress` before
assuming; extend it rather than adding a new script).

## Current state (confirmed, don't re-investigate)

- `JobQueue.updateProgress(id, progress)` (`job-queue.js:251-261`) calls
  `this.onChange()` unconditionally on every call.
- Every running job's `onProgress` forwards its `"bytes"` events (fired
  many times a second) through `jobs.updateProgress(self.id, p)`
  (`main.js`'s `copy:start` handler, inside the `onProgress: (p) => {...}`
  callback) — so `onChange()` fires at that same high frequency.
- `onChange` is wired to `broadcastJobs()` (`main.js:36`), which sends
  `jobs:changed` over IPC to every window (`main.js:263-...`).
- The renderer's `onJobsChanged` listener (`index.html:4422-4430`) calls
  `drawJobs()` unconditionally on every broadcast, which calls
  `window.JobPanel.renderJobs(host, jobSnapshot, {...})`
  (`panel.js:221`) — whose first line is `host.replaceChildren()`,
  tearing down and rebuilding every row (including the Cancel button,
  `:272-276`) on every tick.
- This reproduces exactly as §85 did: a click spanning
  mousedown→rebuild→click lands on nothing, so Cancel needs several
  hits to register.
- `RateTracker` (`rate.js`) already does per-job, time-based bookkeeping
  for speed/ETA — check its constructor/update signature for the
  existing convention (per-job state keyed by job id, `Date.now()`-based
  intervals) before inventing a different pattern for the throttle.

## Build

1. In `updateProgress()`, distinguish a `"bytes"`-only progress update
   from every other kind. The cleanest signal is probably `progress.phase
   === "bytes"` (check what shape `p` actually has at this call site —
   confirm against what `onProgress` in `copy-engine.js` actually sends
   for a bytes tick before assuming the field name).
2. For `"bytes"` updates only: track a last-broadcast timestamp per job
   (or globally, if a single shared timestamp is simpler and the
   difference doesn't matter in practice — decide and say which you
   picked and why in the build report). Only call `this.onChange()` if
   enough time has elapsed since the last one for THIS reason (suggest
   ~100-125ms, i.e. 8-10 times a second — smooth enough for a percent bar
   and a Cancel button that stays hittable). Still update `job.progress`
   itself on every call, unconditionally — only the BROADCAST is
   throttled, not the underlying state, so a throttled tick's data isn't
   lost, just coalesced into the next broadcast.
3. Every OTHER kind of update (anything not `"bytes"` — job added,
   finished, status transition, `"node-status"`-equivalent,
   queued→running) must call `this.onChange()` immediately, unthrottled,
   exactly as today. Get this distinction right — throttling a real
   state transition would reintroduce a *worse* version of §85's original
   bug (a running-to-done transition arriving late enough that Cancel
   shows on a job that already finished).
4. Confirm nothing else that expects `onChange`/`jobs:changed` to fire
   synchronously on EVERY `updateProgress` call breaks from the new
   throttling — grep every caller of `updateProgress` and every listener
   of `onJobsChanged`/`jobs:changed` and list what you found in the build
   report, the same audit discipline §89/§93 used for their shared-helper
   fixes.

## Verification

Start a real (or scratch) copy job. While it's running, repeatedly click
Cancel — confirm it registers on the first click, reliably, not
intermittently. Confirm the percent bar in the Transfers panel still
updates smoothly to the eye (no visible stutter from the throttle).
Confirm a job finishing, or transitioning from queued to running, still
reflects in the panel immediately — no perceptible lag on those
transitions specifically. Confirm the detached job window (if reachable
without a full e2e run) and the docked footer both still track speed/ETA
correctly, since both read from the same `updateProgress`-driven state.
