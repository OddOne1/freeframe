# Claude Code prompt — desktop: notification center, quit-guard, resumed-job log detail (§105, parts A/C/D/E)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §105 — read it in full first. **Build
`claude-code-prompt-desktop-local-copy-resume.md` (§105 part B)
BEFORE this one** — the quit-guard's wording here and the post-crash
verification check both assume local-copy jobs are resumable, which
part B is what makes true. If part B hasn't shipped yet, stop and say
so rather than building this against a false assumption. This is
`apps/desktop`. Run the full desktop test suite at the end.

## Current state (confirmed, don't re-investigate)

- Resume modal: `resume-backdrop` (`index.html:1113-1126`) has exactly
  two buttons, `resume-discard` and `resume-go` — no third option, no
  X/close. `offerResume()` (`index.html:3610-3671`) resolves the modal
  via those two listeners only.
- `resumeOffered` (`index.html:3571`) is in-memory only, cleared every
  launch — not the mechanism to persist "hidden" state.
- `app.on("before-quit", ...)` (`main.js:1917-1921`) currently only
  tears down the volume watcher. No job-awareness at all today.
- `job-journal.js`'s `doc` shape (`:77-103`) is the journal's full
  on-disk record — adding a field here (e.g. `hiddenFromPrompt`) is
  the natural place for persisted dismiss state, consistent with how
  every other piece of resume state already lives on this doc rather
  than in a side file.
- §84's readable log section (find the function that formats a job's
  log — search near where `summary.finalized` or similar fields get
  written to text) is where resumed-job detail needs to be added.

## Build

### A — Notification center + hide/dismiss

1. `job-journal.js`: add a function to mutate an existing journal's
   `hiddenFromPrompt` flag (default `false`/absent) without touching
   its other fields — needs to work on a journal that's already
   `finishJournal`'d away for a resume that's mid-flight, so check the
   `open`/in-memory map vs. an already-closed-on-disk journal and
   handle both (a hide action can arrive after the job that owns the
   journal isn't "open" anymore in this process, e.g. app was
   relaunched).
2. Resume modal: add a third button, "Not now", alongside Resume/
   Discard. Its handler: close the modal, call the new hide function
   (sets `hiddenFromPrompt: true`), do NOT touch the journal otherwise.
3. `maybeOfferResume`/`offerResume` (`index.html:3594-3671`): the
   candidate filter must exclude any journal with `hiddenFromPrompt
   === true` from ever showing the blocking modal again — this is the
   actual fix for "shouldn't reappear on next launch."
4. New notification-center UI: a bell icon + badge count in the top
   bar (find the existing header/toolbar markup and match its style),
   opening a small panel. Populate it from `interruptedUploads()`
   (post-§105-part-B, this already covers both upload and copy kinds)
   filtered to `hiddenFromPrompt === true` entries — these are exactly
   the ones the user chose to park. Each item: label, "X of Y files"
   summary (same data `offerResume` already formats), a Resume action
   (re-invokes the same resume flow `offerResume` uses) and a Dismiss
   action.
5. Dismiss (from the bell, NOT from the modal): per §105's decision,
   dismiss = discard. Call the same underlying journal-delete path
   Discard already uses. Confirm it removes the item from the bell
   immediately (don't require a re-poll).
6. Design the bell's item model generically enough that a future
   non-resume notification type (e.g. "update available") is a new
   item shape, not a parallel mechanism — a `type` field and a
   small per-type renderer/action-set is enough, don't over-build this
   now, just don't paint it into a resume-only corner either.

### C — Quit-guard

1. In `before-quit`: check the job queue (`jobs.js` — read its actual
   status vocabulary before assuming exact strings) for anything
   currently active (copying, verifying, uploading, finalizing — not
   queued/paused/done/cancelled). If nothing active, quit proceeds
   unchanged.
2. If something's active: `event.preventDefault()`, show a dialog
   (native `dialog.showMessageBox` is simplest and appropriate here
   since the app may be about to lose its renderer anyway — but check
   whether other confirmations in this app route through the renderer
   instead, and match that convention if so) with two actions: "Cancel"
   (abort the quit attempt, nothing else happens) and "Quit anyway"
   (proceed with the quit for real — needs a flag checked at the top
   of the `before-quit` handler, or removing/re-adding the listener,
   to avoid `app.quit()` re-triggering the same guard and looping).
3. Wording (now that part B exists): something conveying — quitting
   now interrupts the running job; it can be resumed next launch; the
   app will re-check what's actually on disk against what the job
   claimed before trusting it's complete. Don't overpromise instant
   resume with zero re-verification — D covers why that's not quite
   the right claim either.

### D — Post-resume / post-crash state accuracy

This is mostly a verification target, not new code, PROVIDED part B's
journal-per-resumed-run mechanism already produces live, accurate
per-file journal entries during a resume attempt (it should, since
Phase 1 journaling isn't resume-aware, it just journals whatever job
is currently running). Explicitly test: start a job, crash it, resume
it, crash the RESUME itself partway through, relaunch again — confirm
the notification/modal shown now reflects progress from the SECOND
(resumed) attempt, not stale numbers from the original crash. If this
does NOT hold already, the bug is almost certainly that resume
detection is reading an old cached journal reference rather than
re-querying — fix by ensuring `interruptedUploads()` (or its
post-§105-B equivalent) always reads fresh from disk, never from an
in-memory list computed before the resume attempt started.

### E — Log enrichment

Locate the function that builds §84's readable log text for a
finished job. For a job that resumed from a journal (i.e., started
with a `resumeJobId`), add a block stating: which file the ORIGINAL
run's journal last recorded as done before the gap, which file the
RESUMED run started from, and that already-verified files were
confirmed via a stat+size check (not a full re-hash) before being
skipped — per part B's design, say this plainly rather than leaving
"resumed" ambiguous about how much was actually re-checked.

## Verification

Modal: confirm "Not now" closes it without deleting the journal, and
that the SAME journal does not force-reopen the modal on next launch
but DOES appear in the bell. Bell: confirm Resume from the bell
launches the same flow as the modal's Resume; confirm Dismiss deletes
the journal and removes the bell item. Quit-guard: start a job, attempt
Cmd+Q/quit, confirm the dialog blocks it; choose Cancel, confirm the
job keeps running untouched; choose Quit anyway, confirm the app
actually exits. Relaunch after a forced quit, confirm the interrupted
job is offered for resume (both upload and copy kind). Crash a resume
attempt itself and confirm D's scenario (accurate second-crash state)
holds. Confirm the log for a resumed job states the original stop
point, resume point, and stat+size (not full-rehash) framing. Run the
full desktop test suite (Electron/e2e via `electron-harness.js`'s
teardown per §62) at the end — report pass/fail counts, flag anything
not already a documented pre-existing failure.
