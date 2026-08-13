// Copy-job queue and concurrency scheduler (CLAUDE.md §18c).
//
// Until now the app ran exactly one job: `activeJob`, a single variable,
// with every entry point throwing "A copy is already running". This
// replaces that with a real queue.
//
// Deliberately electron-free and I/O-free, like copy-engine.js — the
// scheduler is where concurrency bugs hide, and they are only cheap to
// find if the scheduler can be driven directly from a test with fake
// jobs instead of real drives.
//
// ──────────────────────────────────────────────────────────────────────
// THE CONCURRENCY RULE
// ──────────────────────────────────────────────────────────────────────
//
// A job's mode declares **which neighbours it will tolerate**, not what
// it needs for itself. That framing is what makes the three modes
// consistent:
//
//   free        — tolerates any other job
//   source      — tolerates only jobs sharing its SOURCE volume
//   destination — tolerates only jobs sharing a DESTINATION volume
//
// Two jobs may run at the same time only if **each tolerates the other**:
//
//   canCoexist(a, b) = tolerates(a, b) && tolerates(b, a)
//
// and a queued job may start only if it can coexist with *every* running
// job.
//
// The symmetry matters, and so does the counter-intuitive consequence
// the spec calls out explicitly: two `source`-mode jobs that do NOT share
// a source will NOT run together — the second waits. That reads backwards
// if you assume the modes describe contention avoidance ("different
// drives, so no conflict, so let it run"). They don't. They describe what
// company a job is willing to keep, and a `source`-mode job's answer is
// "only jobs reading the same card as me".
//
// **No automatic contention override.** Two jobs hammering one physical
// disk is permitted if the chosen modes permit it. This was asked about
// directly and declined, so the scheduler never second-guesses a mode to
// protect throughput.
//
// KNOWN EXPOSURE, stated rather than silently handled: two concurrent
// jobs writing the SAME absolute destination path will interleave their
// writes and corrupt that file. Nothing here prevents it, because
// preventing it would be exactly the kind of override that was declined.
// It fails loudly rather than silently — the verify pass re-reads each
// destination and reports a hash mismatch — but it is a real edge and
// worth knowing about.

const MODES = new Set(["free", "source", "destination"]);

/** Does `a` tolerate running alongside `b`? */
function tolerates(a, b) {
  switch (a.mode) {
    case "free":
      return true;
    case "source":
      return Boolean(a.sourceKey) && a.sourceKey === b.sourceKey;
    case "destination":
      return (a.destKeys || []).some((k) => (b.destKeys || []).includes(k));
    default:
      // An unknown mode is treated as the most restrictive option rather
      // than the most permissive: a typo should queue a job, not grant it
      // free rein over the disk.
      return false;
  }
}

function canCoexist(a, b) {
  return tolerates(a, b) && tolerates(b, a);
}

function normalizeMode(mode) {
  return MODES.has(mode) ? mode : "free";
}

class JobQueue {
  /**
   * @param {object} opts
   * @param {(job) => Promise<any>} opts.run    Executes one job.
   * @param {() => void} [opts.onChange]        Fired on any state change.
   * @param {(job) => void} [opts.onFinish]     Fired once a job settles.
   */
  constructor({ run, onChange = () => {}, onFinish = () => {} }) {
    this.run = run;
    this.onChange = onChange;
    // Writing the transfer log is main-process work (a filesystem write),
    // and this class stays I/O-free so the scheduler remains testable with
    // fake jobs. So it hands the finished job back out instead.
    this.onFinish = onFinish;
    this.jobs = [];
    // Kept so the panel has history without growing without bound. The
    // running/queued jobs are never trimmed — only finished ones.
    this.maxHistory = 50;
  }

  get running() {
    return this.jobs.filter((j) => j.status === "running");
  }

  get queued() {
    return this.jobs.filter((j) => j.status === "queued");
  }

  /**
   * Add a job. Returns a promise that settles when the job finishes.
   *
   * The promise is deliberate: `copy:start` used to resolve with the
   * final summary, and a whole existing test suite awaits it. Queueing
   * shouldn't change that contract — a caller that doesn't care about
   * the queue still just awaits its job.
   */
  add(spec) {
    const job = {
      id: spec.id,
      kind: spec.kind || "copy",
      mode: normalizeMode(spec.mode),
      status: "queued",
      label: spec.label || "Copy",
      sourceKey: spec.sourceKey || null,
      destKeys: spec.destKeys || [],
      sourceLabel: spec.sourceLabel || "",
      destLabels: spec.destLabels || [],
      // Real filesystem paths, kept apart from destLabels (basenames, for
      // display) and destKeys (volume keys, for scheduling). The log
      // writer needs actual paths to drop a copy beside the footage.
      destPaths: spec.destPaths || [],
      payload: spec.payload,
      progress: null,
      summary: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      logPath: null,
      _cancel: null,
    };

    const settled = new Promise((resolve, reject) => {
      job._resolve = resolve;
      job._reject = reject;
    });
    job._promise = settled;

    this.jobs.push(job);
    this.onChange();
    this._schedule();
    return { job, settled };
  }

