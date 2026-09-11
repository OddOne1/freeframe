# Claude Code prompt — desktop: local-copy resume-from-journal (§105, part B)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §105, part B — read it first, and read §87 (`grep "^## §87"`)
in full, since this is explicitly a port of Phase 2's existing,
working mechanism to a second job kind, not new design. Build this one
BEFORE `claude-code-prompt-desktop-notifications-quitguard.md` — that
prompt's quit-guard wording and post-crash verification both assume
local-copy resume already exists. This is `apps/desktop`. Run the full
desktop test suite (Electron/e2e included) at the end.

## Current state (confirmed, don't re-investigate)

- `job-journal.js`'s `startJournal`/`appendFileResult` already fire for
  BOTH `runCopyJob` and `runUpload` — Phase 1 (journaling) is done for
  local copies too (`main.js:1539-1566` is the `runCopyJob` call site
  doing exactly this). The gap is entirely Phase 2 (skip-logic), not
  journaling.
- `main.js:943` — `interruptedUploads()`'s filter: `doc.kind ===
  "upload" && doc.status === "running"`. Local-copy journals have
  `kind: null` (nothing ever sets `kind: "copy"` on `self` for a copy
  job — confirmed, grepped for it, no hits) so they never match.
- `freeframe:upload`'s IPC handler (`main.js:968`) already accepts
  `resumeJobId`, reads the old journal via `journal.readJournal`, and
  builds a `skip` map (`main.js:1090-1105`) from files the SERVER
  confirms still exist (`freeframe.checkExistingAssets`). `copy:start`
  (`main.js:1340-…`) has no equivalent at all.
- The "was the predecessor journal now fully covered, retire it" logic
  already exists in the upload path — find it (search for
  `journaledOk` in `main.js`, referenced around the upload job's
  completion) and reuse the pattern rather than reinventing it.

## Build

1. Set `kind: "copy"` on the local-copy job (`self`) at creation,
   wherever `copy:start`'s handler builds the job object passed to the
   queue (near `main.js:1500`, alongside `label`/`sourceLabel`/etc.) —
   this is what makes the journal's `kind` field correct and what a
   detection filter can key on.
2. `interruptedUploads()`: either drop the `kind === "upload"` filter
   (renaming the function honestly if scope broadens that way) or add
   a sibling that also matches `kind === "copy"`. Check every renderer
   call site of `interruptedUploads` before choosing — a rename ripples.
3. `copy:start`'s IPC handler: accept an optional `resumeJobId`. When
   present, `journal.readJournal(LOG_DIR(), resumeJobId)`. For every
   file the old journal recorded `ok: true`, verify LOCALLY: `fs.stat`
   each of that file's recorded destination paths and compare `.size`
   against the journal's recorded `bytes`. Build a `skip` set/map from
   files that check out. This is the local equivalent of `checkExisting
   Assets` — no server round trip needed, it's a filesystem, so use
   `fsp.stat` directly, not an API call.
4. Thread the `skip` map into `runCopyJob`/`runLeg`: files in `skip`
   are not re-read/re-copied. Everything not in `skip` (never attempted,
   or failed the stat+size check — e.g. destination deleted or
   truncated since the crash) is copied fresh, exactly as if this were
   a new job. This mirrors `runUpload`'s existing skip-map consumption
   — read that code path as the template for how `entry`/`fileResults`
   should treat a skipped file (still needs to show up in the final
   summary as accounted-for, not silently absent).
5. Reuse the existing "predecessor journal now fully covered, retire
   it" logic from the upload path for the copy path too — don't leave
   two divergent copies of that logic if it can be shared.
6. Discard path: confirm `discardInterruptedUpload`'s underlying
   journal-delete function is kind-agnostic (delete by jobId should not
   care whether it was an upload or a copy) — if it's actually
   upload-specific in implementation, not just in its IPC channel name,
   fix that rather than duplicating a copy-specific discard handler.
7. Launch-time and source-selected triggers in the renderer
   (`maybeOfferResume`, `index.html:3594-3608`) need to also consider
   copy-kind journals now, matching on `sourcePath`/`sourceFiles` the
   same way they already do for uploads — the matching logic
   (`journalMatchesSource`, `:3581-3585`) should already be kind-
   agnostic since it only looks at source fields; confirm rather than
   assume.

## Verification

Start a local copy job, kill the app mid-transfer (not gracefully —
simulate a real crash, e.g. `kill -9` the Electron process), relaunch,
confirm the interrupted local-copy journal is now detected and
offered. Choose Resume: confirm files already verified good are
skipped (measurable — don't just trust a log line, confirm via
timing/IO that the skipped files' bytes were not re-read) and
everything else copies fresh. Corrupt or delete one of the "already
verified" destination files between the crash and the resume, confirm
the stat+size check catches it and that file gets re-copied rather
than silently trusted. Confirm the OLD journal is retired once the
resumed run's `journaledOk` fully covers it. Confirm Discard actually
deletes a copy-kind journal (not just an upload-kind one). Run the
full desktop test suite (Electron/e2e via `electron-harness.js`'s
teardown per §62) at the end — report pass/fail counts, flag anything
not already a documented pre-existing failure.
