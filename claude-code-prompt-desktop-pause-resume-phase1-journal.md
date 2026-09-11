# Claude Code prompt — desktop: Phase 1 of pause/resume — incremental per-job journal

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §87 — read it first, especially the "What already exists"
and "Phase 1" sections. This is Phase 1 ONLY — no resume UI, no
same-card matching, no journal-reading. This just makes a running job
leave a truthful, continuously-updated on-disk record, which every
later phase depends on. Do not run `npm test` or any e2e script other
than whatever scoped copy-engine test script already exists in
`scripts/` — see CLAUDE.md's standing rule about `apps/desktop`'s test
suite being unscoped and focus-stealing.

## Current state (confirmed, don't re-investigate)

- `jobs` (`main.js:31`, a `JobQueue`) is pure in-memory. Nothing about
  a running job touches disk until `onFinish` calls `writeJobLog(job)`
  (`:36`), and `writeJobLog()` itself (`:129`) explicitly refuses to
  write while `job.status` is `"queued"` or `"running"`.
- `runLeg()` (`copy-engine.js:275-339`) already computes everything a
  journal entry needs per file — `entry.sourceHash`,
  `entry.destinations[]` (each `{destRoot, path, hash, bytes, ok, error}`)
  — but only fires `onFileEvent({ type: "file-done", file: rel, ok: entry.ok })`
  at `:335`. The richer data (`sourceHash`, `destinations`) is dropped
  at that point and only resurfaces later, batched, in
  `n.files` at `:674-680` — too late for a live journal.
- That `onFileEvent` callback is consumed in `runCopyJob()`
  (`copy-engine.js:648-666`), whose `else` branch (`:665`) currently
  forwards `onProgress({ phase: ev.type, file: ev.file, ok: ev.ok, nodeIds })`
  for every event type it doesn't special-case, including `file-done`
  — same gap, the hash/destination data isn't in this payload either.
- `runCopyJob()`'s own caller, `main.js`'s `copy:start` handler
  (`:1092-1105`), is where `onProgress` is finally received in main
  process code — this is the natural place to write the journal, since
  `main.js` already owns `LOG_DIR()` and file-writing conventions.
- Naming/values state (§75's `claimedForPath`, §78's `dateOverride`,
  §80's per-card `values`) lives in the RENDERER (`index.html`), not
  in `main.js` or `copy-engine.js`. `copy:start`'s IPC payload already
  carries whatever rendered `mapRel`/naming config the job needs to
  run — check exactly what shape that payload takes before designing
  the journal's naming-state fields, don't assume.

## Build

1. `runLeg()` (`copy-engine.js:335`): change
   `onFileEvent({ type: "file-done", file: rel, ok: entry.ok })` to
   also include `sourceHash: entry.sourceHash` and
   `destinations: entry.destinations` (the full per-destination array
   already built a few lines above).
2. `runCopyJob()` (`copy-engine.js:665`): the `else` branch forwarding
   `ev.type` events to `onProgress` needs `file-done` events to carry
   the new `sourceHash`/`destinations` fields through instead of being
   dropped — either special-case `file-done` explicitly (matching how
   `"verifying"` already gets its own branch just above) or forward
   whatever extra fields are present on `ev`. Don't let other event
   types (`file-start`) accidentally pick up stale fields from this
   change.
3. New module, e.g. `main/job-journal.js`, following `settings.js`'s
   own read-tolerant/write-whole pattern (a missing or corrupt journal
   means "nothing to resume," not an error): `startJournal(job, meta)`
   — called once when a job starts, writes
   `<LOG_DIR()>/<job.id>.journal.json` with job identity (sourcePath,
   destPaths, algorithm, startedAt), whatever naming-state fields
   `copy:start`'s payload actually carries (see the point above — read
   the real payload shape first), and an empty `files: []`. Then
   `appendFileResult(jobId, fileResult)` — called on every `file-done`
   event, appends `{file, ok, sourceHash, destinations}` to that job's
   journal and rewrites the file (simple whole-file rewrite is fine at
   this scale — a card's file count is in the low thousands at most,
   not something needing true append-only I/O). Then
   `finishJournal(jobId)` — called from the existing `onFinish` path
   in `main.js` (`:36`, right where `writeJobLog` already fires),
   deletes or marks-complete the journal now that the real job log
   (§84 if it's landed, or the existing shape otherwise) is the
   permanent record — a completed job doesn't need a journal
   duplicating a real log forever.
4. Wire `startJournal`/`appendFileResult`/`finishJournal` into
   `main.js`'s `copy:start` handler (`:1081-1105`) and the `onFinish`
   callback (`:33-38`). `appendFileResult` should be called from
   inside the existing `onProgress: (p) => {...}` callback
   (`:1092-1105`) when `p.phase === "file-done"`, reading the
   `sourceHash`/`destinations` this build just threaded through.
5. If the job is cancelled or fails partway, still leave the journal
   on disk (don't call `finishJournal` for a failed/cancelled job) —
   an incomplete journal from a deliberate cancel is exactly the same
   shape of "how far did we get" data as one left by a crash, and
   later phases shouldn't need to special-case which one it was.

## Verification

Start a real (or scratch) multi-file copy job. While it's running,
read `<job.id>.journal.json` directly from the logs folder (find the
path via `LOG_DIR()`'s definition — `app.getPath("userData")/logs`) —
confirm it exists, grows a new `files[]` entry as each file completes,
and each entry carries a real `sourceHash` and `destinations` array
matching what the file actually verified as, not placeholder/empty
values. Let the job finish normally — confirm `finishJournal` runs and
the journal is gone/marked complete afterward, and the normal job log
(whatever `writeJobLog` produces) still writes correctly, unaffected
by this change. Cancel a job partway through — confirm its journal is
LEFT ON DISK with only the files that actually completed before
cancel, not the full file list. Kill the app process outright (not a
graceful quit) partway through a real copy, if you have a safe way to
do that in this environment, or otherwise reason through the code path
and confirm nothing in this journal-writing logic depends on a
graceful shutdown hook — the whole point is that it survives a crash
with no cleanup step at all.
