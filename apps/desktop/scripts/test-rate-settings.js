#!/usr/bin/env node
// Transfer speed/ETA and the settings store (CLAUDE.md §58).
//
// Both are pure modules on purpose — rate.js does no I/O and settings.js's
// normalisation is separable from its file access — so the arithmetic and
// the validation can be driven directly instead of through a real copy.
//
// Run: node scripts/test-rate-settings.js
const assert = require("node:assert");
const path = require("node:path");
const { RateTracker, MIN_SPAN_MS, WINDOW_MS } = require(
  path.join(__dirname, "..", "src", "main", "rate.js"),
);
const { normalize, DEFAULTS } = require(
  path.join(__dirname, "..", "src", "main", "settings.js"),
);

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const near = (a, b, tol) => typeof a === "number" && Math.abs(a - b) <= tol;

/** Drives the tracker on a controlled clock — a test that slept for real
 *  would take a minute and still be timing-dependent. */
function withClock(fn) {
  const realNow = Date.now;
  let t = 1_000_000;
  Date.now = () => t;
  try {
    return fn({ advance: (ms) => { t += ms; } });
  } finally {
    Date.now = realNow;
  }
}

console.log("1. Speed");
withClock(({ advance }) => {
  const r = new RateTracker();

  const first = r.update("j", 0, 1000);
  check(first.speed === null && first.eta === null,
    "one sample says nothing — a rate needs two points");

  advance(100);
  const tooSoon = r.update("j", 10 * 1024 * 1024, 1000);
  check(tooSoon.speed === null,
    "a span under the floor says nothing",
    `${MIN_SPAN_MS}ms floor: 100ms apart would turn rounding into GB/s`);

  advance(900); // 1000ms total, 10 MB moved
  const out = r.update("j", 10 * 1024 * 1024, 100 * 1024 * 1024);
  check(near(out.speed, 10 * 1024 * 1024, 1024), "10 MB in 1s → ~10 MB/s");
  check(near(out.eta, 9, 0.2), "90 MB left at 10 MB/s → ~9s");
});

console.log("2. It follows the recent window, not the whole job");
withClock(({ advance }) => {
  const r = new RateTracker();
  let bytes = 0;
  r.update("j", bytes, null);
  // A fast opening burst: 100 MB/s for 4 seconds.
  for (let i = 0; i < 4; i++) { advance(1000); bytes += 100 * 1024 * 1024; r.update("j", bytes, null); }
  const fast = r.update("j", bytes, null);
  check(near(fast.speed, 100 * 1024 * 1024, 5 * 1024 * 1024), "reports the burst while it lasts");

  // Then it collapses to 1 MB/s for longer than the window.
  for (let i = 0; i < 8; i++) { advance(1000); bytes += 1024 * 1024; r.update("j", bytes, null); }
  const slow = r.update("j", bytes, null);
  check(near(slow.speed, 1024 * 1024, 512 * 1024),
    "follows the collapse instead of averaging the burst in",
    `${WINDOW_MS}ms window`);
});

console.log("3. A stall, and coming back from one");
withClock(({ advance }) => {
  const r = new RateTracker();
  r.update("j", 0, 100);
  advance(1000);
  r.update("j", 50, 100);

  // Nothing moves for a while — ticks keep arriving with the same count.
  for (let i = 0; i < 6; i++) { advance(1000); r.update("j", 50, 100); }
  const stalled = r.update("j", 50, 100);
  check(stalled.speed === 0, "a stall reports zero, not the pre-stall rate");
  check(stalled.eta === null,
    "and no ETA — 'infinity remaining' is worse than saying nothing");

  // Resuming: the stalled samples age out of the window rather than
  // dragging the figure down for the rest of the job.
  let bytes = 50;
  for (let i = 0; i < 8; i++) { advance(1000); bytes += 10; r.update("j", bytes, 1000); }
  const resumed = r.update("j", bytes, 1000);
  check(near(resumed.speed, 10, 2), "recovers to the real post-resume rate");
});

console.log("4. Guards");
withClock(({ advance }) => {
  const r = new RateTracker();
  check(r.update("j", undefined, 100).speed === null, "a tick with no byte count says nothing");
  check(r.update("j", NaN, 100).speed === null, "and neither does a NaN");

  // A counter that went backwards means a different transfer reusing the
  // id. Suppressing the negative is not enough — the samples before it are
  // from a different job and must not anchor the next figure either.
  r.update("k", 5000, 1_000_000);
  advance(1000);
  const back = r.update("k", 10, 1_000_000);
  check(back.speed === null, "a counter going backwards reports nothing at that moment");
  advance(1000);
  r.update("k", 20, 1_000_000);
  advance(1000);
  const afterReset = r.update("k", 30, 1_000_000);
  check(near(afterReset.speed, 10, 3),
    "and the figure afterwards describes the NEW run, not a stale high-water mark",
    `got ${afterReset.speed}`);

  // Two jobs interleaving, neither going backwards — a shared series would
  // read one job's bytes as the other's progress.
  const t = new RateTracker();
  t.update("fast", 0, 1e9);
  t.update("slow", 0, 1e9);
  for (let i = 1; i <= 4; i++) {
    advance(1000);
    t.update("fast", i * 100 * 1024 * 1024, 1e9);
    t.update("slow", i * 1024 * 1024, 1e9);
  }
  const slow = t.update("slow", 4 * 1024 * 1024, 1e9);
  const fast = t.update("fast", 400 * 1024 * 1024, 1e9);
  check(near(slow.speed, 1024 * 1024, 512 * 1024),
    "rates are per job — the slow one is not inflated by the fast one",
    `got ${slow.speed}`);
  check(near(fast.speed, 100 * 1024 * 1024, 20 * 1024 * 1024),
    "and the fast one is not dragged down by the slow one",
    `got ${fast.speed}`);

  const f = new RateTracker();
  f.update("gone", 0, 10);
  f.forget("gone");
  check(f.samples.has("gone") === false, "a finished job's samples are dropped");
});

console.log("5. No ETA without a total");
withClock(({ advance }) => {
  const r = new RateTracker();
  r.update("j", 0, null);
  advance(1000);
  const out = r.update("j", 1000, null);
  check(out.speed > 0 && out.eta === null,
    "speed alone when the total is unknown — an ETA would be invented");

  advance(1000);
  const done = r.update("j", 2000, 2000);
  check(done.eta === null, "and none once nothing is left to copy");
});

console.log("6. Settings normalisation");
check(normalize(null).defaultChecksumAlgo === DEFAULTS.defaultChecksumAlgo,
  "no file means defaults, not an empty object");
check(normalize({}).defaultChecksumAlgo === DEFAULTS.defaultChecksumAlgo,
  "an empty object means defaults too");
check(normalize({ defaultChecksumAlgo: "md5" }).defaultChecksumAlgo === "md5",
  "a stored value is kept");
check(normalize({ defaultChecksumAlgo: "  sha1  " }).defaultChecksumAlgo === "sha1",
  "and trimmed");
check(normalize({ defaultChecksumAlgo: "" }).defaultChecksumAlgo === DEFAULTS.defaultChecksumAlgo,
  "a blank value falls back rather than leaving the picker with nothing");
check(normalize({ defaultChecksumAlgo: 42 }).defaultChecksumAlgo === DEFAULTS.defaultChecksumAlgo,
  "so does a non-string");
check(Object.keys(normalize({ junk: true })).length === Object.keys(DEFAULTS).length,
  "unknown keys are dropped rather than written back out");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
