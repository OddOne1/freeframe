// Transfer speed and ETA (CLAUDE.md §58).
//
// Deliberately a rolling window rather than the job's overall average.
// A whole-job average keeps reporting the speed of a fast first minute
// long after the transfer has slowed, and — worse — reports a healthy
// number while a stalled job moves nothing at all. The window is short
// enough to follow reality and long enough that one slow tick does not
// make the figure jump around.
//
// Pure and dependency-free so it can be tested without Electron.

/** Samples older than this are dropped, so a pause washes out of the
 *  figure within a few seconds of resuming rather than dragging the
 *  average down for the rest of the job. */
const WINDOW_MS = 5000;
/** Below this the two endpoints are too close together for the division
 *  to mean anything — a 20ms span turns a rounding difference into
 *  gigabytes per second. */
const MIN_SPAN_MS = 750;

class RateTracker {
  constructor() {
    /** @type {Map<string, {t:number, bytes:number}[]>} */
    this.samples = new Map();
  }

  /**
   * Record a progress tick and return `{ speed, eta }`, either of which is
   * null when there is not yet enough to say.
   *
   * `speed` is bytes/sec. `eta` is seconds remaining, and only when the
   * total is known and the rate is non-zero — an ETA computed from a
   * stalled transfer is Infinity, which is worse than showing nothing.
   */
  update(id, copiedBytes, totalBytes) {
    if (typeof copiedBytes !== "number" || !Number.isFinite(copiedBytes)) {
      return { speed: null, eta: null };
    }
    const now = Date.now();
    const series = this.samples.get(id) || [];

    // A counter that went backwards means this is a different transfer
    // reusing the id. Starting over beats reporting a negative rate.
    if (series.length && copiedBytes < series[series.length - 1].bytes) {
      series.length = 0;
    }

    series.push({ t: now, bytes: copiedBytes });
    while (series.length > 2 && now - series[0].t > WINDOW_MS) series.shift();
    this.samples.set(id, series);

    const first = series[0];
    const last = series[series.length - 1];
    const span = last.t - first.t;
    if (series.length < 2 || span < MIN_SPAN_MS) return { speed: null, eta: null };

    const speed = ((last.bytes - first.bytes) * 1000) / span;
    if (!Number.isFinite(speed) || speed < 0) return { speed: null, eta: null };

    let eta = null;
    if (typeof totalBytes === "number" && totalBytes > copiedBytes && speed > 0) {
      eta = (totalBytes - copiedBytes) / speed;
    }
    return { speed, eta };
  }

  /** Called when a job ends, so a long session does not accumulate a
   *  sample array per job it has already forgotten about. */
  forget(id) {
    this.samples.delete(id);
  }
}

module.exports = { RateTracker, WINDOW_MS, MIN_SPAN_MS };
