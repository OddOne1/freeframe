// §243 — dropping remembered folders that point into macOS's own volumes.
//
// Its own module, and pure apart from the predicate it is handed, for one
// reason: the interesting part is the SHAPE walk, and main.js cannot be
// required without Electron. Everything about *which* paths are system
// volumes lives in volumes.js and arrives here as `isSystemPath`.
//
// The recents file is `{ "<device mount point>": { source: [...],
// destination: [...] } }`, where a list entry is either a path string or a
// FreeFrame project selection `{ id, name }`.

/**
 * Remove every remembered entry that lies inside a system volume.
 *
 * Two shapes are pruned:
 *
 *  - a remembered PATH inside a system volume, and
 *  - a whole DEVICE whose own mount point is one. Recents are keyed by
 *    mount point, so a session from before this release could have filed
 *    folders under "/Volumes/Recovery" itself; that device's tile no
 *    longer exists, so neither should its history.
 *
 * Project selections are never filesystem paths and are left alone — a
 * `{ id, name }` is checked by nothing and kept as-is.
 *
 * A device left with no entries at all is dropped rather than kept as an
 * empty object, matching what normalizeRecents() in main.js already does.
 *
 * @param {object} recents            the normalized recents map
 * @param {string[]} roles            the role keys to walk ("source", …)
 * @param {(p: string) => Promise<unknown>} isSystemPath
 *        truthy for a path inside a system volume. Async because the real
 *        one resolves symlinks.
 * @returns {Promise<{recents: object, pruned: number}>} `pruned` counts
 *          entries removed, so the caller can skip the write when nothing
 *          changed.
 */
async function pruneRecents(recents, roles, isSystemPath) {
  let pruned = 0;
  const out = {};

  for (const [device, entry] of Object.entries(recents || {})) {
    if (!entry || typeof entry !== "object") continue;

    // The device itself is a system volume: the whole history goes, and
    // every entry under it counts as pruned.
    if (await isSystemPath(device)) {
      for (const role of roles) pruned += (entry[role] || []).length;
      continue;
    }

    const kept = {};
    for (const role of roles) {
      const keep = [];
      for (const f of entry[role] || []) {
        if (typeof f === "string" && (await isSystemPath(f))) pruned++;
        else keep.push(f);
      }
      if (keep.length) kept[role] = keep;
    }
    if (roles.some((role) => kept[role])) out[device] = kept;
  }

  return { recents: out, pruned };
}

module.exports = { pruneRecents };
