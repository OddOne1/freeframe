// App settings (CLAUDE.md §58) — local only.
//
// Its own settings.json rather than a field on one of the existing
// preferences-shaped files, deliberately: naming-presets.json is a preset
// store with its own schema and normalisation, and recent-folders.json and
// display-names.json are keyed caches that get pruned. App settings have a
// different lifetime from all three — folding them in would mean a preset
// reset, or a cache prune, could take the app's settings with it.
//
// Same directory and same read-tolerantly/write-whole pattern the others
// use. A missing or corrupt file is not an error: it means defaults.

const fsp = require("node:fs/promises");
const path = require("node:path");
const { app } = require("electron");

/** Mirrors the picker's own fallback in index.html. Defined here too, so a
 *  fresh install and a saved-then-cleared setting land in the same place. */
const DEFAULTS = Object.freeze({
  // §86 — two tiers. `live` is hashed while the bytes stream past during
  // the copy; `finalized` is an optional SECOND full read of the source and
  // every destination afterwards, with its own algorithm.
  liveChecksumAlgo: "xxhash64",
  // §103 — WHEN the finalized pass runs, not whether it checks something
  // different. All three modes do the same full source+destination
  // re-read; they differ only in timing.
  //
  //   "off"    — never. Today's default, unchanged.
  //   "after"  — one separate phase once every file has copied.
  //   "during" — each file re-checked immediately after its own copy,
  //              before the next file starts. Slower in wall clock: the
  //              two read passes no longer overlap with anything.
  //
  // Off by default: it is a genuine second read of everything, so it costs
  // real time and real disk wear. Opting in has to be deliberate.
  finalizedTiming: "off",
  // Empty means "whatever live resolves to" — so a user who turns the
  // toggle on without touching the dropdown gets a coherent pass rather
  // than a hardcoded second algorithm they never chose.
  finalizedChecksumAlgo: "",
  // §60a. Drives are matched by NAME because nothing better exists:
  // deviceId changes across reboots and replugs and is empty for network
  // volumes, and mountPoint is derived from the name anyway. The known
  // cost is that two drives sharing a name hide together — stated rather
  // than papered over, since there is no unique id to reach for.
  hiddenVolumeNames: [],
  // Projects DO have a real stable id, so they use it.
  hiddenProjectIds: [],
  // §72 — when "today" starts for the daily overview. "HH:MM", 24-hour.
  // 00:00 means no shift, i.e. plain calendar days, which is what someone
  // who never opens this setting gets.
  dayBoundary: "00:00",
});

/** "HH:MM", 24-hour, or the default. A malformed value here would shift
 *  every job into the wrong day silently, so anything unparseable falls
 *  back rather than being coerced into something plausible. */
function normalizeDayBoundary(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? "").trim());
  if (!m) return DEFAULTS.dayBoundary;
  const h = Number(m[1]), min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return DEFAULTS.dayBoundary;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** §103 — "off" | "after" | "during", with the pre-§103 boolean as the
 *  fallback so an existing settings.json upgrades rather than resetting. */
const FINALIZED_TIMINGS = new Set(["off", "after", "during"]);
function normalizeFinalizedTiming(raw, legacyEnabled) {
  if (typeof raw === "string" && FINALIZED_TIMINGS.has(raw)) return raw;
  return legacyEnabled === true ? "after" : "off";
}

/** Strings only, trimmed, de-duplicated, empties dropped. A malformed
 *  entry here would silently hide nothing or — worse with a stray "" —
 *  match nothing while looking like it should. */
function normalizeIdList(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t) seen.add(t);
  }
  return Array.from(seen);
}

/**
 * §86 — the algorithm the finalized pass actually runs with.
 *
 * One function rather than `s.finalizedChecksumAlgo || s.liveChecksumAlgo`
 * repeated at each reader: the engine, the Settings dropdown and the log
 * all have to name the same algorithm, and three copies of that fallback
 * is how one of them ends up reporting sha1 while another hashes xxhash64.
 */
function finalizedAlgoFor(s) {
  return (s && s.finalizedChecksumAlgo) || (s && s.liveChecksumAlgo) || DEFAULTS.liveChecksumAlgo;
}

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    // §86 — `defaultChecksumAlgo` is the pre-two-tier name for this. Read
    // as a fallback rather than dropped, or an existing settings.json would
    // silently reset to xxHash64 the first time this ships: the field would
    // simply be absent under its new name, which is indistinguishable from
    // "never configured".
    const algo = raw.liveChecksumAlgo ?? raw.defaultChecksumAlgo;
    // Validated against the caller's list rather than trusted: a stale
    // algorithm id from an older build must not leave the picker with
    // nothing selected.
    if (typeof algo === "string" && algo.trim()) out.liveChecksumAlgo = algo.trim();
    // §103 — a valid new value wins; failing that, the OLD boolean maps to
    // "after", which is exactly what it used to do. Anyone who already had
    // the finalized pass on keeps it, doing the same thing, without being
    // asked again — the alternative is silently turning off a verification
    // step someone deliberately enabled.
    out.finalizedTiming = normalizeFinalizedTiming(raw.finalizedTiming, raw.finalizedChecksumEnabled);
    const fin = raw.finalizedChecksumAlgo;
    if (typeof fin === "string" && fin.trim()) out.finalizedChecksumAlgo = fin.trim();
    out.dayBoundary = normalizeDayBoundary(raw.dayBoundary);
    out.hiddenVolumeNames = normalizeIdList(raw.hiddenVolumeNames);
    out.hiddenProjectIds = normalizeIdList(raw.hiddenProjectIds);
  }
  return out;
}

async function readSettings() {
  try {
    const text = await fsp.readFile(settingsFile(), "utf8");
    return normalize(JSON.parse(text));
  } catch {
    // Missing, unreadable or malformed — all mean "no preferences yet".
    return { ...DEFAULTS };
  }
}

/** Writes the whole file. Partial updates are merged over what is stored,
 *  so a caller sending one field cannot blank the others. */
async function writeSettings(patch) {
  const current = await readSettings();
  const next = normalize({ ...current, ...(patch || {}) });
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = { readSettings, writeSettings, normalize, finalizedAlgoFor, normalizeFinalizedTiming, normalizeIdList, normalizeDayBoundary, DEFAULTS, settingsFile };
