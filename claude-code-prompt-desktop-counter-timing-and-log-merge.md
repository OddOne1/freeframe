# Claude Code prompt — desktop: counter only advances on a real renaming job; Log absorbs Progress and the completion card

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §71 — read it first, both Part A and Part B. Two
independent changes, safe to build together.

## Current state (confirmed, don't re-investigate)

- `index.html:1592`, `setSource(p)` calls `claimSourceCounter(p)` on
  every source assignment, regardless of whether naming is active.
- `presets.js:177-181` (`setSourceCounter`) is the existing manual-edit
  path, already wired into the naming card per §65.4 — do not touch its
  behavior, only where/when the automatic claim happens.
- `runCopyJob` (`copy-engine.js`) already has a `renamesFiles` flag
  (§23d, used for the fragile-rename guard) — reuse this exact signal
  for "does this job rename anything," don't compute a second one.
- `#jobs-progress-col` / `#jobs-log-col` (`index.html:964, 980`) are
  two separate panels showing overlapping live info during a run.
- `renderSummary()` (`index.html:2801` onward) builds the `#summary`
  "Copy verified" card as a SEPARATE element from the Log, using data
  shape `s`: `totalFiles`, `fileCopiesVerified`, `totalFileCopies`,
  `nodes` (per-destination status + parent chain), `copiedBytes`,
  `durationMs`, `mismatches`, `errors`, `skippedAssets`, `legCount`,
  `uploadOnly`. This exact data and its rendering logic (per-node dots,
  upload-vs-copy wording, skipped-assets list) is what needs to move
  INTO the corresponding Log row, not be rebuilt from scratch.

## Build

### Part A
Move the `claimSourceCounter` call out of `setSource` entirely. Claim
it once, at the point a job actually starts (wherever `startCopy()` or
equivalent calls into `runCopyJob`), and ONLY when that job's
`renamesFiles` is true. Do not add any daily/scheduled reset — the
counter stays ever-increasing, manual edits only. Confirm
`nextSourceCounter`/the editable Card # field in the naming card still
reflects the true current value with no drift after this change.

### Part B
Remove `#jobs-progress-col` and its rendering entirely — the Log
column becomes the sole live view (it already renders progress bar/
rate/ETA per row while running, confirmed in the current app).
Remove the standalone `#summary`/`renderSummary()` card. Instead, when
a job's status transitions to done (verified or otherwise), update
THAT job's own Log row to show the same content `renderSummary`
currently produces — reuse its logic/markup rather than duplicating it,
just target the Log row's DOM node instead of a separate `#summary`
element. Keep everything `renderSummary` already gets right: upload vs.
copy wording, per-destination status dots with cascade parent
attribution, mismatches/errors counts, the skipped-assets list and its
"not a complete copy" warning.

## Verification

Start a job with a naming preset active that actually renames files —
confirm the Card # advances by exactly 1 once the job starts, not when
the source was assigned. Start a plain copy with no naming preset (or a
preset with no rename) — confirm the counter does NOT advance. Manually
edit the Card # field — confirm the next renaming job uses that edited
value. During a run, confirm there is only ONE progress bar visible
(Log), not two. After a job finishes, confirm its Log row itself shows
the full completion detail (files/verified/destinations/data/duration/
per-destination status) with no separate card appearing below the Log.
Run a job with mismatches or skipped assets — confirm that detail still
surfaces correctly in the row, matching what `renderSummary` used to
show.
