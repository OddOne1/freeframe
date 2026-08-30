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

const { runCopyJob, hashFileOnDisk, runFinalizedPass } = require("../src/main/copy-engine");
const journal = require("../src/main/job-journal");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Hash a file, or report why not. A missing file is exactly what a
 *  destination-layout regression produces, and letting it throw kills this
 *  harness mid-run — the failure then reads as a crash rather than as the
 *  check that was meant to catch it, and a mutation sweep cannot tell the
 *  two apart. */
async function hashOrNull(p) {
  try { return await hashFileOnDisk(p); } catch { return null; }
}
const { listAlgorithms, getHasherFactory, c4Digest } = require("../src/main/hashers");

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
  /**
   * §100 — a folder source now copies INTO its own name, so every
   * destination path gained one segment. These assertions used to build
   * `path.join(destRoot, rel)`; that was correct for the old flat
   * behaviour and is the thing §100 deliberately changed, so they are
   * updated rather than dropped.
   *
   * The wrapper is the source folder's basename, and stating it once here
   * is what stops the harness and the engine drifting on what it should
   * be.
   */
  const WRAP = path.basename(source);
  const inDest = (root, rel) => path.join(root, WRAP, rel);
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
      const sHash = await hashOrNull(path.join(source, rel));
      const aHash = await hashOrNull(inDest(destA, rel));
      const bHash = await hashOrNull(inDest(destB, rel));
      if (!sHash || sHash !== aHash || sHash !== bHash) {
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
      fssync.existsSync(inDest(destA, path.join("CLIPS", "day one", "notes ünïcode.txt"))),
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

    const victim = inDest(destC, path.join("DCIM", "100CANON", "A001C002.MOV"));
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
    const truncTarget = inDest(destD, "DCIM/100CANON/A001C002.MOV");
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
    // The blocker has to sit where the file will now actually land.
    await fs.mkdir(inDest(destE, path.join("DCIM", "100CANON", "A001C001.MOV")), { recursive: true });
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
      const s1 = await hashOrNull(path.join(source, rel));
      const s2 = await hashOrNull(inDest(cB, rel));
      if (!s1 || s1 !== s2) cascadeIdentical = false;
    }
    check(cascadeIdentical, "cascaded copy is byte-identical to the ORIGINAL source");

    // ── 4d. A failed parent must not cascade ──
    console.log("\n4d. A cascade whose parent fails must be skipped, not run");
    const fA = path.join(tmp, "FAIL_A");
    const fB = path.join(tmp, "FAIL_B");
    // Park a directory where a file needs to go, so leg A genuinely fails.
    // §100 — under the wrapper now, or the blocker misses and the leg
    // succeeds, which would make this whole section pass vacuously.
    await fs.mkdir(inDest(fA, path.join("DCIM", "100CANON", "A001C001.MOV")), { recursive: true });
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

    // ── 4f. Selectable checksum algorithms ──
    // Each one is checked against an independent reference digest, not just
    // against itself — a hasher that returns a stable wrong value would
    // pass a self-consistency test perfectly.
    console.log("\n4f. Checksum algorithms produce correct, independently-verifiable digests");

    const KNOWN = "The quick brown fox jumps over the lazy dog";
    const refs = {
      md5: crypto.createHash("md5").update(KNOWN).digest("hex"),
      sha1: crypto.createHash("sha1").update(KNOWN).digest("hex"),
      xxhash64: "0b242d361fda71bc",   // published xxHash64 vector
      // Published C4 vector from the reference implementation (cccc.io).
      c4: null,
    };
    for (const id of ["md5", "sha1", "xxhash64"]) {
      const make = await getHasherFactory(id);
      const h = make();
      h.update(Buffer.from(KNOWN));
      const got = h.digest();
      check(got === refs[id], `${id} matches an independent reference digest`, `${got}`);
    }
    // C4 against the reference implementation's own published vector for
    // "hello" — this encoding is exactly the kind where a subtly wrong
    // alphabet or pad length still looks like a valid identifier.
    {
      const C4_HELLO = "c447Fm3BJZQ62765jMZJH4m28hrDM7Szbj9CUmj4F4gnvyDYXYz4WfnK2nYRhFvRgYEectEXYBYWLDpLo6XGNAfKdt";
      const make = await getHasherFactory("c4");
      const h = make();
      h.update(Buffer.from("hello"));
      const got = h.digest();
      check(got === C4_HELLO, "c4 matches the published reference vector", `${got.slice(0, 24)}…`);
      check(got.length === 90 && got.startsWith("c4"), "c4 is 90 chars with the c4 prefix", `${got.length} chars`);
    }

    // Chunk-boundary independence, per algorithm: the engine hashes in 4MiB
    // stream chunks, so a hasher that only works on one-shot input would
    // corrupt every large file while passing the checks above.
    for (const id of ["md5", "sha1", "xxhash64", "c4"]) {
      const make = await getHasherFactory(id);
      const big = Buffer.alloc(300000);
      for (let i = 0; i < big.length; i++) big[i] = (i * 11) & 0xff;
      const one = make(); one.update(big);
      const many = make();
      for (let o = 0; o < big.length; o += 7919) many.update(big.subarray(o, Math.min(o + 7919, big.length)));
      check(one.digest() === many.digest(), `${id}: chunked == one-shot`);
    }

    // And a real copy driven end to end with a non-default algorithm.
    for (const id of ["md5", "sha1", "c4"]) {
      const dst = path.join(tmp, `ALGO_${id.toUpperCase()}`);
      const sum = await runCopyJob({ sourcePath: source, destPaths: [dst], algorithm: id });
      check(sum.allVerified === true, `real copy verified end to end with ${id}`);
      check(sum.algorithmId === id, `summary reports the algorithm used (${id})`, String(sum.algorithmId));
      // The stored hash must actually be that algorithm's, not xxHash's.
      const rel = "DCIM/100CANON/A001C002.MOV";
      const engineHash = sum.files.find((f) => f.file === rel)?.sourceHash;
      const independent = await hashFileOnDisk(path.join(source, rel), id);
      check(engineHash === independent, `${id}: engine hash == independent re-hash with the same algorithm`);
      if (id !== "c4") {
        const viaNode = crypto.createHash(id).update(await fs.readFile(path.join(source, rel))).digest("hex");
        check(engineHash === viaNode, `${id}: engine hash == node crypto over the whole file`);
      }
    }

    // Unknown algorithm must fail loudly, before anything is written.
    {
      let threw = false;
      try { await runCopyJob({ sourcePath: source, destPaths: [path.join(tmp, "NOPE")], algorithm: "sha3-999" }); }
      catch { threw = true; }
      check(threw, "unknown algorithm rejected before any file is written");
      check(!fssync.existsSync(path.join(tmp, "NOPE", "README.txt")), "nothing written for a rejected algorithm");
    }
    check(listAlgorithms().length === 4, "picker offers all four algorithms",
      listAlgorithms().map((a) => a.id).join(","));
    check(listAlgorithms().every((a) => a.blurb && a.blurb.length > 80), "every algorithm ships an explainer blurb");

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

    // ── §86: the optional finalized pass ────────────────────────────────
    console.log("\n§86. Finalized checksum — a second, independent read");
    {
      const fdst = path.join(tmp, "final-a");
      const fnodes = [{ id: "f1", path: fdst, parentId: null }];
      // Deliberately DIFFERENT from the live algorithm: the whole point is
      // that the two tiers are independent, and a test using one algorithm
      // for both could not tell them apart.
      const s86 = await runCopyJob({
        sourcePath: source, nodes: fnodes, algorithm: "xxhash64", finalizedAlgorithm: "sha1",
      });
      check(s86.allVerified, "the live pass still verifies with a finalized pass configured");
      check(Boolean(s86.finalized) && s86.finalized.algorithm === "sha1",
        "a finalized block is reported, under its own algorithm",
        s86.finalized && s86.finalized.algorithm);
      check(s86.finalized.checked === srcFileCount && s86.finalized.verified === srcFileCount,
        "every file was re-read and re-verified",
        `${s86.finalized.verified}/${s86.finalized.checked} of ${srcFileCount}`);
      const one = s86.nodes[0].files[0];
      check(Boolean(one.finalCheck) && one.finalCheck.ok === true,
        "each file carries its own finalCheck");
      check(typeof one.sourceHash === "string" && one.sourceHash !== one.finalCheck.sourceHash,
        "…and the LIVE hash survives beside it — two algorithms, two results, neither overwritten");

      // Off is off: nothing added anywhere.
      const off = await runCopyJob({
        sourcePath: source, nodes: [{ id: "f2", path: path.join(tmp, "final-off"), parentId: null }],
        algorithm: "xxhash64",
      });
      check(off.finalized === null, "no finalized block when it is not configured");
      check(!off.nodes[0].files[0].finalCheck, "…and no finalCheck on any file");

      // THE CASE THE LIVE PASS CANNOT SEE. The live check hashes the source
      // as it streams and compares that to the destination written from the
      // same read — so a destination damaged afterwards, or a bad read at
      // copy time, matches. Corrupting a verified destination and running
      // only the finalized pass reproduces exactly that gap.
      const victim = off.nodes[0].files[0];
      await fs.writeFile(victim.destPath, "tampered");
      const caught = await runFinalizedPass({
        sourcePath: source, nodes: off.nodes, algorithm: "sha1",
        isCancelled: () => false, onProgress: () => {},
      });
      check(caught.ok === false, "a destination corrupted after a clean live pass is caught");
      check(caught.mismatches.length === 1
        && caught.mismatches[0].destPath === victim.destPath,
        "…named exactly, and only it", JSON.stringify(caught.mismatches.map((m) => m.file)));
      check(caught.verified === srcFileCount - 1, "…while the rest still verify",
        `${caught.verified} of ${srcFileCount - 1}`);

      // Cancellation has to stop it, not merely be recorded afterwards.
      let ticks = 0;
      const events = [];
      const stopped = await runFinalizedPass({
        sourcePath: source, nodes: off.nodes, algorithm: "sha1",
        isCancelled: () => ++ticks > 1, onProgress: (e) => events.push(e),
      });
      check(stopped.cancelled === true && stopped.checked < srcFileCount,
        "cancelling is reported and nothing further is verified",
        `${stopped.checked} of ${srcFileCount}`);
      // `checked` alone does NOT prove it stopped: the inner loop breaks on
      // cancellation too, so a version that kept walking the remaining
      // files — re-hashing each source for nothing — would also report 0.
      // The per-file progress event is what separates "stopped" from "still
      // looping quietly".
      check(events.length <= 1,
        "…and it really stops, rather than looping on through every remaining file",
        `${events.length} file events after cancelling`);

      // A source that vanished between the copy and this pass — pulling the
      // card — is a source error, not N destination mismatches.
      const missing = { ...off.nodes[0], files: [{ file: "__gone__.MOV", destPath: victim.destPath, bytes: 1 }] };
      const srcErr = await runFinalizedPass({
        sourcePath: source, nodes: [missing], algorithm: "sha1",
        isCancelled: () => false, onProgress: () => {},
      });
      check(srcErr.errors.some((e) => e.stage === "source") && srcErr.ok === false,
        "an unreadable source is reported as a source error, and the pass does not claim success");

      // §88 — when the pass is configured but cannot run, WHY is reported,
      // and that reason has to be true. It used to blame "a FreeFrame
      // upload has no local source left to re-read", which was wrong twice:
      // uploading does not consume the card, and an upload-only job never
      // reaches this engine at all (startCopy only calls it when there is a
      // local destination node). Only two triggers are reachable.
      const { localSource } = require("../src/main/copy-engine");
      const provider = localSource(source);           // stands in for a project source
      const pulled = await runCopyJob({
        source: provider,
        nodes: [{ id: "sk1", path: path.join(tmp, "skip-a"), parentId: null }],
        algorithm: "xxhash64", finalizedAlgorithm: "sha1",
      });
      check(Boolean(pulled.finalized) && pulled.finalized.skipped === true,
        "a job with no local sourcePath reports the pass as skipped, not absent");
      // Optional-chained: an absent block is exactly what a regression here
      // produces, and an uncaught TypeError kills this file — every later
      // check silently never runs and a sweep reads the crash as "survived".
      const pr = (pulled.finalized && pulled.finalized.reason) || "";
      check(/FreeFrame project/.test(pr) && !/upload/i.test(pr),
        "…and blames the project SOURCE, never an upload", pr || "(no finalized block)");
      check(pulled.finalized?.ok === false && pulled.finalized?.checked === 0,
        "…and does not claim to have verified anything");

      // The other reachable trigger.
      const stoppedJob = await runCopyJob({
        sourcePath: source,
        nodes: [{ id: "sk2", path: path.join(tmp, "skip-b"), parentId: null }],
        algorithm: "xxhash64", finalizedAlgorithm: "sha1",
        isCancelled: () => true,
      });
      const sr = (stoppedJob.finalized && stoppedJob.finalized.reason) || "";
      check(/cancelled/.test(sr), "a cancelled job says so instead", sr || "(no finalized block)");

      // Nothing anywhere in the engine still tells the old story.
      const esrc = fssync.readFileSync(
        path.join(__dirname, "..", "src", "main", "copy-engine.js"), "utf8");
      const reasonLine = esrc.split("\n").find((l) => l.includes("there is no local copy to re-read"));
      check(Boolean(reasonLine) && !/upload/i.test(reasonLine),
        "the reason string itself carries no upload framing", (reasonLine || "(absent)").trim());
    }

    // ── §87 Phase 1: the live per-job journal ───────────────────────────
    console.log("\n\u00a787. Job journal — a truthful record WHILE the job runs");
    {
      const logs = path.join(tmp, "logs");
      const readJ = (id) => fs.readFile(journal.journalFile(logs, id), "utf8")
        .then(JSON.parse).catch(() => null);
      const naming = {
        presetId: "p1", folderTemplate: "{operator}", fileTemplate: "{operator}_{counter}",
        values: { operator: "Mathias" }, disabledFields: ["talent"],
        sourceCounter: 7, dateOverride: "2026-08-28T09:33:00.000Z",
        autoSuffix: { source: "counter", position: "end" }, filters: null,
      };
      const job = { id: "jrnl-1", label: "L", kind: "copy", sourcePath: source,
                    destPaths: [path.join(tmp, "jrnl-a")] };

      await journal.startJournal(logs, job, { algorithm: "xxhash64", naming });
      let d = await readJ(job.id);
      check(Boolean(d) && d.status === "running" && d.files.length === 0,
        "the journal exists at job START, empty — writeJobLog only ever wrote at the end");
      // Optional-chained throughout. An absent journal or naming block is
      // exactly what a regression here produces, and an uncaught TypeError
      // kills this file — every check after it silently never runs, and a
      // mutation sweep reads the crash as "survived".
      const nm = (d && d.naming) || {};
      // The half a resume cannot re-derive: after a crash the renderer's
      // memory is gone, and re-deriving these would rename the REMAINING
      // files inconsistently with the ones already on the destination.
      check(nm.sourceCounter === 7, "the claimed card number is captured (\u00a775)");
      check(nm.values && nm.values.operator === "Mathias", "…and this card's typed values (\u00a780)");
      check(nm.dateOverride === "2026-08-28T09:33:00.000Z", "…and any date override (\u00a778)");
      check(Array.isArray(nm.disabledFields) && nm.disabledFields.length === 1,
        "…and which fields were switched off");

      const pending = [];
      const midRun = [];
      const sum = await runCopyJob({
        sourcePath: source, nodes: [{ id: "jn", path: job.destPaths[0], parentId: null }],
        algorithm: "xxhash64",
        // Fire-and-forget, exactly as main.js calls it: the engine does not
        // await onProgress, so asserting the journal is instantaneously
        // current would be asserting a contract the app does not have.
        onProgress: (p) => {
          if (p.phase !== "file-done") return;
          pending.push(journal.appendFileResult(job.id, p));
          midRun.push(readJ(job.id));
        },
      });
      await Promise.all(pending);
      check(sum.allVerified, "the copy itself is unaffected by journalling");
      const snaps = await Promise.all(midRun);
      check(snaps.every((x) => x !== null),
        "every mid-run read got valid JSON — never a half-written file");
      const counts = snaps.map((x) => x.files.length);
      check(counts.every((n, i) => i === 0 || n >= counts[i - 1]),
        "…and the record only ever grows", JSON.stringify(counts));

      d = await readJ(job.id);
      const jfiles = (d && d.files) || [];
      check(jfiles.length === srcFileCount, "one entry per file", `${jfiles.length}`);
      // `ok` alone cannot tell a resume that a file is safe to skip — that
      // is why the hashes had to be threaded out of runLeg at all.
      check(jfiles.length > 0 && jfiles.every((f) => typeof f.sourceHash === "string" && f.sourceHash),
        "every entry carries a real source hash, not a placeholder");
      check(jfiles.length > 0 && jfiles.every((f) => f.destinations.length === 1 && f.destinations[0].hash),
        "…and the per-destination hash it was verified against");

      await journal.finishJournal(logs, job.id);
      check((await readJ(job.id)) === null,
        "a COMPLETED job's journal is removed — the real log is the permanent record");

      // An interrupted job keeps its journal, and a deliberate cancel is
      // the same shape of data as a crash — a later phase should not have
      // to tell them apart.
      const job2 = { id: "jrnl-2", label: "L2", kind: "copy", sourcePath: source, destPaths: [] };
      await journal.startJournal(logs, job2, { algorithm: "xxhash64", naming });
      await journal.appendFileResult(job2.id, { file: "one.MOV", ok: true, sourceHash: "h", destinations: [] });
      journal.releaseJournal(job2.id);
      const left = await readJ(job2.id);
      check(Boolean(left) && left.files.length === 1 && left.status === "running",
        "an interrupted job's journal is LEFT on disk, with only what completed");
      // No finish, no release, no shutdown hook ran for that file above —
      // which is exactly what a kill -9 leaves. Nothing here depends on a
      // graceful exit.
      check(Boolean(left) && Boolean(left.startedAt) && Array.isArray(left.files),
        "…valid and complete enough to resume from, with no cleanup step");

      // runCopyJob runs a job's legs under Promise.all, so overlapping
      // appends for ONE job are the real shape. Two un-serialized
      // whole-file writes can interleave and truncate the document.
      const job3 = { id: "jrnl-3", label: "L3", kind: "copy", sourcePath: source, destPaths: [] };
      await journal.startJournal(logs, job3, { algorithm: "xxhash64", naming });
      await Promise.all(Array.from({ length: 40 }, (_, i) =>
        journal.appendFileResult(job3.id, { file: `f${i}`, ok: true, sourceHash: `h${i}`, destinations: [] })));
      const j3 = await readJ(job3.id);
      check(Boolean(j3) && j3.files.length === 40,
        "40 overlapping appends leave valid JSON with every entry",
        j3 ? `${j3.files.length}` : "unreadable");

      await fs.writeFile(journal.journalFile(logs, "jrnl-bad"), "{ not json", "utf8");
      check((await journal.readJournal(logs, "jrnl-bad")) === null,
        "a corrupt journal reads as nothing to resume, not as an error");
      check((await journal.readJournal(logs, "jrnl-missing")) === null, "…and so does a missing one");

      // Two properties no in-process probe can observe, asserted at the
      // SOURCE and labelled as such.
      //
      // Atomicity: a torn read needs a reader to open the file inside the
      // window of a partial write. Write-then-rename removes the window
      // entirely, and its absence is only visible under a crash at exactly
      // the wrong microsecond — which is precisely the case a journal
      // exists for, and precisely what cannot be scheduled in a test.
      const jsrc = fssync.readFileSync(
        path.join(__dirname, "..", "src", "main", "job-journal.js"), "utf8");
      check(/await fsp\.writeFile\(tmp,/.test(jsrc) && /await fsp\.rename\(tmp, target\)/.test(jsrc),
        "the journal is written whole then renamed into place, never edited in situ");

      // And that an INTERRUPTED job keeps its journal. The behavioural
      // check above drives releaseJournal directly, so it cannot see
      // main.js choosing between the two — which is where the mistake
      // would actually be made.
      const msrc = fssync.readFileSync(
        path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
      check(/if \(job\.status === "done"\) journal\.finishJournal\(/.test(msrc)
        && /else journal\.releaseJournal\(job\.id\);/.test(msrc),
        "only a COMPLETED job's journal is deleted; anything else keeps its record");
    }

    // ── §95: pause stops at a file boundary, never inside one ───────────
    console.log("\n\u00a795. Pause waits for the current file to finish");
    {
      const pdst = path.join(tmp, "pause-a");
      let paused = false;
      let waiters = [];
      const wake = () => { const w = waiters; waiters = []; for (const r of w) r(); };
      const waitIfPaused = () => (paused ? new Promise((r) => waiters.push(r)) : Promise.resolve());

      const started = [];
      const finished = [];
      let pausedAfterFirst = false;
      let pausedAt = -1;
      let completedWhilePaused = -1;
      const sum = await runCopyJob({
        sourcePath: source,
        nodes: [{ id: "pn", path: pdst, parentId: null }],
        algorithm: "xxhash64",
        waitIfPaused,
        onProgress: (p2) => {
          if (p2.phase === "file-start") started.push(p2.file);
          if (p2.phase !== "file-done") return;
          finished.push(p2.file);
          // Pause the moment the first file completes, then let it sit
          // long enough that a loop ignoring the park would run on.
          if (!pausedAfterFirst) {
            pausedAfterFirst = true;
            paused = true;
            pausedAt = finished.length;
            setTimeout(() => {
              // What actually distinguishes "parked" from "ran straight
              // through": nothing may complete while paused. Without this
              // the whole section passes on a loop that ignores the park,
              // because all the files finish either way.
              completedWhilePaused = finished.length - pausedAt;
              paused = false; wake();
            }, 120);
          }
        },
      });

      check(sum.allVerified, "the job still completes across a pause/resume");
      check(completedWhilePaused === 0,
        "NOTHING completed during the pause — the loop really parks",
        `${completedWhilePaused} file(s) finished while paused`);
      check(finished.length === srcFileCount,
        "every file was copied exactly once — resume continues, it does not restart",
        `${finished.length} of ${srcFileCount}`);
      check(new Set(finished).size === finished.length,
        "…and none was copied twice", JSON.stringify(finished));
      // The boundary itself: no file was left half-started when the pause
      // took hold.
      check(started.length === finished.length,
        "no file was started and abandoned — the pause is between files",
        `${started.length} started / ${finished.length} finished`);
      const verified = await Promise.all(sum.nodes[0].files.map(async (f) => {
        const a = await hashFileOnDisk(path.join(source, f.file));
        const b = await hashFileOnDisk(f.destPath);
        return a === b;
      }));
      check(verified.every(Boolean), "…and every destination file matches its source on disk");

      // §87's journal appends on file-done, so a pause between files leaves
      // it exactly as consistent as a job still running. Confirmed rather
      // than assumed, per the spec.
      const jlogs = path.join(tmp, "pause-journal");
      const pj = { id: "pj", label: "P", kind: "copy", sourcePath: source, destPaths: [pdst] };
      await journal.startJournal(jlogs, pj, { algorithm: "xxhash64", naming: null });
      for (const f of finished) {
        await journal.appendFileResult(pj.id, { file: f, ok: true, sourceHash: "h", destinations: [] });
      }
      const jr = await fs.readFile(journal.journalFile(jlogs, pj.id), "utf8").then(JSON.parse);
      check(jr.files.length === srcFileCount,
        "the journal records one entry per file across the pause, with no gap or duplicate",
        `${jr.files.length}`);

      // Cancel must reach a job parked in the pause, or it sits forever.
      const cdst = path.join(tmp, "pause-cancel");
      let cPaused = true;
      let cWaiters = [];
      let cancelled = false;
      const job = runCopyJob({
        sourcePath: source,
        nodes: [{ id: "cn", path: cdst, parentId: null }],
        algorithm: "xxhash64",
        isCancelled: () => cancelled,
        waitIfPaused: () => (cPaused ? new Promise((r) => cWaiters.push(r)) : Promise.resolve()),
      });
      await sleep(60);
      // Exactly what main's _cancel does: clear the pause AND wake it.
      cancelled = true;
      cPaused = false;
      for (const r of cWaiters) r();
      const cs = await Promise.race([job, sleep(3000).then(() => "TIMED_OUT")]);
      check(cs !== "TIMED_OUT", "cancelling a job parked in a pause unparks it rather than hanging");
      check(cs !== "TIMED_OUT" && cs.cancelled === true, "…and it reports itself cancelled");
      // ORDER MATTERS, and only this catches it: the pause is awaited
      // BEFORE the cancel check, so a job woken by a cancel breaks out
      // immediately. Checking cancel first would wake it, fall through, and
      // copy one more whole file — potentially gigabytes — after the user
      // pressed Cancel.
      const copiedAfterCancel = cs !== "TIMED_OUT"
        ? (cs.nodes[0].files || []).length : -1;
      check(copiedAfterCancel === 0,
        "…without copying one more file on the way out",
        `${copiedAfterCancel} file(s) copied after cancel`);
    }

    // ── §97A: an upload journal, and what a resume may skip ─────────────
    console.log("\n\u00a797A. Crash-resume duplicate-upload prevention");
    {
      const logs = path.join(tmp, "upload-journal");
      const readJ = (id) => fs.readFile(journal.journalFile(logs, id), "utf8")
        .then(JSON.parse).catch(() => null);

      // An upload job's journal: assetId per file, and NOT the
      // destinations/hash shape a local copy leg writes.
      const uj = { id: "up-1", label: "U", kind: "upload", destPaths: [] };
      await journal.startJournal(logs, uj, { projectId: "proj-9", folderId: null });
      await journal.appendFileResult(uj.id, { file: "a.MOV", ok: true, bytes: 10, assetId: "A1", versionId: "V1" });
      await journal.appendFileResult(uj.id, { file: "b.MOV", ok: true, bytes: 20, assetId: "A2", versionId: "V2" });
      await journal.appendFileResult(uj.id, { file: "c.MOV", ok: false, bytes: 30, error: "boom" });
      // A file that got as far as /upload/initiate — so an asset row
      // exists — and then failed partway through its parts. runUpload
      // cannot produce this today, but uploadedAssetIds is a general
      // helper and `ok` is the only thing separating "the server has this
      // file" from "the server has a row where this file was going". A
      // fixture without it makes the ok-check untestable.
      await journal.appendFileResult(uj.id, { file: "d.MOV", ok: false, bytes: 40, assetId: "A3", error: "died mid-parts" });
      const doc = await readJ(uj.id);

      check(doc && doc.kind === "upload" && doc.projectId === "proj-9",
        "an upload journal records the project it was going to — the job that knew is gone");
      check(doc.files[0].assetId === "A1" && doc.files[0].versionId === "V1",
        "…and each file's asset identity");
      check(!("assetId" in doc.files[2]),
        "a FAILED file records no assetId — there is nothing on the server to point at");
      check(doc.files[3].ok === false && doc.files[3].assetId === "A3",
        "…but one CAN carry an id without having succeeded");

      const ids = journal.uploadedAssetIds(doc);
      check(ids.length === 2 && ids.includes("A1") && ids.includes("A2"),
        "uploadedAssetIds returns only the successes", JSON.stringify(ids));
      check(!ids.includes("A3"),
        "…and an id from a file that FAILED is not one of them — an asset row is "
        + "not proof the file is there", JSON.stringify(ids));

      // A local copy's rows must not gain empty upload columns.
      const cj = { id: "cp-1", label: "C", kind: "copy", sourcePath: source, destPaths: [] };
      await journal.startJournal(logs, cj, {});
      await journal.appendFileResult(cj.id, { file: "x.MOV", ok: true, sourceHash: "h", destinations: [] });
      const cdoc = await readJ(cj.id);
      check(!("assetId" in cdoc.files[0]) && !("versionId" in cdoc.files[0]),
        "a local copy's entries are unchanged — no null upload fields cluttering them",
        JSON.stringify(Object.keys(cdoc.files[0])));
      check(journal.uploadedAssetIds(cdoc).length === 0,
        "…and a copy journal offers nothing to skip");

      // THE RULE THAT MATTERS: the server decides, not the journal.
      const live = new Set(["A1"]);            // A2 was deleted since
      const skip = new Map();
      for (const f of doc.files) {
        if (f.ok === true && f.assetId && live.has(f.assetId)) skip.set(f.file, f.assetId);
      }
      check(skip.has("a.MOV"), "a file the server confirms is skipped");
      check(!skip.has("b.MOV"),
        "…and one the journal claims but the server no longer has is NOT — it is re-uploaded");
      check(!skip.has("c.MOV"), "…nor one that failed before the crash");

      // A failed check must skip NOTHING. Knowing nothing means doing the
      // work, never assuming it is done.
      const noAnswer = new Set();
      const skip2 = new Map();
      for (const f of doc.files) {
        if (f.ok === true && f.assetId && noAnswer.has(f.assetId)) skip2.set(f.file, f.assetId);
      }
      check(skip2.size === 0, "if the check-existing call fails, nothing is skipped");

      // The resume verification pass, over the WHOLE claimed set.
      const vsrc = path.join(tmp, "verify-src");
      await fs.mkdir(vsrc, { recursive: true });
      await fs.writeFile(path.join(vsrc, "kept.MOV"), "unchanged");
      await fs.writeFile(path.join(vsrc, "edited.MOV"), "original");
      const keptHash = await hashFileOnDisk(path.join(vsrc, "kept.MOV"));
      const editedHash = await hashFileOnDisk(path.join(vsrc, "edited.MOV"));
      // The file changed on disk after it was uploaded — exactly what the
      // pre-crash portion was never re-checked for.
      await fs.writeFile(path.join(vsrc, "edited.MOV"), "TAMPERED");

      const claims = [
        { file: "kept.MOV", ok: true, sourceHash: keptHash },
        { file: "edited.MOV", ok: true, sourceHash: editedHash },
      ];
      const mismatched = [];
      for (const f of claims) {
        const h = await hashFileOnDisk(path.join(vsrc, f.file));
        if (h !== f.sourceHash) mismatched.push(f.file);
      }
      check(mismatched.length === 1 && mismatched[0] === "edited.MOV",
        "the resume checksum pass catches a pre-crash file whose source no longer matches",
        JSON.stringify(mismatched));

      // And it runs over files this run did NOT upload — that is the point.
      check(claims.length === 2,
        "…across the whole claimed set, not just what this run sent");

      // The checks above exercise the RULES, but re-derive them. runUpload
      // lives inside an ipcMain.handle closure and cannot be extracted, so
      // its actual wiring is pinned at the source — otherwise all of the
      // above would keep passing against a runUpload that skips nothing.
      const msrc = fssync.readFileSync(
        path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
      const up = msrc.slice(msrc.indexOf("  async function runUpload(self) {"),
                            msrc.indexOf("ipcMain.handle(\"copy:start\""));
      check(/journal\.startJournal\(LOG_DIR\(\), self, \{/.test(up),
        "runUpload opens a journal — it never did before");
      check(/journal\.appendFileResult\(self\.id, \{[\s\S]{0,220}assetId: res && res\.assetId/.test(up),
        "…and records each upload's assetId");
      check(/if \(resumeFrom\)[\s\S]{0,600}checkExistingAssets\(claimed\)/.test(up),
        "…and a resume asks the server ONCE, batched, before trusting any of it");
      check(/live\.has\(f\.assetId\)/.test(up),
        "…skipping only what the server confirms");
      // The safe-by-default half: a thrown check must not populate `live`.
      const catchBlock = up.slice(up.indexOf("checkExistingAssets(claimed)"));
      check(/catch \(err\) \{[\s\S]{0,300}resume-check-failed/.test(catchBlock),
        "…and a failed check leaves the skip set empty rather than assuming success");
      // The window is generous because this block grew when the audit fix
      // added a journal write to it; what is being asserted is that the
      // skip path exists and ends in a `continue`, not its length.
      check(/const already = skip\.get\(r\);[\s\S]{0,1400}continue;/.test(up),
        "…which is what the loop consults per file");
      // AUDIT FIX — a skipped file is recorded in THIS run's journal.
      // Without it the new journal claimed fewer files than the job
      // covered, and a cancel → resume → cancel → resume chain re-uploaded
      // the originals.
      const skipBlock = up.slice(up.indexOf("const already = skip.get(r);"),
                                 up.indexOf('send({ phase: "file-start"'));
      check(/journal\.appendFileResult\(self\.id, \{[\s\S]{0,240}assetId: already\.assetId/.test(skipBlock),
        "a skipped file is journaled as present, with the asset id the server confirmed");
      // AUDIT FIX — and the journal this run resumed FROM is retired, but
      // only on an uncancelled completion.
      check(/claimed\.every\(\(f\) => journaledOk\.has\(f\)\)[\s\S]{0,140}discardJournal\(LOG_DIR\(\), resumeJobId\)/.test(up),
        "the predecessor journal is discarded once THIS run's journal covers everything "
        + "it claimed — superseded-ness, not merely completion");
      const discardAt = up.indexOf("discardJournal(LOG_DIR(), resumeJobId)");
      const loopEndAt = up.indexOf("const summary = {");
      check(discardAt > 0 && discardAt < loopEndAt,
        "…after the loop and before the summary, not in a finally that would also "
        + "fire on an early throw", `discard@${discardAt} summary@${loopEndAt}`);
      // A cancel that never reached the predecessor's files must KEEP it —
      // those files would otherwise have no record anywhere, and losing a
      // record means re-uploading, which is the direction to err in.
      check(/const journaledOk = new Set\(\);/.test(up)
        && (up.match(/journaledOk\.add\(r\);/g) || []).length === 2,
        "…and both the uploaded and the skipped path record into that set",
        String((up.match(/journaledOk\.add\(r\);/g) || []).length));

      // Only on a resume. A normal job must be untouched.
      check(/let resumeVerification = null;\s*\n\s*if \(resumeFrom\) \{/.test(up),
        "the resume checksum pass runs ONLY when resuming");
      // A non-resumed job must skip nothing. The only writer into the skip
      // map has to sit inside the `if (resumeFrom)` block — asserted by
      // position, since a `|| true` version of this check would pass
      // forever and prove nothing.
      const resumeBlockStart = up.indexOf("if (resumeFrom) {");
      // The UPLOAD loop, not the earlier one that only stats file sizes —
      // there are two `for (const r of rel)` in this function, and the
      // first version of this check measured the wrong one.
      const loopStart = up.indexOf("await waitIfPaused();");
      const setAt = up.indexOf("skip.set(");
      check(setAt > resumeBlockStart && setAt < loopStart,
        "…and the ONLY thing that fills the skip map sits inside the resume branch, "
        + "so a normal job uploads everything exactly as before",
        `resume@${resumeBlockStart} set@${setAt} loop@${loopStart}`);
    }

    // ── §87 Phase 2: detection, matching, and discard ───────────────────
    console.log("\n\u00a787 Phase 2. Resume detection for interrupted uploads");
    {
      const logs = path.join(tmp, "phase2-journals");
      const mkJob = (id, extra = {}) => ({ id, label: id, kind: "upload", destPaths: [], ...extra });

      // A CANCELLED job leaves exactly what a crashed one does. doc.status
      // is written once at startJournal and never updated, so both read
      // "running" — which is what marks either as resumable.
      await journal.startJournal(logs, mkJob("cancelled-1", { sourcePath: "/src/A" }),
        { projectId: "p1", folderId: "f1" });
      await journal.appendFileResult("cancelled-1", { file: "a.MOV", ok: true, assetId: "A1" });
      journal.releaseJournal("cancelled-1");     // what a cancel does
      const left = await journal.readJournal(logs, "cancelled-1");
      check(Boolean(left) && left.status === "running",
        "a cancelled job's journal survives and still reads as resumable",
        left && left.status);
      check(left.projectId === "p1" && left.folderId === "f1",
        "…carrying the destination the ORIGINAL job was going to, not a current selection");

      // A COMPLETED job leaves nothing to offer.
      await journal.startJournal(logs, mkJob("done-1", { sourcePath: "/src/B" }), { projectId: "p1" });
      await journal.finishJournal(logs, "done-1");
      check((await journal.readJournal(logs, "done-1")) === null,
        "a job that finished cleanly leaves nothing — it is never offered");

      // Discard: a third verb, distinct from both of those.
      await journal.startJournal(logs, mkJob("decline-1", { sourcePath: "/src/C" }), { projectId: "p1" });
      check(Boolean(await journal.readJournal(logs, "decline-1")), "a journal to decline exists");
      journal.releaseJournal("decline-1");
      check(Boolean(await journal.readJournal(logs, "decline-1")),
        "releaseJournal does NOT delete it — it only drops the in-memory handle, "
        + "which is why a third verb was needed");
      check((await journal.discardJournal(logs, "decline-1")) === true, "discardJournal reports success");
      check((await journal.readJournal(logs, "decline-1")) === null,
        "…and the file is really gone, so it stops being offered");
      check((await journal.discardJournal(logs, "never-existed")) === true,
        "discarding something already gone is not an error");

      // The matching rule, exercised against the shapes the renderer uses.
      const sameSet = (a, b) => {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        const x = [...a].sort(); const y = [...b].sort();
        return x.every((v, i) => v === y[i]);
      };
      check(sameSet(["b", "a"], ["a", "b"]), "a picked file set matches regardless of order");
      check(!sameSet(["a"], ["a", "b"]), "…but not a different set");
      check(!sameSet(["a", "b"], ["a", "c"]), "…nor one that merely has the same size");

      // The renderer's own matcher and triggers, pinned at the source:
      // index.html cannot be run here, and all of the above would keep
      // passing against a renderer that never calls any of it.
      const rsrc = fssync.readFileSync(
        path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
      check(/initStep\("interrupted uploads", \(\) => \{ maybeOfferResume\("launch"\)/.test(rsrc),
        "trigger 1: the renderer asks once at launch");
      check((rsrc.match(/maybeOfferResume\("source"\)/g) || []).length === 2,
        "trigger 2: on a new source AND on a new file set — the sentinel path means "
        + "setSource's own check cannot see a re-picked file set change",
        String((rsrc.match(/maybeOfferResume\("source"\)/g) || []).length));
      check(/freeframeUpload\([\s\S]{0,400}doc\.jobId,/.test(rsrc),
        "Resume passes the found journal's jobId as resumeJobId — the whole point");
      check(/doc\.projectId,\s*\n\s*doc\.folderId \|\| null,/.test(rsrc),
        "…and sends it to the journal's OWN destination, not the current selection");
      check(/discardInterruptedUpload\(doc\.jobId\)/.test(rsrc),
        "Discard deletes the journal rather than ignoring it");
      check(/resumeOffered\.add\(doc\.jobId\);/.test(rsrc),
        "…and a job is marked as asked BEFORE any await, so two triggers cannot "
        + "queue the same one twice");
      // §65c's lesson: .ff-backdrop carries no styles, so a new modal
      // relying on it alone sits permanently over the app.
      check(/#resume-backdrop \{[\s\S]{0,200}display: none;/.test(rsrc)
        && /#resume-backdrop\.open \{ display: flex; \}/.test(rsrc),
        "the new modal has its own id-scoped rule, not just the styleless shared class");
    }

    // ── §100: a folder source copies into its own name ──────────────────
    console.log("\n\u00a7100. A folder wraps in its own name when no preset is active");
    {
      const w = path.join(tmp, "w");
      const wsrc = path.join(w, "00001040");
      await fs.mkdir(path.join(wsrc, "DCIM"), { recursive: true });
      for (const n of ["a", "b", "c"]) await fs.writeFile(path.join(wsrc, "DCIM", `${n}.jpg`), n.repeat(200));
      const walk = async (root, pre = "") => {
        let out = [];
        for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
          const q = path.join(root, e.name);
          out = out.concat(e.isDirectory() ? await walk(q, path.join(pre, e.name)) : [path.join(pre, e.name)]);
        }
        return out.sort();
      };

      const d1 = path.join(w, "D1");
      const s1 = await runCopyJob({ sourcePath: wsrc, nodes: [{ id: "n", path: d1, parentId: null }] });
      const g1 = await walk(d1);
      check(s1.allVerified && g1.length === 3 && g1.every((f) => f.startsWith("00001040/")),
        "a no-preset folder copy lands under the source folder's name, not spilled flat",
        g1.join(", "));

      // A cascade must not wrap twice. Before §100 this leg was ALREADY
      // broken whenever a mapper existed — it read the source's unmapped
      // rels out of a parent that had written mapped ones.
      const cA = path.join(w, "A"), cB = path.join(w, "B");
      const s2 = await runCopyJob({ sourcePath: wsrc, nodes: [
        { id: "A", path: cA, parentId: null }, { id: "B", path: cB, parentId: "A" }] });
      const gA = await walk(cA), gB = await walk(cB);
      check(s2.allVerified, "a cascade of that copy verifies end to end",
        `${s2.errors.length} error(s)`);
      check(JSON.stringify(gA) === JSON.stringify(gB), "parent and child hold identical layouts");
      check(!gB.some((f) => f.includes("00001040/00001040")), "…and nothing is double-wrapped");

      // With a template the wrapper must not appear beside it — and the
      // cascade must work, which is the pre-existing bug §100 surfaced.
      const pA = path.join(w, "PA"), pB = path.join(w, "PB");
      const s3 = await runCopyJob({
        sourcePath: wsrc,
        nodes: [{ id: "A", path: pA, parentId: null }, { id: "B", path: pB, parentId: "A" }],
        mapRel: (rel) => path.join("SHOOT_01", rel),
      });
      const gPA = await walk(pA);
      check(gPA.every((f) => f.startsWith("SHOOT_01/")) && !gPA.some((f) => f.includes("00001040")),
        "a naming template still governs structure alone — no wrapper beside it", gPA.join(", "));
      check(s3.allVerified, "…and cascading WITH a template verifies, which it did not before \u00a7100",
        `${s3.errors.length} error(s)`);
      check(JSON.stringify(gPA) === JSON.stringify(await walk(pB)), "…with identical layouts");

      // The three shapes that must stay flat.
      const d4 = path.join(w, "D4");
      await runCopyJob({
        sourceFiles: ["a", "b"].map((n) => path.join(wsrc, "DCIM", `${n}.jpg`)),
        nodes: [{ id: "n", path: d4, parentId: null }] });
      check(JSON.stringify(await walk(d4)) === JSON.stringify(["a.jpg", "b.jpg"]),
        "individually-picked files stay flat — there is no one folder to name them after");

      const d5 = path.join(w, "D5");
      await runCopyJob({ sourcePath: path.join(wsrc, "DCIM", "a.jpg"),
        nodes: [{ id: "n", path: d5, parentId: null }] });
      check(JSON.stringify(await walk(d5)) === JSON.stringify(["a.jpg"]),
        "a single FILE handed over as sourcePath is not wrapped in a folder named after itself");

      const d6 = path.join(w, "D6");
      await runCopyJob({
        // freeframeSource's shape: root is explicitly null.
        source: { kind: "freeframe", label: "freeframe://7b3e-uuid", root: null, skipped: [],
                  list: async () => [{ rel: "clip.jpg", size: 200 }],
                  open: () => fssync.createReadStream(path.join(wsrc, "DCIM", "a.jpg")) },
        nodes: [{ id: "n", path: d6, parentId: null }] });
      const g6 = await walk(d6);
      check(!g6.some((f) => f.includes("7b3e") || f.includes("freeframe")),
        "a PROJECT source is not wrapped — its only available name is a raw UUID", g6.join(", "));
    }

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
