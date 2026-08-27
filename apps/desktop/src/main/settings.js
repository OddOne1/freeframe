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
  defaultChecksumAlgo: "xxhash64",
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

function settingsFile() {
  return path.join(app.getPath("userData"), "settings.json");
}

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === "object") {
    const algo = raw.defaultChecksumAlgo;
    // Validated against the caller's list rather than trusted: a stale
    // algorithm id from an older build must not leave the picker with
    // nothing selected.
    if (typeof algo === "string" && algo.trim()) out.defaultChecksumAlgo = algo.trim();
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

module.exports = { readSettings, writeSettings, normalize, normalizeIdList, normalizeDayBoundary, DEFAULTS, settingsFile };
