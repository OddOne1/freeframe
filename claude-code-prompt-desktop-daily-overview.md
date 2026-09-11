# Claude Code prompt — desktop: persistent daily job overview

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §72 — read it first, including the approved mockup
description. **Build `claude-code-prompt-desktop-counter-timing-and-log-merge.md`
(§71) first** — this reads from the same per-job completion data §71
folds into the Log row.

## Current state (confirmed, don't re-investigate)

- `settings.js`'s `DEFAULTS`/`readSettings`/`writeSettings` is the
  existing pattern for a small persisted app-local settings store —
  follow it for the new "Day boundary time" field.
- `naming-presets.json`/`recent-folders.json`/`display-names.json`
  each get their OWN file under `app.getPath("userData")` — this app's
  established convention against one shared blob. `daily-overview.json`
  follows the same pattern.
- Settings → General tab already exists (§61) — add the new time
  control there.
- The header (`index.html`, near `#refresh`/`#settings-btn`) is where
  the new "Daily overview" button goes — same row, same visual family.
- `#menu`'s dropdown positioning pattern (anchored under a button,
  `e.currentTarget.getBoundingClientRect()` — captured BEFORE any
  `await`, per §65c's fix) is the precedent to follow for this new
  dropdown card, NOT a new `BrowserWindow`.
- Settings → About's "Open Logs Folder" button/handler — find it and
  reuse the same directory for CSV export rather than picking a new
  location.

## Build

1. New file `apps/desktop/src/main/daily-overview.js` (or fold into an
   existing main-process module if a clear fit exists — your call),
   implementing the data shape from §72: array of day-entries keyed by
   `dayKey` (boundary-shifted logical day), each holding `cards: [{
   label, isNamedCard, firstCompletedAt, files, bytes, verifiedFiles,
   totalFileCopies, status }]`.
2. Wire it into the same completion point §71 uses to fold
   `renderSummary`'s data into a Log row. One write per finished job:
   if this card already has a row for today's `dayKey`, merge into it
   (add files/bytes, update verified counts, keep the earliest
   `firstCompletedAt`); otherwise create a new row. A card is identified
   by its naming-card-number when one was assigned, otherwise by its
   source folder name (`isNamedCard: false` in that case).
3. New Settings → General control: "Day boundary time," a time-of-day
   picker, default `00:00`, persisted via `settings.js`'s existing
   pattern.
4. `dayKey` computation: a job completing at time T belongs to the
   calendar day of T, UNLESS T is before the configured boundary time,
   in which case it belongs to the PREVIOUS calendar day. (Boundary
   00:00 = no shift, matches plain calendar days by default.)
5. New header button "Daily overview," opens a dropdown card (not a
   window) matching the approved mockup: header with date/reset-time/
   job-count and a "Reset now" control styled with this app's existing
   destructive/reset-action treatment; a stat row (Cards/Files/Data/
   Verified totals for today); a scrollable list, one row per card;
   a footer with "Export as CSV" and a hint pointing at Settings →
   General for the boundary-time control.
6. "Reset now": clears today's `dayKey` entry only (not the whole
   file — other days' entries, if retained, are untouched).
7. CSV export: one row per card in today's entry, written to the same
   directory "Open Logs Folder" already points to.

## Verification

Complete a job for a named card, then complete a second job for the
SAME card to a different destination — confirm the daily overview
shows ONE row for that card with combined file/byte counts, not two
rows. Complete a plain copy with no naming preset — confirm it appears
in the list labeled by folder name, and does NOT consume a §71 counter
number. Set the boundary time to something other than midnight (e.g.
05:00) and complete a job at a time before that boundary — confirm it
gets attributed to the previous day's entry. Click "Reset now" — confirm
today's entry clears but the app doesn't crash or lose the underlying
file. Export CSV — confirm the file lands in the same folder as
"Open Logs Folder" and contains the right per-card totals. Restart the
app mid-day — confirm the daily overview still shows today's
accumulated data (persisted, not just in-memory).
