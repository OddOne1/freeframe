# Claude Code prompt — desktop: crash-resume duplicate-upload prevention (§97 part A)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §97 — read it first, including the "disagreement with the
user's proposed design" section, which explains why this is journal-
based rather than a duplicate server log. This is part A only (crash-
resume). Part B (general dedup across independent jobs, needs a DB
migration) is explicitly NOT in scope for this build — do not add a
content-hash column, do not touch `apps/api/models/asset.py`.

This build touches both `apps/desktop` and `apps/api`. Confirm which
repo/service each file belongs to before editing — do not assume.

## Current state (confirmed, don't re-investigate)

- `runUpload()` (`apps/desktop/src/main/main.js:936`) and `uploadFile()`
  (`apps/desktop/src/main/freeframe.js:364`) are the FreeFrame-upload
  job path, entirely separate from `runCopyJob`/`runLeg`
  (`copy-engine.js`). `uploadFile()` calls `POST /upload/initiate`
  unconditionally per file — no existing-asset check anywhere.
- `job-journal.js` (§87 Phase 1) is a working, crash-surviving,
  per-job, per-file JSON journal — `startJournal()`,
  `appendFileResult()`, `finishJournal()`, `releaseJournal()`,
  `readJournal()` (this last one has no caller yet — you are the first
  reader). It currently records `{ file, ok, bytes, sourceHash,
  destinations: [...], error, at }` per file. It is ONLY wired into the
  local-copy path today (`runCopyJob`) — `runUpload()` never calls any
  of these functions.
- `MediaFile` (`apps/api/models/asset.py:100-154`) has no hash column —
  do not add one, that's part B.
- `/upload/initiate` (server-side, find its router — likely
  `apps/api/routers/assets.py` or a dedicated upload router, confirm by
  reading before assuming) returns `{ s3_key, upload_id, asset_id,
  version_id }` per `freeframe.js`'s destructuring at the init call.

## Build

1. **Journal shape**: extend `appendFileResult()`'s accepted `result`
   object (or add a new function, your call — state which and why in
   the build report) to also carry `assetId`/`versionId` for
   upload-kind jobs. Keep the local-copy shape unaffected — a copy
   job's entries should not suddenly carry null `assetId` fields
   cluttering the JSON; only upload jobs write them.
2. **Wire the journal into `runUpload()`**: call `startJournal()`
   before the per-file loop, `appendFileResult()` after each file's
   `uploadFile()` call succeeds (recording its `assetId`/`versionId`),
   `finishJournal()` on a clean finish — mirror exactly how
   `runCopyJob` already does this (find and follow that call site,
   don't reinvent the sequencing).
3. **New server endpoint**: `POST /assets/check-existing` (or find a
   more idiomatic name/location by looking at existing router
   conventions in `apps/api/routers/`) accepting a list of asset IDs,
   returning which still exist and haven't been deleted (respect the
   existing `deleted_at` soft-delete pattern visible on `Asset` —
   `deleted_at IS NULL` means still live). Keep this endpoint minimal:
   input validation, an `IN (...)` query, no new business logic.
4. **Resume path**: wherever §87 Phase 2's resume flow lives (or, if
   Phase 2 hasn't been built yet in this repo, check `git log`/CLAUDE.md
   for whether it landed — if it hasn't, build the minimal resume entry
   point needed to exercise this: on app start, or on the specific
   card being reinserted, check for a leftover journal via
   `readJournal()`; if it's an upload-kind job with `ok: true` entries
   carrying `assetId`s, call the new check-existing endpoint ONCE with
   all of them batched — not one call per file). Skip re-uploading only
   the files confirmed still present server-side; anything not
   confirmed (deleted, or the batch call itself failed) must be
   re-uploaded, not silently skipped — a resume must never trust the
   journal over the server.
5. **Full checksum pass after a resumed job's remaining files finish**:
   re-hash every file the journal claims `ok: true` for (not just the
   files re-uploaded in this resumed run — the full set, including the
   pre-crash portion that was never independently re-verified) and
   compare against `sourceHash` already in the journal. This step is
   local-only (hash the local source file, compare to the journal's
   recorded value) — it does not need a new server call. Decide and
   state in the build report: what happens on a mismatch? At minimum
   it must surface to the user as a discrepancy, not fail silently.
6. **Explicitly confirm and state in the build report**: a normal,
   non-resumed upload job is completely unaffected by this change —
   still uploads unconditionally, same as before. This build only adds
   behavior on the resume path.

## Verification

Start an upload job with several files. Force-kill the app mid-job
(comparable to how §87's crash-recovery testing was done, if that
pattern exists already — check for it) after at least one file has
fully uploaded. Restart, trigger resume. Confirm the already-uploaded
file is NOT re-uploaded (check the server/project asset list directly,
don't just trust the app's own report). Confirm files not yet uploaded
before the crash DO get uploaded. Confirm the final full-checksum pass
runs and correctly validates the pre-crash file(s) too, not just the
newly-uploaded ones. Then delete one of the pre-crash-uploaded assets
directly via the API/DB before triggering a second resume test (of a
different job) with that asset ID in its journal — confirm the
check-existing call catches the mismatch and the file gets re-uploaded
rather than silently skipped.
