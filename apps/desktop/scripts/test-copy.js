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