  cancel(id) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return false;

    if (job.status === "queued") {
      // Never started, so there is nothing to unwind — it just leaves.
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job._resolve({ cancelled: true, neverStarted: true });
      this.onChange();
      this._schedule();
      return true;
    }
    if (job.status === "running" && job._cancel) {
      job._cancel();
      return true;
    }
    return false;
  }

  cancelAll() {
    for (const j of [...this.queued, ...this.running]) this.cancel(j.id);
  }

  /** Live progress from a running job, forwarded to the panel. */
  updateProgress(id, progress) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || job.status !== "running") return;
    job.progress = { ...(job.progress || {}), ...progress };
    this.onChange();
  }

  /**
   * Start whatever can legally start.
   *
   * Work-conserving: a later queued job may start while an earlier one
   * waits, if the earlier one is blocked and the later one isn't. The
   * alternative — strict head-of-line FIFO — would leave the disk idle
   * because job #1 happens to be incompatible with something running.
   *
   * The cost is that a job CAN be starved while incompatible jobs keep
   * arriving and finishing. Accepted deliberately: the queue is
   * user-driven and short, and the panel shows a job sitting in "Queued"
   * so it's visible rather than mysterious.
   */
  _schedule() {
    for (const job of this.queued) {
      const blockers = this.running.filter((r) => !canCoexist(job, r));
      if (blockers.length === 0) this._start(job);
    }
  }

  _start(job) {
    job.status = "running";
    job.startedAt = Date.now();
    job.progress = { phase: "starting" };
    this.onChange();

    // Not awaited: _schedule() may start several jobs in one pass, and
    // awaiting here would serialize exactly what this class exists to
    // stop serializing.
    Promise.resolve()
      .then(() => this.run(job))
      .then(
        (summary) => this._finish(job, { summary }),
        (err) => this._finish(job, { error: err }),
      );
  }

  _finish(job, { summary, error }) {
    if (job.status !== "running") return;
    job.finishedAt = Date.now();
    job.summary = summary || null;
    job._cancel = null;

    if (error) {
      job.status = "failed";
      job.error = String(error?.message || error);
      // Rejecting would make an unhandled rejection out of every job
      // nobody explicitly awaited. The caller that cares sees the error
      // on the job; the panel shows the row in its failed state.
      job._resolve({ error: job.error, failed: true });
    } else if (summary && summary.cancelled) {
      job.status = "cancelled";
      job._resolve(summary);
    } else {
      job.status = "done";
      job._resolve(summary);
    }

    this._trimHistory();
    this.onChange();
    this._schedule();

    // After onChange, so the row is already showing its final state — the
    // log is an artefact of the job, not a step the user waits on. A
    // failure to write it must never change the job's own outcome.
    try { this.onFinish(job); } catch { /* logging is never load-bearing */ }
  }

  _trimHistory() {
    const finished = this.jobs.filter((j) => j.status !== "running" && j.status !== "queued");
    if (finished.length <= this.maxHistory) return;
    const drop = new Set(
      finished
        .sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0))
        .slice(0, finished.length - this.maxHistory)
        .map((j) => j.id),
    );
    this.jobs = this.jobs.filter((j) => !drop.has(j.id));
  }

  /** Serializable view for the renderer — no functions, no promises. */
  snapshot() {
    return this.jobs.map((j) => ({
      id: j.id,
      kind: j.kind,
      mode: j.mode,
      status: j.status,
      label: j.label,
      sourceLabel: j.sourceLabel,
      destLabels: j.destLabels,
      progress: j.progress,
      summary: j.summary,
      error: j.error,
      createdAt: j.createdAt,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      logPath: j.logPath,
      // Why a queued job is waiting, so the panel can say so rather than
      // showing an unexplained "Queued" forever.
      blockedBy: j.status === "queued"
        ? this.running.filter((r) => !canCoexist(j, r)).map((r) => r.label)
        : [],
    }));
  }
}

module.exports = { JobQueue, canCoexist, tolerates, normalizeMode, MODES };
