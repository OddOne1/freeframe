#!/usr/bin/env node
// Filtering and rename-fragility, against real files on a real disk
// (CLAUDE.md §23c/§23d).
//
// scripts/test-filters.js proves the pure logic. This one runs actual copy
// jobs through runCopyJob and then reads the destination back off the
// filesystem, because the claim being made is about what ends up on
// someone's drive — not about what a function returned.
//
// The first section is the one that matters most and looks the most
// trivial: a preset with no filtering configured must put every source file
// in the destination. Everything else here fails loudly if it breaks; that
// one fails by quietly leaving footage behind.
//
// Electron is not needed — copy-engine.js deliberately has no electron
// dependency, and neither do filters.js or naming.js.
//
// Run: node scripts/e2e-filters.js

const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { runCopyJob } = require(path.join(__dirname, "..", "src", "main", "copy-engine.js"));
const { normalizeFilters, wantsFlatten } = require(path.join(__dirname, "..", "src", "main", "filters.js"));
const { buildRelMapper } = require(path.join(__dirname, "..", "src", "main", "naming.js"));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

/** Every file under a root, as sorted destination-relative paths. */
async function walk(root) {
  const out = [];
  async function rec(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(path.relative(root, full));
    }
  }
  await rec(root);
  return out.sort();
}

/** A card with a clip, its sidecars, junk, and a bundle. */
async function makeCard(root, { withRaw = false } = {}) {
  const media = path.join(root, "DCIM", "100MEDIA");
  await fsp.mkdir(media, { recursive: true });
  await fsp.writeFile(path.join(media, "C0001.MP4"), crypto.randomBytes(48 * 1024));
  await fsp.writeFile(path.join(media, "C0001.XML"), "<clip><id>C0001</id></clip>");
  await fsp.writeFile(path.join(media, "C0001.THM"), crypto.randomBytes(2048));
  await fsp.writeFile(path.join(media, "C0002.MP4"), crypto.randomBytes(48 * 1024));
  await fsp.writeFile(path.join(media, "C0002.XML"), "<clip><id>C0002</id></clip>");
  await fsp.writeFile(path.join(media, "C0002.THM"), crypto.randomBytes(2048));
  await fsp.mkdir(path.join(root, "MISC"), { recursive: true });
  await fsp.writeFile(path.join(root, "MISC", "INDEX.MIF"), crypto.randomBytes(512));
  // An emptied-out RED bundle beside one that still holds footage.
  await fsp.mkdir(path.join(root, "A002.rdc"), { recursive: true });
  await fsp.writeFile(path.join(root, "A002.rdc", "leftover.txt"), "stub");
  if (withRaw) {
    await fsp.mkdir(path.join(root, "A001.rdc"), { recursive: true });
    await fsp.writeFile(path.join(root, "A001.rdc", "A001_C001.R3D"), crypto.randomBytes(64 * 1024));
  }
  return root;
}

// §100 — a folder source with no naming template governing structure lands
// under a folder named after the card, rather than spilling its contents
// into the destination root. These filtering tests predate that and asserted
// the flat layout; the subject here is WHICH files arrive, not where the
// tree is rooted, so the expectation carries the wrapper rather than the
// engine losing it. A test with a real folderTemplate (section 6) is not
// wrapped and is left alone.
const under = (card, files) => files.map((f) => `${card}/${f}`);

const SOURCE_FILES = [
  "A002.rdc/leftover.txt",
  "DCIM/100MEDIA/C0001.MP4",
  "DCIM/100MEDIA/C0001.THM",
  "DCIM/100MEDIA/C0001.XML",
  "DCIM/100MEDIA/C0002.MP4",
  "DCIM/100MEDIA/C0002.THM",
  "DCIM/100MEDIA/C0002.XML",
  "MISC/INDEX.MIF",
];

