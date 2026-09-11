# Claude Code prompt — desktop: Settings screen + speed/ETA in progress panel

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §58 (desktop) — read it first.

## Current state (confirmed, don't re-investigate)

- The copy-job queue and progress panel are already mature —
  `apps/desktop/src/main/job-queue.js` (a real work-conserving
  scheduler with source/destination/free coexistence modes), a
  docked `#jobs-panel`/`#jobs-list` (`index.html:1040-1046`) and a
  detachable progress window sharing `panel.js`'s `renderJobs()`.
  **None of this needs changing** — this prompt only adds a Settings
  screen and speed/ETA, nothing else.
- No settings/preferences UI exists anywhere in this app today. The
  only settings-adjacent things are a per-job checksum-algorithm
  picker (`index.html:1359-1407`, chosen fresh every job, never
  remembered) and a handful of preferences-shaped JSON files under
  `app.getPath("userData")` (`naming-presets.json`,
  `recent-folders.json`, `display-names.json`) with no UI surface.
- No speed/ETA field exists in the progress data model or UI
  anywhere — `progress` objects (updated via `job-queue.js`'s
  `updateProgress()`, line ~187-192) carry no `speed`/`bytesPerSec`/
  `eta`. `panel.js`'s `fmtDuration()` only formats elapsed time after
  completion.

## Build

1. **Settings screen** — new modal/view, entry point via app menu
   and/or a gear icon in the main window. Match whichever UI pattern
   this app already uses for a similarly-sized surface (check how the
   naming-preset editor or folder picker is built — modal vs. panel —
   and follow that convention rather than inventing a new one).
   First-pass contents (documented as a deliberately minimal starting
   set, not exhaustive):
   - Default checksum algorithm — persisted, pre-selects the per-job
     picker's default without removing the per-job override.
   - "Open logs folder" button.
   - App version / about text.
2. **Persistence** — extend an existing preferences-shaped JSON file
   or add a new `settings.json` alongside the others under
   `app.getPath("userData")` (state which you picked and why in the
   build report) with a `defaultChecksumAlgo` field, read on startup
   and applied to the per-job picker's initial selection.
3. **Speed + ETA** — compute a rolling bytes/sec rate wherever
   progress updates happen during an active copy (main process, near
   `job-queue.js`'s `updateProgress()` call sites), smoothed over a
   short recent window (last few ticks) rather than the whole job's
   average, so a stall or a burst doesn't produce a wildly wrong
   instantaneous number. Include `speed`/`eta` in the `progress`
   object already sent over the existing `copy:progress` IPC channel
   — no new IPC channel needed. Render a simple "42 MB/s · 3m
   remaining" line in both the docked footer (`#progress`,
   `index.html:1057-1063`) and the jobs panel (`panel.js`'s
   `renderJobs()`).

## Verification

Open Settings, set a non-default checksum algorithm, close and
relaunch the app, confirm the per-job picker now pre-selects it while
still allowing per-job override. Run a real copy job with at least
10-20 seconds of transfer — confirm both the docked footer and the
jobs panel show a live, plausible speed and a decreasing ETA, not a
frozen or erratic number (verify it stays reasonable across a brief
pause/resume if the app supports that, not just a steady-state
transfer). Confirm "Open logs folder" opens the actual folder job
logs write to.
