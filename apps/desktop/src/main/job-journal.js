// Per-job journal (CLAUDE.md §87, Phase 1) — the live on-disk record of a
// job in progress.
//
// The premise this exists to make true: "the log is written live". It was
// not. writeJobLog() refuses to write while a job is queued or running, and
// JobQueue is pure in-memory state — so a crash, a pulled cable or a
// force-quit lost every byte of knowledge about the job that was running.
// There was nothing to resume FROM.
//
// This is Phase 1 only: it WRITES the record. Nothing reads it back yet.
// Resume detection, same-card matching and the resume UI are later phases,
// and all of them depend on this file being truthful.
//
// Same read-tolerantly / write-whole pattern as settings.js. A missing or
// corrupt journal means "nothing to resume", never an error — a journal
// that could fail a job would be worse than no journal at all.
//
// WHOLE-FILE REWRITE PER FILE, deliberately. A card's file count is in the
// low thousands, and each entry is small; true append-only I/O would buy
// microseconds and cost the ability to keep the file valid JSON at every
// instant, which is the entire point of something read after a crash.

const fsp = require("node:fs/promises");
const path = require("node:path");

/** Bump when the shape changes in a way a reader must notice. */
const JOURNAL_VERSION = 1;

const journalFile = (dir, jobId) => path.join(dir, `${jobId}.journal.json`);

/**
 * In-memory mirror of what is on disk, so appending one file result does
 * not require reading and re-parsing the whole journal each time.
 *
 * Keyed by job id. A job missing from here — the app restarted since it
 * started — simply cannot be appended to, and says so by doing nothing
 * rather than by resurrecting a partial journal from disk and writing a
 * second, conflicting history into it.
 */
const open = new Map();

/**
 * Everything a resumed job needs that is NOT re-derivable after a restart.
 *
 * The per-file results are the obvious half. This is the other half, and
 * it is the reason a resume cannot just re-run the job: the naming values,
 * the claimed card number and any date override live in the RENDERER's
 * memory (§75, §78, §80). After a crash they are gone. A "resumed" job
 * that re-derived them would rename the remaining files inconsistently
 * with the ones already sitting on the destination — a worse outcome than
 * not resuming, because it looks like it worked.
 */
function namingSnapshot(naming) {
  if (!naming || typeof naming !== "object") return null;
  return {
    presetId: naming.presetId ?? null,
    folderTemplate: naming.folderTemplate ?? "",
    fileTemplate: naming.fileTemplate ?? "",
    // The rendered values for THIS card (§80), not the preset's schema.
    values: naming.values && typeof naming.values === "object" ? { ...naming.values } : {},
    disabledFields: Array.isArray(naming.disabledFields) ? [...naming.disabledFields] : [],
    // §75 — the number this job claimed. Re-deriving it would take the
    // NEXT one and renumber the card mid-way.
    sourceCounter: naming.sourceCounter ?? null,
    // §78 — null means "the live clock", which after a crash is a
    // different clock. Recorded either way.
    dateOverride: naming.dateOverride ?? null,
    autoSuffix: naming.autoSuffix ?? null,
    filters: naming.filters ?? null,
  };
}

/**
 * Open a journal for a job about to run. Best-effort: a journal that
 * cannot be written must not stop the copy.
 */
async function startJournal(dir, job, meta = {}) {
  const doc = {
    freeframeJobJournal: JOURNAL_VERSION,
    status: "running",
    jobId: job.id,
    label: job.label ?? null,
    kind: job.kind ?? null,
    sourcePath: job.sourcePath ?? null,
    sourceFiles: meta.sourceFiles ?? null,
    destPaths: Array.isArray(job.destPaths) ? [...job.destPaths] : [],
    algorithm: meta.algorithm ?? null,
    finalizedAlgorithm: meta.finalizedAlgorithm ?? null,
    // §97A — where an upload was going. A resume has to send the files to
    // the same project, and the job that would have known is gone.
    projectId: meta.projectId ?? null,
    folderId: meta.folderId ?? null,
    startedAt: new Date().toISOString(),
    naming: namingSnapshot(meta.naming),
    files: [],
  };
  open.set(job.id, { dir, doc, writing: Promise.resolve() });
  await flush(job.id);
  return doc;
}

/**
 * Serialized per job, and that is load-bearing rather than tidy.
 *
 * runCopyJob runs a job's legs concurrently (Promise.all over the ready
 * groups), so two file-done events for ONE job can arrive overlapped. Two
 * un-serialized whole-file writes to the same path can interleave and
 * leave truncated or doubled JSON — in the one file whose entire purpose
 * is being readable after an unclean stop.
 *
 * The chain also means the caller can fire and forget: appends land in
 * order without the copy ever waiting on a log write.
 */