(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-filters-"));
  const quiet = () => {};

  // ══ 1. No filtering configured — everything must arrive ═══════════════
  //
  // The explicit requirement, and the regression that would be invisible.
  console.log("1. A preset with no filtering copies EVERYTHING");
  {
    const src = await makeCard(path.join(tmp, "card1"));
    const dest = path.join(tmp, "dest1");
    await fsp.mkdir(dest, { recursive: true });

    const summary = await runCopyJob({
      sourcePath: src,
      destPaths: [dest],
      onProgress: quiet,
      // Exactly what a preset with an untouched filtering section produces.
      filters: normalizeFilters(undefined),
      mapRel: buildRelMapper({ folderTemplate: "", fileTemplate: "" }),
    });

    const landed = await walk(dest);
    check(JSON.stringify(landed) === JSON.stringify(under("card1", SOURCE_FILES)),
      "every source file is in the destination", `got ${landed.length}: ${landed.join(", ")}`);
    check(summary.allVerified === true, "and every one verified");
    check(!summary.filteredOut || summary.filteredOut.length === 0, "nothing reported as filtered");
  }

  // ══ 2. Filtering on ═══════════════════════════════════════════════════
  console.log("\n2. Configured filtering removes exactly what it says");
  {
    const src = await makeCard(path.join(tmp, "card2"));
    const dest = path.join(tmp, "dest2");
    await fsp.mkdir(dest, { recursive: true });

    const filters = normalizeFilters({
      doNotCopyExtensions: [".thm"],
      doNotCopyNames: ["index.mif"],
      ignoreBundles: { extensions: [".rdc"], maxBytes: 1024 },
    });

    const summary = await runCopyJob({
      sourcePath: src, destPaths: [dest], onProgress: quiet, filters,
    });

    const landed = await walk(dest);
    check(JSON.stringify(landed) === JSON.stringify(under("card2", [
      "DCIM/100MEDIA/C0001.MP4",
      "DCIM/100MEDIA/C0001.XML",
      "DCIM/100MEDIA/C0002.MP4",
      "DCIM/100MEDIA/C0002.XML",
    ])), "only the footage and its sidecars landed", landed.join(", "));
    check(summary.filteredOut.length === 4, "four skips reported (two THMs, the index, the stub bundle)",
      `got ${summary.filteredOut.length}`);
    check(summary.filteredOut.every((f) => f.reason), "each skip states why");
    check(summary.allVerified === true, "the job still verifies clean");
    // A skipped file must not be counted as copied, or the totals lie.
    check(summary.totalFiles === 4, "totals count what was actually copied", String(summary.totalFiles));
  }

  // ══ 3. Sidecars follow their clip, on disk ════════════════════════════
  console.log("\n3. Renaming keeps clip and sidecar paired");
  {
    const src = await makeCard(path.join(tmp, "card3"));
    const dest = path.join(tmp, "dest3");
    await fsp.mkdir(dest, { recursive: true });

    const mapRel = buildRelMapper({ folderTemplate: "SHOOT", fileTemplate: "PADEL_{counter}" });
    await runCopyJob({
      sourcePath: src,
      destPaths: [dest],
      onProgress: quiet,
      mapRel,
      renamesFiles: true,
      // No .r3d on this card, so the guard has nothing to object to.
      filters: normalizeFilters({ doNotCopyNames: ["index.mif", "leftover.txt"] }),
    });

    const landed = await walk(dest);
    const media = landed.filter((f) => f.endsWith(".MP4")).sort();
    const stems = new Set(landed.map((f) => f.slice(0, f.lastIndexOf("."))));

    check(media.length === 2, "both clips landed", landed.join(", "));
    check(landed.every((f) => path.basename(f).startsWith("PADEL_")), "everything was renamed", landed.join(", "));
    // The actual claim: each clip's sidecars share its new basename.
    for (const clip of media) {
      const stem = clip.slice(0, clip.lastIndexOf("."));
      check(landed.includes(`${stem}.XML`), `${path.basename(stem)}.XML sits beside its clip`);
      check(landed.includes(`${stem}.THM`), `${path.basename(stem)}.THM sits beside its clip`);
    }
    check(stems.size === 2, "exactly two names in use — sidecars did not take their own counter values",
      [...stems].join(", "));

    // And the XML that landed as PADEL_0001.XML must really be C0001's.
    const first = landed.find((f) => f.endsWith("PADEL_0001.XML"));
    const body = first ? await fsp.readFile(path.join(dest, first), "utf8") : "";
    check(body.includes("C0001"), "the sidecar beside clip 1 is clip 1's own sidecar",
      first ? body : "no PADEL_0001.XML was written at all");
  }

  // ══ 4. Rename-fragility guard ═════════════════════════════════════════
  console.log("\n4. RAW formats block a rename until acknowledged");
  {
    const src = await makeCard(path.join(tmp, "card4"), { withRaw: true });
    const dest = path.join(tmp, "dest4");
    await fsp.mkdir(dest, { recursive: true });

    let blocked = null;
    try {
      await runCopyJob({
        sourcePath: src, destPaths: [dest], onProgress: quiet,
        mapRel: buildRelMapper({ fileTemplate: "X_{counter}" }),
        renamesFiles: true,
      });
    } catch (e) { blocked = e; }

    check(blocked !== null, "the job was refused");
    check(blocked && blocked.code === "RENAME_FRAGILE", "…with a code the UI can act on", blocked && blocked.code);
    check(blocked && /\.r3d/i.test(blocked.message), "…naming the format", blocked && blocked.message.slice(0, 80));
    check(blocked && /MEDIAPRO|INDEX\.MIF/.test(blocked.message),
      "…and stating the card-index limitation it cannot fix");
    check((await walk(dest)).length === 0, "nothing was written before the refusal");

    // Same job, acknowledged.
    const summary = await runCopyJob({
      sourcePath: src, destPaths: [dest], onProgress: quiet,
      mapRel: buildRelMapper({ fileTemplate: "X_{counter}" }),
      renamesFiles: true,
      allowFragileRename: true,
    });
    const landed = await walk(dest);
    check(summary.allVerified === true, "the override lets the same job through");
    check(landed.some((f) => /X_\d+\.R3D$/.test(f)), "and the R3D was renamed", landed.join(", "));
  }

  // ══ 5. A folder-only template is not a rename ═════════════════════════
  console.log("\n5. A folder template alone does not trip the guard");
  {
    const src = await makeCard(path.join(tmp, "card5"), { withRaw: true });
    const dest = path.join(tmp, "dest5");
    await fsp.mkdir(dest, { recursive: true });

    // renamesFiles is false because the preset has no file pattern — the
    // clip names are untouched, so nothing can break. Caught rather than
    // left to throw: a guard that fires here is a real regression, and it
    // should read as a failed check, not as the harness falling over.
    let summary = null;
    let threw = null;
    try {
      summary = await runCopyJob({
        sourcePath: src, destPaths: [dest], onProgress: quiet,
        mapRel: buildRelMapper({ folderTemplate: "OFFLOAD_{date}" }),
        renamesFiles: false,
      });
    } catch (e) { threw = e; }
    check(threw === null, "a folder-only template is not refused", threw && threw.message);
    if (threw) { console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`); process.exit(1); }

    const landed = await walk(dest);
    check(summary.allVerified === true, "the job runs");
    check(landed.some((f) => f.endsWith("A001_C001.R3D")), "the R3D kept its own name", landed.join(", "));
  }

  // ══ 6. Flatten, on disk ═══════════════════════════════════════════════
  console.log("\n6. Flatten discards the source tree");
  {
    const src = await makeCard(path.join(tmp, "card6"));
    const dest = path.join(tmp, "dest6");
    await fsp.mkdir(dest, { recursive: true });

    const filters = normalizeFilters({ ignoreFolders: { mode: "flatten" } });
    await runCopyJob({
      sourcePath: src, destPaths: [dest], onProgress: quiet, filters,
      mapRel: buildRelMapper({ folderTemplate: "FLAT", flatten: wantsFlatten(filters) }),
    });

    const landed = await walk(dest);
    check(landed.every((f) => f.split("/").length === 2 && f.startsWith("FLAT/")),
      "every file sits directly under the folder template", landed.join(", "));
    check(landed.length === SOURCE_FILES.length, "and none went missing", String(landed.length));
  }

  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nHARNESS ERROR", err);
  process.exit(1);
});
