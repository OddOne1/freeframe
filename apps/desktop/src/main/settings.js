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
});

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

module.exports = { readSettings, writeSettings, normalize, DEFAULTS, settingsFile };