function flush(jobId) {
  const entry = open.get(jobId);
  if (!entry) return Promise.resolve();
  entry.writing = entry.writing.then(async () => {
    try {
      await fsp.mkdir(entry.dir, { recursive: true });
      // Written whole, then renamed into place: a reader that opens the
      // file while a write is partway through would otherwise see half a
      // document, and "corrupt" and "nothing to resume" are the same
      // outcome for a journal — losing a good one to a torn write is not.
      const target = journalFile(entry.dir, jobId);
      const tmp = `${target}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(entry.doc, null, 2), "utf8");
      await fsp.rename(tmp, target);
    } catch {
      // A full or read-only logs directory must not turn a working copy
      // into a failed one. The consequence is only that this job cannot be
      // resumed, which is exactly where we were before this existed.
    }
  });
  return entry.writing;
}

/**
 * Record one finished file. Called per `file-done`, so the file on disk is
 * never more than one file behind reality.
 *
 * `ok` is kept as the engine reported it, alongside the hashes rather than
 * derived from them: a later phase deciding what to skip should be reading
 * the same verdict the copy made, not re-adjudicating it.
 */
async function appendFileResult(jobId, result) {
  const entry = open.get(jobId);
  if (!entry || !result || typeof result.file !== "string") return;
  const row = {
    file: result.file,
    ok: result.ok === true,
    bytes: result.bytes ?? null,
    sourceHash: result.sourceHash ?? null,
    destinations: Array.isArray(result.destinations)
      ? result.destinations.map((d) => ({
          destRoot: d.destRoot ?? null,
          path: d.path ?? null,
          hash: d.hash ?? null,
          bytes: d.bytes ?? null,
          ok: d.ok === true,
          error: d.error ?? null,
        }))
      : [],
    error: result.error ?? null,
    at: new Date().toISOString(),
  };
  // §97A — an upload's per-file identity, and the only thing a resume can
  // ask the server about. Added ONLY when present, so a local copy's rows
  // do not gain two permanently-null columns describing a concept they
  // have nothing to do with.
  if (result.assetId) row.assetId = result.assetId;
  if (result.versionId) row.versionId = result.versionId;
  entry.doc.files.push(row);
  return flush(jobId);
}

/**
 * The job completed, so the real job log is now the permanent record and
 * this duplicate can go.
 *
 * ONLY for a job that actually finished. A cancelled or failed job keeps
 * its journal: an incomplete journal from a deliberate cancel is the same
 * "how far did we get" data as one left by a crash, and a later phase
 * should not have to tell those apart to use it.
 */
async function finishJournal(dir, jobId) {
  // Let any in-flight append land before removing the file, or a rename
  // could recreate the journal microseconds after it was deleted.
  const entry = open.get(jobId);
  if (entry) { try { await entry.writing; } catch { /* already swallowed */ } }
  open.delete(jobId);
  try {
    await fsp.rm(journalFile(dir, jobId), { force: true });
  } catch {
    // Nothing to do — a leftover journal is inert until something reads
    // it, and Phase 2 will find a completed job's real log beside it.
  }
}

/**
 * §87 Phase 2 — the user looked at this interrupted job and said no.
 *
 * Distinct from finishJournal, which means "the job completed and the real
 * log is now the record", and from releaseJournal, which only drops the
 * in-memory handle and leaves the file exactly where it was. Neither one
 * says "this will never be resumed", and without a third verb a declined
 * journal would prompt again at every launch forever.
 *
 * Best-effort: a journal that will not delete means the prompt may
 * reappear, which is a nuisance, not a failure.
 */
async function discardJournal(dir, jobId) {
  open.delete(jobId);
  try {
    await fsp.rm(journalFile(dir, jobId), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Abandon the in-memory handle without touching the file on disk. */
function releaseJournal(jobId) {
  open.delete(jobId);
}

/** Read one back. Phase 2's entry point; unused today, so it is the one
 *  function here with no caller — kept because writing a reader against a
 *  shape defined in another file is how the two drift. */
async function readJournal(dir, jobId) {
  try {
    const doc = JSON.parse(await fsp.readFile(journalFile(dir, jobId), "utf8"));
    return doc && doc.freeframeJobJournal ? doc : null;
  } catch {
    return null;
  }
}

/**
 * §97A — the assets a journal claims were uploaded successfully.
 *
 * `ok: true` AND an assetId: a row that failed, or one from a local copy
 * leg, is not something the server has. Deduplicated, because a resumed
 * job that was itself resumed could name the same asset twice.
 */
function uploadedAssetIds(doc) {
  if (!doc || !Array.isArray(doc.files)) return [];
  return [...new Set(doc.files.filter((f) => f.ok === true && f.assetId).map((f) => f.assetId))];
}

module.exports = {
  JOURNAL_VERSION,
  journalFile,
  namingSnapshot,
  startJournal,
  appendFileResult,
  finishJournal,
  discardJournal,
  releaseJournal,
  readJournal,
  uploadedAssetIds,
};
