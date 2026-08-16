#!/usr/bin/env node
// Upload summary, single-file sources, OS drag-and-drop — and above all,
// **does an upload actually land on FreeFrame?**
//
// Section 1 is the one that matters. It uploads a real file of each type
// and then proves what happened by asking the server, not by trusting the
// client's own "the call didn't throw". The reported bug — zero files
// appearing on the site — was caused by every upload being sent as
// application/octet-stream, which the API maps to AssetType.video
// unconditionally: an image or audio file was created as a video, the
// ffmpeg branch failed on it, and list_assets hides assets whose versions
// all failed. Bytes in S3, row in the database, nothing on the site.
//
// The assets it uploads are left in the project (named ffdesk-<timestamp>)
// and listed at the end for removal — see the cleanup note in section 6.
//
// Run: node scripts/e2e-upload.js
const { spawn, execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnElectron } = require("./lib/electron-harness");
const APP = path.join(__dirname, "..");
const PORT = 9317;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(1200);

  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" }
  );

  let page;
  for (let i = 0; i < 80; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!page) { console.error("Electron never came up"); process.exit(1); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  });
  const send = (me, pa = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id: i, method: me, params: pa }));
  });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 600000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result.value;
  };
  await send("Runtime.enable");
  await sleep(1800);

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-up-"));

  // ── 1. DOES AN UPLOAD LAND? ──────────────────────────────────────────
  console.log("1. Do uploads actually land on FreeFrame?");

  const status = await ev(`window.freeframe.freeframeStatus()`);
  if (!status.loggedIn) {
    console.log("\n  NOT SIGNED IN — this is the section that matters and it cannot run.");
    console.log("  Sign in via the app's account button, then re-run.\n");
    child.kill("SIGKILL");
    process.exit(2);
  }
  console.log(`     signed in as ${status.user?.name || status.user?.email}`);

  const projects = (await ev(`window.freeframe.freeframeProjects()`)).projects || [];
  const project = projects.find((p) => /test/i.test(p.name)) || projects[0];
  if (!project) { console.log("  No project available."); child.kill("SIGKILL"); process.exit(2); }
  console.log(`     into project "${project.name}"\n`);

  // One file per asset_type branch. The bug was invisible for video and
  // fatal for everything else, so image and audio are the cases that
  // actually prove the fix; video proves nothing regressed.
  const stamp = Date.now();
  const made = [];

  // Real files, not renamed blobs — a fake .jpg would fail processing for
  // its own reasons and muddy the exact signal being measured.
  const jpegPath = path.join(tmp, `ffdesk-${stamp}.jpg`);
  try {
    execSync(`sips -s format jpeg -Z 400 /System/Library/CoreServices/DefaultDesktop.heic --out "${jpegPath}"`,
      { stdio: "ignore" });
    made.push({ name: path.basename(jpegPath), path: jpegPath, size: (await fsp.stat(jpegPath)).size, expect: "image" });
  } catch { console.log("     (no jpeg — sips failed)"); }

  // A real WAV: 44-byte canonical header plus silence.
  const body = Buffer.alloc(16000);
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const wav = Buffer.concat([
    Buffer.from("RIFF"), u32(36 + body.length), Buffer.from("WAVEfmt "), u32(16),
    u16(1), u16(1), u32(8000), u32(8000), u16(1), u16(8),
    Buffer.from("data"), u32(body.length), body,
  ]);
  const wavPath = path.join(tmp, `ffdesk-${stamp}.wav`);
  await fsp.writeFile(wavPath, wav);
  made.push({ name: path.basename(wavPath), path: wavPath, size: wav.length, expect: "audio" });

  // A genuine small mp4, if one is lying around from a previous pull —
  // there's no ffmpeg on this machine to synthesise one, and a fabricated
  // .mp4 would fail transcoding for reasons unrelated to what's being
  // tested. Skipped rather than faked when unavailable.
  try {
    const leftovers = execSync(
      `ls -S /var/folders/*/*/T/ff-pull-*/*.mp4 /var/folders/*/*/T/ff-cmp*/*.mp4 2>/dev/null | tail -1`,
      { encoding: "utf8", shell: "/bin/zsh" }
    ).trim();
    if (leftovers) {
      const mp4 = path.join(tmp, `ffdesk-${stamp}.mp4`);
      await fsp.copyFile(leftovers, mp4);
      made.push({ name: path.basename(mp4), path: mp4, size: (await fsp.stat(mp4)).size, expect: "video" });
    }
  } catch { /* no sample available */ }

  console.log(`     uploading: ${made.map((m) => `${m.name} (${m.expect})`).join(", ")}`);
  if (!made.some((m) => m.expect === "video")) {
    console.log("     note: no video sample available locally — video was never affected by this bug,");
    console.log("           and a fabricated .mp4 would fail transcoding for unrelated reasons.");
  }

  const summary = await ev(`window.freeframe.freeframeUpload(
    null, ${JSON.stringify(project.id)}, null, ${JSON.stringify(made.map((m) => m.path))}
  )`);
  console.log(`     client reports: ${summary.filesCopied}/${summary.totalFiles} sent` +
    (summary.errors.length ? `, ${summary.errors.length} error(s)` : ""));
  for (const e of summary.errors) console.log(`       ERROR ${e.file}: ${e.error}`);

  // ── THE ACTUAL CHECK ────────────────────────────────────────────────
  //
  // Ask the server what it has, rather than trusting the client's own
  // "the call didn't throw". This works as a proof because
  // `list_assets` **hides assets whose versions all failed**
  // (include_failed defaults to False) — which is precisely how the
  // original bug stayed invisible. So appearing in this listing at all
  // means the asset exists AND processed without failing.
  //
  // freeframeListAssets splits the response: `files` are pullable
  // originals (video), `skipped` are assets it can see but can't download
  // the original of (processed image/audio). Both prove existence; the
  // skip reason additionally names the asset_type the server assigned,
  // which is the exact thing the octet-stream bug got wrong.
  console.log("     waiting for server-side processing…");
  let seen = null;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    seen = await ev(`window.freeframe.freeframeListAssets(${JSON.stringify(project.id)}, "root", true)`);
    const names = new Set([...(seen.files || []).map((f) => f.rel), ...(seen.skipped || []).map((s) => s.name)]);
    const pending = (seen.skipped || []).filter((s) => /still |no file yet/.test(s.reason)).length;
    if (made.every((m) => names.has(m.name)) && pending === 0) break;
  }

  for (const m of made) {
    const inFiles = (seen.files || []).find((f) => f.rel === m.name);
    const inSkipped = (seen.skipped || []).find((s) => s.name === m.name);
    const exists = Boolean(inFiles || inSkipped);

    check(exists, `"${m.name}" exists server-side and did NOT fail processing`,
      inFiles ? `${inFiles.size} bytes, downloadable`
        : inSkipped ? inSkipped.reason
        : "NOT LISTED — either missing or failed processing (both are hidden by list_assets)");

    if (inFiles) {
      check(inFiles.size === m.size, `"${m.name}" landed at the right size`, `${inFiles.size} vs ${m.size}`);
    }
    // The skip reason names the asset_type the server assigned. Before the
    // fix every upload was octet-stream → AssetType.video, so an image
    // would have read "for video" here — if it had survived at all.
    if (inSkipped && m.expect !== "video") {
      check(inSkipped.reason.includes(`for ${m.expect}`),
        `…and was classified as ${m.expect}, not video`, inSkipped.reason);
    }
  }

  check(
    made.every((m) => {
      return (seen.files || []).some((f) => f.rel === m.name) ||
             (seen.skipped || []).some((s) => s.name === m.name);
    }),
    "EVERY uploaded file is visible server-side — uploads land, and land correctly"
  );

  // ── 2. Summary display ───────────────────────────────────────────────
  console.log("\n2. Upload summary reads as an upload, not a broken copy");
  await ev(`renderSummary(${JSON.stringify(summary)}); true`);
  const rendered = await ev(`(() => {
    const b = document.getElementById("summary");
    return {
      head: b.querySelector("h3").textContent,
      headClass: b.querySelector("h3").className,
      stats: [...b.querySelectorAll(".stats span")].map(s => s.textContent.trim()),
      verdict: b.querySelector(".verdict").textContent,
      verdictClass: b.querySelector(".verdict").className,
    };
  })()`);
  console.log(`     ${JSON.stringify(rendered.stats)}`);

  const destStat = rendered.stats.find((s) => s.startsWith("Destinations"));
  check(destStat === "Destinations 1", "Destinations reads from destPaths, not the empty nodes list", destStat);
  check(rendered.stats.some((s) => s.startsWith("Uploaded ")), "the count is labelled Uploaded",
    rendered.stats.find((s) => s.startsWith("Uploaded")) || "(none)");
  check(!rendered.stats.some((s) => s.startsWith("Verified")),
    "…and NOT Verified — nothing was read back and compared");
  check(!rendered.verdict.includes("do NOT wipe the source"),
    "verdict is not the local-copy failure wording");
  check(rendered.verdict.includes("not yet independently verified"),
    "…it says plainly that this isn't verified yet", rendered.verdict.slice(0, 70) + "…");
  check(summary.allVerified === false, "allVerified is still false — the claim was not quietly upgraded");
  check(rendered.verdictClass.includes("warn"), "…and reads as a caveat, not a success or a failure", rendered.verdictClass);

  // ── 3. "Legs" ────────────────────────────────────────────────────────
  console.log("\n3. \"Legs\" jargon");
  check(!rendered.stats.some((s) => s.startsWith("Legs")), "hidden for a single-leg job");
  const cascadeStats = await ev(`(() => {
    renderSummary({ uploadOnly:false, allVerified:true, totalFiles:2, fileCopiesVerified:4, totalFileCopies:4,
      nodes:[{id:"a",path:"/x",parentId:null,status:"verified",mismatches:[],errors:[],files:[]},
             {id:"b",path:"/y",parentId:"a",status:"verified",mismatches:[],errors:[],files:[]}],
      destPaths:["/x","/y"], legCount:2, copiedBytes:10, durationMs:5, mismatches:[], errors:[] });
    return [...document.querySelectorAll("#summary .stats span")].map(s => s.textContent.trim());
  })()`);
  check(cascadeStats.some((s) => s.startsWith("Cascade Legs")),
    "shown, and renamed, when a job actually cascades", cascadeStats.find((s) => s.includes("Legs")) || "(none)");

  // ── 4. Single-file + multi-file sources ──────────────────────────────
  console.log("\n4. Individual files as a source");
  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-fs-"));
  const one = made[0].path;

  await ev(`clearAll(); setSource(${JSON.stringify(one)}); render(); true`);
  check(await ev(`sourcePath === ${JSON.stringify(one)}`), "a single file can be the source");
  check(await ev(`entryFor(sourcePath).type === "file"`), "…and renders with the file glyph, not a folder");

  const single = await ev(`window.freeframe.startCopy(${JSON.stringify(one)},
    [{id:"n1",path:${JSON.stringify(dest)},parentId:null}], "xxhash64", null, null)`);
  check(single.allVerified === true, "one file copies and verifies", JSON.stringify({
    files: single.totalFiles, mismatches: single.mismatches.length, errors: single.errors.length }));
  check(single.totalFiles === 1, "exactly one file in the job", String(single.totalFiles));
  const landed = await fsp.readdir(dest);
  check(landed.includes(path.basename(one)), "…and is on disk under its own name", landed.join(", "));

  const dest2 = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-fs2-"));
  await ev(`clearAll(); setSourceFiles(${JSON.stringify(made.map((m) => m.path))}); render(); true`);
  check(await ev(`sourcePath === "fileset://selected"`), "several files become a file-set source");
  check(await ev(`(sourceFiles||[]).length`) === made.length, "…holding every picked file");
  check((await ev(`entryFor(sourcePath).name`)) === `${made.length} files`, "…labelled by count");
  check((await ev(`entryFor(sourcePath).fileList`)).includes(made[0].name), "…and naming them on the card");

  const multi = await ev(`window.freeframe.startCopy(null,
    [{id:"n1",path:${JSON.stringify(dest2)},parentId:null}], "xxhash64", null, ${JSON.stringify(made.map((m) => m.path))})`);
  check(multi.allVerified === true, "the file set copies and verifies", JSON.stringify({
    files: multi.totalFiles, errors: multi.errors.length }));
  const landed2 = await fsp.readdir(dest2);
  check(landed2.length === made.length, `all ${made.length} files landed`, landed2.join(", "));

  // Copying a file into the directory it already lives in would overwrite
  // it with itself.
  const selfDest = await ev(`(async () => {
    try {
      await window.freeframe.startCopy(null, [{id:"n1",path:${JSON.stringify(tmp)},parentId:null}],
        "xxhash64", null, ${JSON.stringify([one])});
      return "NO ERROR";
    } catch (e) { return String(e.message || e); }
  })()`);
  check(/already holds the selected file/.test(selfDest),
    "refuses to overwrite a source file with itself", selfDest.slice(0, 80));

  // Two picked files sharing a basename can't both land.
  const clash = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), "ff-cl-")), path.basename(one));
  await fsp.writeFile(clash, "different");
  const clashErr = await ev(`(async () => {
    try {
      await window.freeframe.startCopy(null, [{id:"n1",path:${JSON.stringify(dest2)},parentId:null}],
        "xxhash64", null, ${JSON.stringify([one, clash])});
      return "NO ERROR";
    } catch (e) { return String(e.message || e); }
  })()`);
  check(/both named/.test(clashErr), "refuses two selected files with the same name", clashErr.slice(0, 80));

  // ── 5. OS drag-and-drop ──────────────────────────────────────────────
  console.log("\n5. Native drag-and-drop from Finder");
  check(await ev(`typeof window.freeframe.pathForFile === "function"`),
    "preload exposes pathForFile (webUtils can't be reached from the sandbox)");
  check(await ev(`typeof window.freeframe.classifyPaths === "function"`), "…and classifyPaths");

  const zones = await ev(`(() => {
    const out = {};
    for (const z of ["zone-source", "zone-dest"]) {
      const el = document.getElementById(z);
      const e = new Event("dragover", { bubbles: true, cancelable: true });
      e.dataTransfer = { types: ["Files"], files: [], dropEffect: "" };
      el.dispatchEvent(e);
      out[z] = { highlighted: el.classList.contains("os-drop"), prevented: e.defaultPrevented };
    }
    return out;
  })()`);
  check(zones["zone-source"].prevented && zones["zone-source"].highlighted,
    "Sources accepts a file dragover and highlights", JSON.stringify(zones["zone-source"]));
  check(zones["zone-dest"].prevented && zones["zone-dest"].highlighted,
    "Destinations too", JSON.stringify(zones["zone-dest"]));

  const ignoresInApp = await ev(`(() => {
    const el = document.getElementById("zone-source");
    el.classList.remove("os-drop");
    const e = new Event("dragover", { bubbles: true, cancelable: true });
    e.dataTransfer = { types: ["text/plain"], files: [], dropEffect: "" };
    el.dispatchEvent(e);
    return !el.classList.contains("os-drop");
  })()`);
  check(ignoresInApp, "a non-file drag is left alone — the in-app pointer drag is untouched");

  // The drop path itself, driven through classifyPaths exactly as a real
  // drop would (the File→path step is the one thing only a real drop can
  // provide, so it's supplied directly).
  await ev(`clearAll(); render(); true`);
  const dropped = await ev(`(async () => {
    const sel = await window.freeframe.classifyPaths(${JSON.stringify([one])});
    applySourceSelection(sel);
    return { kind: sel.kind, sourcePath, files: sourceFiles };
  })()`);
  check(dropped.kind === "files", "a dropped file classifies as files", dropped.kind);
  check(dropped.sourcePath === one, "…and is assigned as the source", String(dropped.sourcePath));

  const droppedDir = await ev(`(async () => {
    const sel = await window.freeframe.classifyPaths(${JSON.stringify([tmp])});
    applySourceSelection(sel);
    return { kind: sel.kind, sourcePath };
  })()`);
  check(droppedDir.kind === "dir", "a dropped folder classifies as dir", droppedDir.kind);
  check(droppedDir.sourcePath === tmp, "…and is assigned as a directory source");

  check(
    await ev(`(async () => {
      const sel = await window.freeframe.classifyPaths(${JSON.stringify([tmp, one])});
      return sel.kind === "dir" && sel.paths.length === 1;
    })()`),
    "a mixed drop resolves to the folder rather than an ambiguous hybrid"
  );

  // ── Cleanup ──────────────────────────────────────────────────────────
  //
  // The uploaded assets are NOT deleted from here. Doing so would mean
  // adding a delete-asset method to the production contextBridge purely
  // for a test, and a destructive capability the app has no other use for
  // is not worth having. They're named `ffdesk-<timestamp>` so they're
  // obvious, and listed below for removal from the web UI.
  console.log("\n6. Test assets left in the project — delete these from the web UI:");
  for (const m of made) console.log(`     ${m.name}`);

  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(dest2, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  child.kill("SIGKILL");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
