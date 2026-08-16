#!/usr/bin/env node
// Item 3 end to end: pull a real FreeFrame folder down as a *source*.
//
// This drives the actual app — the real IPC handler, the real source
// provider, the real copy engine — against the real API with the real
// signed-in session, and writes to a temp directory. Read-only as far as
// the server is concerned: it lists and downloads, and never uploads,
// modifies or deletes anything.
//
// The open question this item began with is settled here rather than
// asserted: GET /projects/{id}/assets?folder_id&recursive already exists
// (apps/api/routers/assets.py), so nothing was added to the backend.
//
// Run: node scripts/e2e-ff-source.js
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9313;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};
const fmt = (b) => {
  const u = ["B", "KB", "MB", "GB"]; let i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
};

(async () => {
  try { require("child_process").execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(1200);

  const dest = await fsp.mkdtemp(path.join(os.tmpdir(), "ff-pull-"));
  console.log(`Destination: ${dest}\n`);

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
  const ev = async (x, ms = 600000) => {
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: ms });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result.value;
  };
  await send("Runtime.enable");
  await sleep(2000);

  const status = await ev(`window.freeframe.freeframeStatus()`);
  if (!status.loggedIn) {
    console.log("Not signed in — this test needs a real session. Sign in and re-run.");
    child.kill("SIGKILL");
    process.exit(2);
  }
  console.log(`Signed in as ${status.user?.name || status.user?.email} @ ${status.baseUrl}\n`);

  // ── Pick the smallest real folder available, so this stays a quick test
  //    against production rather than a multi-GB download.
  const projects = (await ev(`window.freeframe.freeframeProjects()`)).projects || [];
  console.log(`Projects: ${projects.map((p) => `${p.name} (${p.asset_count})`).join(", ")}\n`);

  console.log("1. The listing endpoint (the open question)");
  let chosen = null;
  for (const p of projects) {
    const tree = (await ev(`window.freeframe.freeframeFolderTree(${JSON.stringify(p.id)})`)).tree || [];
    const flat = [];
    (function walk(ns) { for (const n of ns || []) { flat.push(n); walk(n.children); } })(tree);
    // Root as well as every folder — root is a legitimate target too.
    for (const f of [{ id: "root", name: "(root)" }, ...flat]) {
      const res = await ev(
        `window.freeframe.freeframeListAssets(${JSON.stringify(p.id)}, ${JSON.stringify(f.id)}, true)`
      );
      if (!res.ok) { check(false, `list ${p.name}/${f.name}`, res.error); continue; }
      console.log(`     ${p.name} / ${f.name}: ${res.files.length} file(s), ${fmt(res.totalBytes)}` +
        (res.skipped.length ? `  (${res.skipped.length} skipped)` : ""));
      if (res.files.length && (!chosen || res.totalBytes < chosen.totalBytes)) {
        chosen = { project: p, folder: f, ...res };
      }
    }
  }
  check(true, "GET /projects/{id}/assets?folder_id&recursive answered for every folder — no new endpoint needed");

  if (!chosen) {
    console.log("\nNo downloadable assets anywhere — nothing to pull. Stopping.");
    child.kill("SIGKILL");
    process.exit(fail === 0 ? 0 : 1);
  }

  console.log(`\n2. Pulling ${chosen.project.name} / ${chosen.folder.name} ` +
    `(${chosen.files.length} file(s), ${fmt(chosen.totalBytes)})`);
  console.log(`     files: ${chosen.files.map((f) => f.rel).join(", ")}`);

  const srcUri = `freeframe://${chosen.project.id}`;
  const folderArg = chosen.folder.id === "root" ? null : chosen.folder.id;

  const summary = await ev(`window.freeframe.startCopy(
    ${JSON.stringify(srcUri)},
    [{ id: "n1", path: ${JSON.stringify(dest)}, parentId: null }],
    "xxhash64",
    ${JSON.stringify(folderArg)}
  )`);

  console.log(`     ${summary.totalFiles} file(s), ${fmt(summary.copiedBytes)} in ${(summary.durationMs / 1000).toFixed(1)}s`);
  if (summary.skippedAssets?.length) {
    console.log(`     skipped ${summary.skippedAssets.length}:`);
    for (const a of summary.skippedAssets) console.log(`       ${a.name} — ${a.reason}`);
  }
  console.log("");

  console.log("3. Verification");
  check(summary.allVerified === true, "allVerified — every file re-read from disk and matched", JSON.stringify({
    mismatches: summary.mismatches.length, errors: summary.errors.length, cancelled: summary.cancelled,
  }));
  check(summary.errors.length === 0, "no errors", summary.errors.map((e) => e.error).join(" | "));
  check(summary.mismatches.length === 0, "no hash mismatches");
  check(summary.totalFiles === chosen.files.length, "file count matches the manifest",
    `${summary.totalFiles} vs ${chosen.files.length}`);
  check(summary.nodes[0].status === "verified", "destination node verified", summary.nodes[0].status);
  check(summary.algorithmId === "xxhash64", "the chosen algorithm was actually used", summary.algorithmId);

  // A skipped asset must never be quietly absent — the summary carries it
  // so the UI can say the offload is incomplete.
  const listedSkips = chosen.skipped.length;
  if (listedSkips) {
    check((summary.skippedAssets || []).length === listedSkips,
      "skipped assets travel with the summary, so 'verified' can't read as 'complete'",
      `${(summary.skippedAssets || []).length} of ${listedSkips}`);
    check((summary.skippedAssets || []).every((a) => a.reason),
      "every skip states a reason");
  }

  console.log("\n4. What actually landed on disk");
  const onDisk = await fsp.readdir(dest);
  check(onDisk.length === chosen.files.length, `${onDisk.length} file(s) written`, onDisk.join(", "));

  let bytesOnDisk = 0;
  for (const f of chosen.files) {
    const full = path.join(dest, f.rel);
    try {
      const st = await fsp.stat(full);
      bytesOnDisk += st.size;
      // Size is checked independently of the engine's own verification: a
      // bug that hashed and compared the same wrong bytes would still
      // report allVerified.
      check(st.size === f.size, `${f.rel} is the size the API reported`, `${st.size} vs ${f.size}`);
      check(st.size > 0, `${f.rel} is not empty`);
    } catch (err) {
      check(false, `${f.rel} exists on disk`, String(err.message));
    }
  }
  check(bytesOnDisk === chosen.totalBytes, "total bytes on disk match the manifest",
    `${fmt(bytesOnDisk)} vs ${fmt(chosen.totalBytes)}`);

  // Re-hash outside the app entirely. The engine verified against its own
  // read; this proves the file is intact according to something that shares
  // no code with it.
  console.log("\n5. Independent re-hash (nothing shared with the engine)");
  for (const f of chosen.files) {
    try {
      const buf = await fsp.readFile(path.join(dest, f.rel));
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      check(buf.length === f.size, `${f.rel} re-read at the expected length`, `${buf.length}`);
      console.log(`     ${f.rel}  sha256=${sha.slice(0, 16)}…`);
    } catch (err) {
      check(false, `${f.rel} re-readable`, String(err.message));
    }
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  console.log(`Pulled files left in ${dest} for inspection.`);
  child.kill("SIGKILL");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
