# Claude Code prompt — desktop: §87 Phase 2 — resume-detection prompt for interrupted uploads

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §87, "Phase 2, now scoped and buildable" section — read it
first. Also skim §97A's section for how `resumeFrom`/`resumeJobId`
already work end to end — this build does NOT touch that machinery,
only detection, prompting, and wiring the existing `resumeJobId`
parameter. Do not run `npm test` or any e2e script other than
`node scripts/test-job-queue.js`.

Scope: **upload jobs only.** Local-copy resume-from-journal does not
exist and is explicitly out of scope — do not attempt to extend
`runCopyJob`/`runLeg` in this pass.

## Current state (confirmed, don't re-investigate)

- `interruptedUploadJournals()` (`main.js:918-931`) already returns
  every upload-kind journal still marked `"running"` on disk — this
  correctly covers BOTH a crash and a deliberate cancel, because
  `job-journal.js`'s `doc.status` is written once at `startJournal` and
  never updated afterward (confirmed by reading `job-journal.js` in
  full — there is no status-update function).
- `freeframe:interrupted-uploads` IPC (`main.js:933-946`) and
  `window.freeframe.interruptedUploads()` (`preload.js:187`) already
  expose this list to the renderer. Nothing in the renderer calls it —
  confirmed by grep, zero matches for `interruptedUploads` outside
  `preload.js`.
- `freeframe:upload`'s IPC handler (`main.js:948`) already accepts an
  optional `resumeJobId`; when present it reads that job's journal and
  threads it through as `resumeFrom`, which `runUpload` uses to skip
  files the server confirms it already has (§97A, shipped `bd469a6`,
  fully tested). `window.freeframe.freeframeUpload(sourcePath,
  projectId, folderId, sourceFiles, concurrencyMode, resumeJobId)`
  (`preload.js:183-184`) already passes it through. **This build only
  needs to populate that last argument on a "Resume" click — the
  resume logic itself is done.**
- No IPC exists to delete a specific journal file on demand.
  `journal.releaseJournal(jobId)` (`job-journal.js:200`) only drops the
  in-memory handle (the `open` Map), it does not touch the file on
  disk — confirmed by reading. `finishJournal` does delete the file,
  but only as part of a job completing cleanly. You need a new,
  narrowly-scoped function for "the user explicitly discarded this."

## Build

1. **New journal function**, `discardJournal(dir, jobId)` in
   `job-journal.js`: `fs.promises.rm` the specific `.journal.json`
   file, force-true (mirror `finishJournal`'s `fsp.rm(journalFile(dir,
   jobId), { force: true })`), best-effort (swallow errors — a journal
   that fails to delete just means the prompt might reappear, not a
   crash). Export it alongside the existing functions.
2. **New IPC**: `freeframe:discard-interrupted-upload` (or similar —
   match existing naming conventions), taking a `jobId`, calling the
   new `discardJournal`. Add the matching `preload.js` entry
   (`discardInterruptedUpload(jobId)` or similar).
3. **Detection trigger 1 — app launch**: on `mainWindow` ready (find
   the existing launch sequence in `main.js` — likely near where
   `createWindow` or similar runs), call `interruptedUploadJournals()`
   once and, if non-empty, send the list to the renderer (a new event,
   e.g. `send("freeframe:interrupted-uploads-found", docs)`, or just
   have the renderer call `interruptedUploads()` itself once on mount —
   your call, state which and why).
4. **Detection trigger 2 — source (re)selection**: wherever the
   renderer currently handles picking/selecting a source folder or
   file set for the FreeFrame tab (find this in `index.html` — look
   for wherever `sourcePath`/`sourceFiles` get set for an upload flow),
   after the source is set, call `interruptedUploads()` and check for
   an exact match: same `sourcePath` (or same `sourceFiles` set, order-
   independent) AND same `projectId` AND same `folderId` as the
   currently-selected destination project/folder. If the destination
   project isn't chosen yet at that point in the flow, match on source
   alone and re-check the project/folder once it is — state how you
   handled this ordering in the build report, don't guess silently.
5. **The prompt UI**: an explicit banner/dialog — "An interrupted
   upload was found for `<source label>` → `<project name>`. Resume
   it?" — with two actions: Resume and Discard (or "Start fresh").
   Resume calls `window.freeframe.freeframeUpload(...)` with
   `resumeJobId` set to the found journal's `jobId`. Discard calls the
   new discard IPC, then either does nothing further or offers to
   start a normal fresh job — your call, state which. Match the app's
   existing dialog/banner visual language rather than inventing new
   patterns — look at how other prompts in `index.html` are built
   (e.g. any existing confirm dialogs) before designing a new one.
6. If multiple interrupted-upload journals exist at once (user
   cancelled several different uploads before this build existed),
   decide and state in the build report: show them one at a time, or
   list all of them in one prompt. Don't silently handle only the
   first and drop the rest.

## Verification

Start an upload job with several files, big enough that cancelling
partway through is easy to time. Cancel it after a few files have
uploaded. Click Copy & Verify again for the exact same source and
project — confirm the resume prompt appears (trigger 2) rather than
silently starting a duplicate job. Click Resume — confirm via the
server (or the app's own upload count) that the already-uploaded files
are NOT re-sent, only the remaining ones. Quit and relaunch the app
with a leftover interrupted-upload journal still on disk (cancel a job,
don't touch it, quit) — confirm the prompt appears on launch (trigger
1). Click Discard on one — confirm the journal file is actually gone
from disk afterward (check `LOG_DIR()`) and that reselecting the same
source no longer prompts. Start and complete a normal upload with no
interruption at all — confirm no prompt ever appears and behavior is
unchanged from before this build.
