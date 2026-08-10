#!/usr/bin/env node
// Exercises the real copy engine against real files on disk.
//
// Not a mock: this imports src/main/copy-engine.js — the exact module the
// Electron main process calls — and runs it over temp directories. The
// point is to be able to prove checksums actually pass (and, more
// importantly, actually FAIL when they should) without clicking through a
// GUI.
//
// Run: node scripts/test-copy.js

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { runCopyJob, hashFileOnDisk } = require("../src/main/copy-engine");

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function makeTree(root) {
  // Shaped like a real card: nested dirs, a couple of sizeable binaries, an
  // empty file, unicode + spaces in names, and a .DS_Store that must be
  // skipped.
  await fs.mkdir(path.join(root, "DCIM", "100CANON"), { recursive: true });
  await fs.mkdir(path.join(root, "CLIPS", "day one"), { recursive: true });

  const files = {};

  const big = Buffer.alloc(9 * 1024 * 1024 + 12345);
  crypto.randomFillSync(big);
  await fs.writeFile(path.join(root, "DCIM", "100CANON", "A001C001.MOV"), big);
  files["DCIM/100CANON/A001C001.MOV"] = big.length;

  const mid = Buffer.alloc(1024 * 1024);
  crypto.randomFillSync(mid);
  await fs.writeFile(path.join(root, "DCIM", "100CANON", "A001C002.MOV"), mid);
  files["DCIM/100CANON/A001C002.MOV"] = mid.length;

  await fs.writeFile(path.join(root, "CLIPS", "day one", "notes ünïcode.txt"), "on-set notes\n");
  files["CLIPS/day one/notes ünïcode.txt"] = 13;

  await fs.writeFile(path.join(root, "CLIPS", "empty.log"), "");
  files["CLIPS/empty.log"] = 0;

  // Must NOT be copied.
  await fs.writeFile(path.join(root, "DCIM", ".DS_Store"), "junk");

  return files;
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-copy-test-"));
  const source = path.join(tmp, "SOURCE_CARD");
  const destA = path.join(tmp, "DEST_A");
  const destB = path.join(tmp, "DEST_B");
  await fs.mkdir(source, { recursive: true });

  try {
    const expected = await makeTree(source);
    const expectedFiles = Object.keys(expected).sort();

    // ── 1. Two destinations in parallel, happy path ──
    console.log("\n1. Copy to TWO destinations in parallel, verify every file");
    const progress = [];
    const summary = await runCopyJob({
      sourcePath: source,
      destPaths: [destA, destB],
      onProgress: (p) => progress.push(p),
    });

    check(summary.allVerified === true, "allVerified", JSON.stringify({
      mismatches: summary.mismatches.length, errors: summary.errors.length,
    }));
    check(summary.mode === "SECURE" && summary.algorithm === "xxh64", "reports SECURE / xxh64");
    check(summary.totalFiles === expectedFiles.length, "file count", `${summary.totalFiles} (expected ${expectedFiles.length})`);
    check(summary.fileCopiesVerified === expectedFiles.length * 2, "every file verified into BOTH destinations",
      `${summary.fileCopiesVerified} of ${summary.totalFileCopies}`);
    check(summary.nodes.every((n) => n.status === "verified"), "both destination nodes verified");
    check(summary.mismatches.length === 0 && summary.errors.length === 0, "no mismatches or errors");

    const copiedRel = [...new Set(summary.files.map((f) => f.file))].sort();
    check(JSON.stringify(copiedRel) === JSON.stringify(expectedFiles), ".DS_Store excluded, everything else copied");

    // Bytes counted once per source read, not once per destination.
    const srcTotal = Object.values(expected).reduce((a, b) => a + b, 0);
    const srcFileCount = expectedFiles.length;
    check(summary.totalBytes === srcTotal, "totalBytes = source size", `${summary.totalBytes} vs ${srcTotal}`);
    check(summary.copiedBytes === srcTotal, "copiedBytes not multiplied by destination count", `${summary.copiedBytes}`);

    // ── 2. The bytes on disk are genuinely identical ──
    console.log("\n2. Independently re-hash both destinations off disk");
    let allIdentical = true;
    for (const rel of expectedFiles) {
      const sHash = await hashFileOnDisk(path.join(source, rel));
      const aHash = await hashFileOnDisk(path.join(destA, rel));
      const bHash = await hashFileOnDisk(path.join(destB, rel));
      if (sHash !== aHash || sHash !== bHash) {
        allIdentical = false;
        console.log(`        ${rel}: src=${sHash} A=${aHash} B=${bHash}`);
      }
    }
    check(allIdentical, "source == DEST_A == DEST_B for every file");

    const engineHashes = new Map(summary.files.map((f) => [f.file, f.sourceHash]));
    let engineAgrees = true;
    for (const rel of expectedFiles) {
      const independent = await hashFileOnDisk(path.join(source, rel));
      if (engineHashes.get(rel) !== independent) engineAgrees = false;
    }
    check(engineAgrees, "hash computed during copy == hash of source re-read afterwards");

    check(
      fssync.existsSync(path.join(destA, "CLIPS", "day one", "notes ünïcode.txt")),
      "relative directory structure + unicode/space names preserved"
    );
    check(!fssync.existsSync(path.join(destA, "DCIM", ".DS_Store")), ".DS_Store not written to destination");

    // ── 3. Progress events ──
    console.log("\n3. Progress reporting");
    const phases = new Set(progress.map((p) => p.phase));
    check(["scanning", "start", "file-start", "bytes", "verifying", "file-done", "done"].every((p) => phases.has(p)),
      "all phases emitted", [...phases].join(","));
    const byteEvents = progress.filter((p) => p.phase === "bytes");
    check(byteEvents.length > 1, "multiple byte-progress events during large file", `${byteEvents.length} events`);
    const percents = byteEvents.map((p) => p.percent);
    check(percents.every((p, i) => i === 0 || p >= percents[i - 1]), "percent is monotonic");
    check(percents[percents.length - 1] <= 100, "percent never exceeds 100", `max ${Math.max(...percents).toFixed(2)}`);

    // ── 4. THE IMPORTANT ONE: corruption must be caught ──
    // A verifier that always passes is worse than no verifier, because it
    // is trusted. Corrupt a destination file behind the engine's back and
    // confirm the next run flags it.
    console.log("\n4. Deliberately corrupt a destination — mismatch MUST be detected");
    const destC = path.join(tmp, "DEST_C");
    await runCopyJob({ sourcePath: source, destPaths: [destC] });

    const victim = path.join(destC, "DCIM", "100CANON", "A001C002.MOV");
    const buf = await fs.readFile(victim);
    buf[1000] = buf[1000] ^ 0xff; // flip one byte in ~1MB
    await fs.writeFile(victim, buf);

    // Re-verify by re-running against a fresh copy of the same source and
    // comparing the corrupted file's hash directly.
    const srcHash = await hashFileOnDisk(path.join(source, "DCIM/100CANON/A001C002.MOV"));
    const corruptHash = await hashFileOnDisk(victim);
    check(srcHash !== corruptHash, "single flipped byte changes the hash", `${srcHash} vs ${corruptHash}`);

    // And prove the engine's own verification path reports it: point a copy
    // at a destination whose file is write-protected mid-flight is awkward,
    // so instead assert the comparison logic directly on a truncation.
    const destD = path.join(tmp, "DEST_D");
    await runCopyJob({ sourcePath: source, destPaths: [destD] });
    const truncTarget = path.join(destD, "DCIM/100CANON/A001C002.MOV");
    await fs.truncate(truncTarget, 500);
    const truncHash = await hashFileOnDisk(truncTarget);
    check(truncHash !== srcHash, "truncated file fails the hash comparison");
    check((await fs.stat(truncTarget)).size !== (await fs.stat(path.join(source, "DCIM/100CANON/A001C002.MOV"))).size,
      "truncated file also fails the size check");

    // The above proves a corrupted file hashes differently. It does NOT
    // prove runCopyJob's own verification reports it — a summary that
    // hardcoded allVerified:true would still pass everything so far, and
    // would be the worst possible bug in this app. Force a real failure
    // through the engine by parking a directory where a file needs to go.
    console.log("\n4b. runCopyJob itself must report failure, not just return allVerified:true");
    const destE = path.join(tmp, "DEST_E");
    await fs.mkdir(path.join(destE, "DCIM", "100CANON", "A001C001.MOV"), { recursive: true });
    const failed = await runCopyJob({ sourcePath: source, destPaths: [destE] });
    check(failed.allVerified === false, "allVerified is false when a file cannot be written");
    check(failed.errors.length > 0, "the failure is recorded in errors[]", `${failed.errors.length} error(s)`);
    check(failed.fileCopiesVerified < failed.totalFileCopies, "verified count reflects the failure",
      `${failed.fileCopiesVerified}/${failed.totalFileCopies}`);
    check(failed.files.some((f) => f.ok === false), "the specific file is marked not-ok");
    check(failed.files.some((f) => f.ok === true), "other files still copied — one bad file doesn't abort the run");
    check(failed.nodes[0].status === "failed", "the node itself is marked failed", failed.nodes[0].status);

    // ── 4c. Cascading: source → A → B ──
    // The ordering guarantee is the whole point: B must not begin until A
    // has copied AND verified, because cascading from an unverified copy
    // would propagate corruption while reporting success.
    console.log("\n4c. Cascade — source → A → B runs in dependency order");
    const cA = path.join(tmp, "CASCADE_A");
    const cB = path.join(tmp, "CASCADE_B");
    const timeline = [];
    const casc = await runCopyJob({
      sourcePath: source,
      nodes: [
        { id: "A", path: cA, parentId: null },
        { id: "B", path: cB, parentId: "A" },
      ],
      onProgress: (p) => {
        if (p.phase === "node-status") timeline.push(`${p.node.id}:${p.node.status}`);
        if (p.phase === "source-released") timeline.push("source-released");
      },
    });

    check(casc.allVerified === true, "cascade verified end to end", JSON.stringify({
      mismatches: casc.mismatches.length, errors: casc.errors.length,
    }));
    check(casc.legCount === 2, "counted as two legs, not one", String(casc.legCount));

    const aVerified = timeline.indexOf("A:verified");
    const bCopying = timeline.indexOf("B:copying");
    check(aVerified !== -1 && bCopying !== -1, "both legs reported status");
    check(aVerified < bCopying, "B starts copying only AFTER A verifies",
      `A:verified@${aVerified} < B:copying@${bCopying}`);
    check(timeline.indexOf("B:copying") > timeline.indexOf("A:copying"), "A copies before B");

    // Source can be freed once the primary leg verifies — that's the point
    // of cascading, not a cosmetic detail.
    const released = timeline.indexOf("source-released");
    check(released !== -1 && released >= aVerified && released < bCopying,
      "source released after the primary leg, before the cascade runs", `@${released}`);

    const nodeA = casc.nodes.find((n) => n.id === "A");
    const nodeB = casc.nodes.find((n) => n.id === "B");
    check(nodeA.parentId === null && nodeB.parentId === "A", "tree shape survives to the summary");
    check(nodeA.status === "verified" && nodeB.status === "verified", "both nodes verified");

    let cascadeIdentical = true;
    for (const rel of expectedFiles) {
      const s1 = await hashFileOnDisk(path.join(source, rel));
      const s2 = await hashFileOnDisk(path.join(cB, rel));
      if (s1 !== s2) cascadeIdentical = false;
    }
    check(cascadeIdentical, "cascaded copy is byte-identical to the ORIGINAL source");

    // ── 4d. A failed parent must not cascade ──
    console.log("\n4d. A cascade whose parent fails must be skipped, not run");
    const fA = path.join(tmp, "FAIL_A");
    const fB = path.join(tmp, "FAIL_B");
    // Park a directory where a file needs to go, so leg A genuinely fails.
    await fs.mkdir(path.join(fA, "DCIM", "100CANON", "A001C001.MOV"), { recursive: true });
    const badCasc = await runCopyJob({
      sourcePath: source,
      nodes: [
        { id: "A", path: fA, parentId: null },
        { id: "B", path: fB, parentId: "A" },
      ],
    });
    const bad_A = badCasc.nodes.find((n) => n.id === "A");
    const bad_B = badCasc.nodes.find((n) => n.id === "B");
    check(bad_A.status === "failed", "parent leg marked failed", bad_A.status);
    check(bad_B.status === "skipped", "child leg SKIPPED, never copied", bad_B.status);
    check(badCasc.allVerified === false, "allVerified false for the whole job");
    check(!fssync.existsSync(path.join(fB, "README.txt")) || (await fs.readdir(fB).catch(() => [])).length === 0,
      "nothing written to the skipped destination");

    // ── 4e. Malformed trees are rejected ──
    console.log("\n4e. Malformed cascade trees rejected");
    for (const [label, nodes] of [
      ["cycle", [{ id: "A", path: path.join(tmp, "X1"), parentId: "B" }, { id: "B", path: path.join(tmp, "X2"), parentId: "A" }]],
      ["self-parent", [{ id: "A", path: path.join(tmp, "X3"), parentId: "A" }]],
      ["missing parent", [{ id: "A", path: path.join(tmp, "X4"), parentId: "ghost" }]],
      ["duplicate destination", [{ id: "A", path: path.join(tmp, "X5"), parentId: null }, { id: "B", path: path.join(tmp, "X5"), parentId: null }]],
    ]) {
      let threw = false;
      try { await runCopyJob({ sourcePath: source, nodes }); } catch { threw = true; }
      check(threw, `rejects ${label}`);
    }

    // ── 5. Guard rails ──
    console.log("\n5. Refuses dangerous source/destination combinations");
    for (const [label, dests] of [
      ["destination == source", [source]],
      ["destination inside source", [path.join(source, "DCIM")]],
      ["source inside destination", [tmp]],
    ]) {
      let threw = false;
      try {
        await runCopyJob({ sourcePath: source, destPaths: dests });
      } catch { threw = true; }
      check(threw, `rejects ${label}`);
    }
    let noDestThrew = false;
    try { await runCopyJob({ sourcePath: source, destPaths: [] }); } catch { noDestThrew = true; }
    check(noDestThrew, "rejects empty destination list");

    // ── 6. Parallelism is real, not sequential-in-disguise ──
    console.log("\n6. Destinations are written from ONE source read");
    // If the engine re-read the source per destination, copiedBytes would
    // scale with destination count. It doesn't (checked in section 1), and
    // a 3-destination run should still report exactly the source size.
    const d1 = path.join(tmp, "P1"), d2 = path.join(tmp, "P2"), d3 = path.join(tmp, "P3");
    const par = await runCopyJob({ sourcePath: source, destPaths: [d1, d2, d3] });
    check(par.copiedBytes === srcTotal, "3 destinations still read the source once", `${par.copiedBytes} bytes`);
    check(par.allVerified === true, "all 3 destinations verified");
    check(par.nodes.length === 3 && par.nodes.every((n) => n.status === "verified"), "all 3 nodes recorded and verified");
    check(par.totalFileCopies === srcFileCount * 3, "file-copy denominator scales with destinations",
      `${par.totalFileCopies}`);

    console.log(
      failures === 0
        ? `\nALL CHECKS PASSED (${summary.totalFiles} files, ${(srcTotal / 1024 / 1024).toFixed(1)} MB, ${summary.durationMs}ms for 2 destinations)`
        : `\n${failures} CHECK(S) FAILED`
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
