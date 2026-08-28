#!/usr/bin/env node
// Opt-in copy filtering + rename-fragility protection (CLAUDE.md §23c/§23d).
//
// The highest-stakes assertion in this file is the dullest one: a preset
// that configures no filtering must copy everything. That is an explicit
// user requirement, and it is also the failure nobody would notice until
// footage was already missing from a destination — every other case here
// announces itself.
//
// Run: node scripts/test-filters.js
const assert = require("node:assert");
const path = require("node:path");
const {
  normalizeFilters, applyFilters, wantsFlatten, bundlesToSkip, ancestorsOf,
} = require(path.join(__dirname, "..", "src", "main", "filters.js"));
const {
  buildRelMapper, fragileRenameExtensions,
} = require(path.join(__dirname, "..", "src", "main", "naming.js"));

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}
function eq(actual, expected, label) {
  check(actual === expected, label, actual === expected ? "" : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function deep(actual, expected, label) {
  let ok = true;
  try { assert.deepStrictEqual(actual, expected); } catch { ok = false; }
  check(ok, label, ok ? "" : `got ${JSON.stringify(actual)}`);
}

const CARD = [
  { rel: "DCIM/100GOPRO/GOPR0001.MP4", size: 4_000_000 },
  { rel: "DCIM/100GOPRO/GOPR0001.THM", size: 8_000 },
  { rel: "DCIM/100GOPRO/GOPR0001.LRV", size: 400_000 },
  { rel: "DCIM/100GOPRO/GOPR0002.MP4", size: 4_000_000 },
  { rel: "MISC/INDEX.MIF", size: 2_000 },
];

// ── 1. The default: nothing configured means nothing filtered ────────────

console.log("1. Default is copy-everything");
eq(normalizeFilters(undefined), null, "undefined -> null");
eq(normalizeFilters(null), null, "null -> null");
eq(normalizeFilters({}), null, "empty object -> null");
eq(normalizeFilters({ doNotCopyExtensions: [], ignoreFolders: { mode: "off" } }), null,
  "a form filled in with nothing -> null, not an active empty filter");

// Normalizing is idempotent, which is not a purity nicety: the saved preset
// holds normalized output, and the editor reads it back with the same
// accessors it writes with. An asymmetric key means a configured setting
// silently reverts to its default the next time the preset is opened — and
// is then saved back that way.
{
  const once = normalizeFilters({
    doNotCopyExtensions: ["THM"],
    doNotCopyNames: ["INDEX.MIF"],
    ignoreBundles: { extensions: [".rdc"], maxBytes: 1024 },
    ignoreFolders: { mode: "flatten" },
  });
  const twice = normalizeFilters(once);
  deep(twice, once, "normalize(normalize(x)) === normalize(x)");
  eq(wantsFlatten(twice), true, "…including the folder mode, which is what actually broke");
  deep(normalizeFilters(normalizeFilters({ ignoreFolders: { mode: "whenEmpty" } })),
    normalizeFilters({ ignoreFolders: { mode: "whenEmpty" } }), "…for every mode");
}
deep(applyFilters(CARD, null).kept, CARD, "null spec returns the listing untouched");
eq(applyFilters(CARD, null).skipped.length, 0, "and skips nothing");
eq(wantsFlatten(null), false, "null spec does not flatten");

// A spec that IS configured, to prove the null cases above aren't just
// vacuously passing because applyFilters does nothing at all.
const realSpec = normalizeFilters({ doNotCopyExtensions: ["thm"] });
check(realSpec !== null, "a configured spec is not null");
eq(applyFilters(CARD, realSpec).kept.length, 4, "…and that spec really does remove a file");

// ── 2. Extension and name skipping ───────────────────────────────────────

console.log("\n2. Skip lists");
{
  const spec = normalizeFilters({ doNotCopyExtensions: [".THM", "ppn"], doNotCopyNames: ["INDEX.MIF"] });
  deep(spec.doNotCopyExtensions, [".thm", ".ppn"], "extensions normalized to lowercase with a leading dot");
  const { kept, skipped } = applyFilters(CARD, spec);
  deep(kept.map((f) => f.rel), [
    "DCIM/100GOPRO/GOPR0001.MP4",
    "DCIM/100GOPRO/GOPR0001.LRV",
    "DCIM/100GOPRO/GOPR0002.MP4",
  ], "LRV survives — it is a real proxy, not junk");
  eq(skipped.length, 2, "two files skipped");
  check(skipped.every((s) => s.reason), "every skip carries a reason");
  check(skipped.some((s) => s.rel.endsWith("INDEX.MIF")), "name match is case-insensitive");
}

// ── 3. Bundles ───────────────────────────────────────────────────────────

console.log("\n3. Ignore bundles");
{
  const listing = [
    { rel: "A001.rdc/A001_C001.R3D", size: 900_000_000 },
    { rel: "A002.rdc/leftover.txt", size: 100 },
    { rel: "loose.mov", size: 5_000_000 },
  ];
  deep(ancestorsOf("A001.rdc/x/y.R3D"), ["A001.rdc", "A001.rdc/x"], "ancestors, shallowest first");

  const spec = normalizeFilters({ ignoreBundles: { extensions: [".rdc"], maxBytes: 1_000_000 } });
  deep([...bundlesToSkip(listing, spec.ignoreBundles)], ["A002.rdc"],
    "only the bundle under the size limit is skipped");
  const { kept, skipped } = applyFilters(listing, spec);
  deep(kept.map((f) => f.rel), ["A001.rdc/A001_C001.R3D", "loose.mov"],
    "a bundle holding real footage is kept — that is what the size limit is for");
  eq(skipped[0].reason.includes("A002.rdc"), true, "the skip names the bundle");

  const noLimit = normalizeFilters({ ignoreBundles: { extensions: [".rdc"] } });
  eq(applyFilters(listing, noLimit).kept.length, 1, "no size limit drops every matching bundle");
}

// ── 4. Flatten ───────────────────────────────────────────────────────────

console.log("\n4. Folder modes");
{
  eq(wantsFlatten(normalizeFilters({ ignoreFolders: { mode: "flatten" } })), true, "flatten recognised");
  eq(wantsFlatten(normalizeFilters({ ignoreFolders: { mode: "whenEmpty" } })), false, "whenEmpty is not flatten");
  eq(normalizeFilters({ ignoreFolders: { mode: "nonsense" } }), null, "an unknown mode is not an active filter");

  const flat = buildRelMapper({ folderTemplate: "OFFLOAD", flatten: true });
  eq(flat("DCIM/100GOPRO/GOPR0001.MP4"), "OFFLOAD/GOPR0001.MP4", "source tree discarded");
  eq(flat("DCIM/101GOPRO/GOPR0002.MP4"), "OFFLOAD/GOPR0002.MP4", "…for every folder");

  // Flatten with no template at all still has to build a mapper.
  const bare = buildRelMapper({ flatten: true });
  check(bare !== null, "flatten alone is reason enough to build a mapper");
  eq(bare("a/b/c.mov"), "c.mov", "…and it flattens");

  const collide = buildRelMapper({ folderTemplate: "OFFLOAD", flatten: true });
  collide("CARD_A/C0001.MOV");
  let threw = null;
  try { collide("CARD_B/C0001.MOV"); } catch (e) { threw = e; }
  eq(threw && threw.code, "NAMING_COLLISION",
    "two same-named files in different folders are refused, not overwritten");
  check(threw && /flattening/.test(threw.message), "…and the message names the actual cause");
}

// ── 5. Rename-fragility detection ────────────────────────────────────────

console.log("\n5. Rename-fragile formats (§23d)");
{
  eq(fragileRenameExtensions(["a.mov", "b.mp4", "c.jpg"]).length, 0, "mp4/mov/jpg are safe to rename");
  const found = fragileRenameExtensions(["A001_C001.R3D", "A001_C002.r3d", "B.ari", "c.mov"]);
  eq(found.length, 2, "two fragile extensions found");
  eq(found[0].ext, ".r3d", "most numerous first");
  eq(found[0].count, 2, "counted, and case-insensitive");
  check(found.every((f) => f.reason), "each carries a reason to show the user");
  eq(fragileRenameExtensions(["clip.mxf"])[0].ext, ".mxf", "professional MXF included");
  eq(fragileRenameExtensions([]).length, 0, "empty list is fine");
}

// ── 6. Sidecar lockstep renaming ─────────────────────────────────────────

console.log("\n6. Sidecars follow their clip (§23d)");
{
  const files = [
    "C0001.MP4", "C0001.XML", "C0001.THM",
    "C0002.MP4", "C0002.XML",
    "orphan.SRT",
  ];
  const map = buildRelMapper({ fileTemplate: "SHOOT_{counter}", now: new Date(2026, 7, 15) });
  map.prepare(files);
  const out = Object.fromEntries(files.map((f) => [f, map(f)]));

  eq(out["C0001.MP4"], "SHOOT_0001.MP4", "first clip renamed");
  eq(out["C0001.XML"], "SHOOT_0001.XML", "its XML follows, keeping its own extension");
  eq(out["C0001.THM"], "SHOOT_0001.THM", "…and its thumbnail");
  eq(out["C0002.MP4"], "SHOOT_0002.MP4",
    "the next clip is 0002 — sidecars must not consume counter values");
  eq(out["C0002.XML"], "SHOOT_0002.XML", "and its sidecar follows it");
  eq(out["orphan.SRT"], "SHOOT_0003.SRT", "a sidecar with no clip is named in its own right");

  // Without prepare(), the old per-file behaviour is untouched — this is
  // what keeps every pre-existing caller and test working.
  const legacy = buildRelMapper({ fileTemplate: "SHOOT_{counter}" });
  eq(legacy("C0001.MP4"), "SHOOT_0001.MP4", "legacy path: first file");
  eq(legacy("C0001.XML"), "SHOOT_0002.XML", "legacy path: sidecar gets its own number");
}

console.log("\n7. Pairing is scoped, and placement follows too");
{
  // Same stem in two directories must not cross-pair: two cards can both
  // hold a C0001, and attaching one card's sidecar to the other's clip
  // would be worse than not pairing at all.
  const files = ["CARD_A/C0001.MP4", "CARD_A/C0001.XML", "CARD_B/C0001.XML"];
  const map = buildRelMapper({ fileTemplate: "R_{counter}" });
  map.prepare(files);
  eq(map("CARD_A/C0001.MP4"), "CARD_A/R_0001.MP4", "clip in card A");
  eq(map("CARD_A/C0001.XML"), "CARD_A/R_0001.XML", "its own card's sidecar follows it");
  eq(map("CARD_B/C0001.XML"), "CARD_B/R_0002.XML", "card B's sidecar did NOT follow card A's clip");
}

{
  // A {counter} in the FOLDER template would file a sidecar into a
  // different folder than its clip unless the whole context follows.
  const files = ["C0001.MP4", "C0001.XML", "C0002.MP4"];
  const map = buildRelMapper({ folderTemplate: "TAKE_{counter}", fileTemplate: "{name}" });
  map.prepare(files);
  // §65.5 CONSEQUENCE, and it is worth being explicit about: the file
  // template here numbers nothing, so it gets an auto _0001 — even though
  // the FOLDER template already guarantees uniqueness by putting every clip
  // in its own take folder. The spec's condition is "does the file pattern
  // reference {counter}/{sourcecounter}", not "could two files collide", so
  // this suffix is redundant here rather than wrong. Narrowing the
  // condition to also inspect the folder template would remove it; that was
  // not what was asked for. (\u00a774 narrowed the condition the other way,
  // to {counter} alone — it does not change this case.)
  eq(map("C0001.MP4"), "TAKE_0001/C0001_0001.MP4", "clip lands in its own take folder");
  eq(map("C0001.XML"), "TAKE_0001/C0001_0001.XML", "its sidecar lands in the SAME folder");
  eq(map("C0002.MP4"), "TAKE_0002/C0002_0002.MP4", "the next clip gets the next folder");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
