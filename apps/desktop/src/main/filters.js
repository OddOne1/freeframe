// Opt-in copy filtering (CLAUDE.md §23c).
//
// **The default is, and must remain, "copy everything."** That is an
// explicit user instruction, not a conservative default chosen here: this
// app's whole premise is that a card offload loses nothing. A preset that
// defines none of these fields — which is every preset that exists before
// this shipped — produces `null` from normalizeFilters(), and the engine
// then skips the filtering step entirely rather than running a no-op pass
// over the listing. Nothing to get subtly wrong on the path that matters.
//
// Deliberately pure, like naming.js: no fs, no electron. Everything here is
// a decision about a list of {rel, size} records, which is what makes the
// dangerous cases (a filter that eats real footage) testable without a disk.

const path = require("node:path");

/** Normalize one extension to a leading-dot lowercase form. */
function normExt(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return "";
  return s.startsWith(".") ? s : `.${s}`;
}

/**
 * Turn whatever a preset stored into a filter spec, or null when it asks
 * for nothing.
 *
 * Returning null rather than an empty spec is the point: it lets the caller
 * distinguish "no filtering configured" from "filtering configured to do
 * nothing", and take the untouched code path for the former.
 */
function normalizeFilters(raw) {
  if (!raw || typeof raw !== "object") return null;

  const doNotCopyExtensions = Array.isArray(raw.doNotCopyExtensions)
    ? [...new Set(raw.doNotCopyExtensions.map(normExt).filter(Boolean))]
    : [];

  const doNotCopyNames = Array.isArray(raw.doNotCopyNames)
    ? [...new Set(raw.doNotCopyNames.map((n) => String(n ?? "").trim().toLowerCase()).filter(Boolean))]
    : [];

  const bundleExtensions = Array.isArray(raw.ignoreBundles?.extensions)
    ? [...new Set(raw.ignoreBundles.extensions.map(normExt).filter(Boolean))]
    : [];
  const bundleMaxBytes = Number.isFinite(Number(raw.ignoreBundles?.maxBytes))
    ? Math.max(0, Number(raw.ignoreBundles.maxBytes))
    : null;
  const ignoreBundles = bundleExtensions.length ? { extensions: bundleExtensions, maxBytes: bundleMaxBytes } : null;

  // "flatten" is handled by the naming mapper, not here — it changes where
  // a file lands, not whether it is copied, and rewriting the source-side
  // rel would break the provider's own open(rel) lookup.
  const mode = ["whenEmpty", "flatten"].includes(raw.ignoreFolders?.mode)
    ? raw.ignoreFolders.mode
    : "off";

  if (!doNotCopyExtensions.length && !doNotCopyNames.length && !ignoreBundles && mode === "off") {
    return null;
  }

  // The output shape deliberately MATCHES the input shape, key for key, so
  // that normalizing an already-normalized spec is a no-op. The saved
  // preset holds normalized output and the editor reads it back with the
  // same accessors it writes with — an asymmetric key here means a setting
  // that appears to revert to its default the next time the preset is
  // opened, and then gets saved back that way. That is silent loss of
  // something a user configured, and it is not detectable by reading the
  // filtering code alone.
  return { doNotCopyExtensions, doNotCopyNames, ignoreBundles, ignoreFolders: { mode } };
}

/** True when this filter spec wants the source tree flattened. */
function wantsFlatten(filters) {
  return Boolean(filters && filters.ignoreFolders && filters.ignoreFolders.mode === "flatten");
}

/**
 * Every ancestor directory of a rel, shallowest first.
 * `a/b/c.mov` -> ["a", "a/b"].
 */
function ancestorsOf(rel) {
  const parts = rel.split("/").slice(0, -1);
  const out = [];
  for (let i = 0; i < parts.length; i += 1) out.push(parts.slice(0, i + 1).join("/"));
  return out;
}

/**
 * Which bundle directories are small enough to discard.
 *
 * A "bundle" is a directory that behaves as a package — RED's `.rdc`,
 * an `.avchd` tree, Lightroom's `.lrdata`. The size threshold is what makes
 * this safe to offer at all: it targets the leftover shells that carry no
 * real media, and a bundle holding actual footage is over any sane
 * threshold and therefore kept. With no threshold set, every matching
 * bundle is dropped — which is a bigger hammer, so the UI says so.
 */
function bundlesToSkip(listing, ignoreBundles) {
  if (!ignoreBundles) return new Set();
  const totals = new Map();
  for (const item of listing) {
    for (const dir of ancestorsOf(item.rel)) {
      const ext = path.extname(dir).toLowerCase();
      if (!ignoreBundles.extensions.includes(ext)) continue;
      totals.set(dir, (totals.get(dir) || 0) + (Number(item.size) || 0));
    }
  }
  const skip = new Set();
  for (const [dir, bytes] of totals) {
    if (ignoreBundles.maxBytes === null || bytes <= ignoreBundles.maxBytes) skip.add(dir);
  }
  return skip;
}

/**
 * Apply a filter spec to a listing.
 *
 * Returns both what survived and what didn't, with a reason per skipped
 * file. The reasons are not decoration: a copy tool that silently drops
 * files is indistinguishable from one that loses them, so the summary
 * reports exactly what it chose not to take and why.
 *
 * @param {Array<{rel: string, size: number}>} listing
 * @returns {{kept: Array, skipped: Array<{rel: string, reason: string}>}}
 */
function applyFilters(listing, filters) {
  if (!filters) return { kept: listing, skipped: [] };

  const skipBundles = bundlesToSkip(listing, filters.ignoreBundles);

  const kept = [];
  const skipped = [];
  for (const item of listing) {
    const base = path.basename(item.rel).toLowerCase();
    const ext = path.extname(base).toLowerCase();

    const bundle = ancestorsOf(item.rel).find((dir) => skipBundles.has(dir));
    if (bundle) {
      skipped.push({ rel: item.rel, reason: `inside ignored bundle ${path.basename(bundle)}` });
      continue;
    }
    if (ext && filters.doNotCopyExtensions.includes(ext)) {
      skipped.push({ rel: item.rel, reason: `extension ${ext} is on the do-not-copy list` });
      continue;
    }
    if (filters.doNotCopyNames.some((n) => base === n || base.includes(n))) {
      skipped.push({ rel: item.rel, reason: "filename is on the do-not-copy list" });
      continue;
    }
    kept.push(item);
  }

  // "whenEmpty" needs no work here, and saying so is worth more than a
  // silent omission: a directory holding no files never appears in a
  // listing, and runLeg only ever mkdir's the parent of a file it is about
  // to write. A folder emptied by the filtering above therefore already
  // fails to be created at the destination. The mode exists so the UI can
  // state that behaviour rather than leaving someone to discover it.

  return { kept, skipped };
}

module.exports = {
  normalizeFilters,
  applyFilters,
  wantsFlatten,
  bundlesToSkip,
  ancestorsOf,
};
