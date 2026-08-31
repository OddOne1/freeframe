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
const { normalize, normalizeIdList, DEFAULTS, finalizedAlgoFor } = require(
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
// §86 renamed this to liveChecksumAlgo, and the OLD name has to keep
// working: an existing settings.json has only the old key, which is
// indistinguishable from "never configured" unless it is read as a
// fallback. These are the same cases as before, under the new name.
check(normalize(null).liveChecksumAlgo === DEFAULTS.liveChecksumAlgo,
      "null settings fall back to the default algorithm");
check(normalize({}).liveChecksumAlgo === DEFAULTS.liveChecksumAlgo,
      "an empty object does too");
check(normalize({ liveChecksumAlgo: "md5" }).liveChecksumAlgo === "md5",
      "a stored algorithm survives");
check(normalize({ liveChecksumAlgo: "  sha1  " }).liveChecksumAlgo === "sha1",
      "…trimmed");
check(normalize({ liveChecksumAlgo: "" }).liveChecksumAlgo === DEFAULTS.liveChecksumAlgo,
      "an empty string is not an algorithm");
check(normalize({ liveChecksumAlgo: 42 }).liveChecksumAlgo === DEFAULTS.liveChecksumAlgo,
      "nor is a number");

// The upgrade path itself.
check(normalize({ defaultChecksumAlgo: "md5" }).liveChecksumAlgo === "md5",
      "\u00a786: a settings.json written under the OLD key upgrades rather than resetting");
check(normalize({ liveChecksumAlgo: "c4", defaultChecksumAlgo: "md5" }).liveChecksumAlgo === "c4",
      "…and the new key wins when both are present");

// The finalized tier. §103 replaced the boolean with a timing.
check(normalize({}).finalizedTiming === "off",
      "the finalized pass is off unless asked for — it is a full second read");
check(normalize({ finalizedTiming: "sometimes" }).finalizedTiming === "off",
      "…and an unrecognised timing falls back to off rather than being trusted");
check(normalize({ finalizedTiming: "during" }).finalizedTiming === "during",
      "…while each real mode survives a round trip");
// §103's migration. The old boolean meant "run the batched pass afterwards",
// so it maps to "after" — dropping it would silently switch off a
// verification step someone deliberately enabled.
check(normalize({ finalizedChecksumEnabled: true }).finalizedTiming === "after",
      "an existing settings.json with the OLD boolean on upgrades to after, not off");
check(normalize({ finalizedChecksumEnabled: false }).finalizedTiming === "off",
      "…and one with it off stays off");
check(normalize({ finalizedChecksumEnabled: "yes" }).finalizedTiming === "off",
      "…with only a real true counting, as before");
check(normalize({ finalizedChecksumEnabled: true, finalizedTiming: "during" }).finalizedTiming === "during",
      "…and once a real timing is stored, the legacy boolean stops mattering");
check(finalizedAlgoFor(normalize({ liveChecksumAlgo: "md5" })) === "md5",
      "an unset finalized algorithm follows live rather than a hardcoded default");
check(finalizedAlgoFor(normalize({ liveChecksumAlgo: "md5", finalizedChecksumAlgo: "sha1" })) === "sha1",
      "…and a chosen one is used");
check(finalizedAlgoFor(normalize({ defaultChecksumAlgo: "c4" })) === "c4",
      "…including through the old-key upgrade path");
check(Object.keys(normalize({ junk: true })).length === Object.keys(DEFAULTS).length,
  "unknown keys are dropped rather than written back out");

console.log("7. Hidden drives and projects (\u00a760a)");
check(Array.isArray(normalize(null).hiddenVolumeNames) && normalize(null).hiddenVolumeNames.length === 0,
  "nothing is hidden by default");
check(normalizeIdList(["A", "B"]).join() === "A,B", "a plain list survives");
check(normalizeIdList(["A", "A"]).length === 1,
  "duplicates collapse — hiding twice is not hiding harder");
check(normalizeIdList(["  Card A  "])[0] === "Card A", "entries are trimmed");
check(normalizeIdList(["", "   ", "A"]).join() === "A",
  "blanks are dropped: a stray empty string would sit in the list matching nothing");
check(normalizeIdList([1, null, {}, "A"]).join() === "A", "non-strings are dropped");
check(normalizeIdList("A").length === 0 && normalizeIdList(null).length === 0,
  "a non-array is not coerced into a one-item list");
check(normalize({ hiddenVolumeNames: ["A", "A", ""], hiddenProjectIds: ["p1"] }).hiddenVolumeNames.join() === "A"
  && normalize({ hiddenProjectIds: ["p1"] }).hiddenProjectIds.join() === "p1",
  "and normalize() applies the same rule to both lists");

console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
