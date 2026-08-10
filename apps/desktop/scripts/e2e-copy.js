#!/usr/bin/env node
// End-to-end test through the REAL app.
//
// scripts/test-copy.js exercises the copy engine directly. This one goes
// the whole way: it launches Electron, attaches to the renderer over the
// Chrome DevTools Protocol, clicks the actual buttons, and reads the
// summary back out of the real DOM. That means the main-process IPC
// handler, the preload contextBridge, and the renderer are all genuinely
// exercised — not just the module underneath them.
//
// Run: node scripts/e2e-copy.js

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const PORT = 9223;
const ELECTRON = path.join(__dirname, "..", "node_modules", ".bin", "electron");
const APP_DIR = path.join(__dirname, "..");

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRendererTarget() {
  // Electron exposes both the renderer page and (sometimes) devtools
  // targets; we want the app's own page.
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("Electron renderer never became inspectable");
}

/** Minimal CDP client over Node's built-in WebSocket. */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate an expression in the page and return its value. */
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails)
      );
    }
    return res.result.value;
  }
}

async function makeSource(root) {
  await fs.mkdir(path.join(root, "DCIM", "100CANON"), { recursive: true });
  const sizes = {};
  for (const [name, size] of [["A001C001.MOV", 6 * 1024 * 1024 + 777], ["A001C002.MOV", 2 * 1024 * 1024]]) {
    const buf = Buffer.alloc(size);
    crypto.randomFillSync(buf);
    await fs.writeFile(path.join(root, "DCIM", "100CANON", name), buf);
    sizes[`DCIM/100CANON/${name}`] = size;
  }
  await fs.writeFile(path.join(root, "README.txt"), "shot list\n");
  sizes["README.txt"] = 10;
  return sizes;
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-e2e-"));
  const source = path.join(tmp, "CARD");
  const destA = path.join(tmp, "BACKUP_A");
  const destB = path.join(tmp, "BACKUP_B");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destA, { recursive: true });
  await fs.mkdir(destB, { recursive: true });
  const sizes = await makeSource(source);
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);

  console.log(`Source: ${source}`);
  console.log(`  ${Object.keys(sizes).length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Destinations: ${destA}, ${destB}\n`);

  const child = spawn(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  const mainLogs = [];
  child.stdout.on("data", (d) => mainLogs.push(String(d)));
  child.stderr.on("data", (d) => mainLogs.push(String(d)));

  try {
    console.log("1. App launch");
    const target = await getRendererTarget();
    check(true, "Electron launched and renderer is inspectable");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");

    // The preload bridge is the whole security boundary — confirm the
    // renderer really has no Node access and only the narrow API.
    console.log("\n2. Security posture in the live renderer");
    const bridge = await cdp.eval("Object.keys(window.freeframe).sort().join(',')");
    check(
      bridge === "cancelCopy,chooseFolder,listVolumes,onCopyProgress,startCopy",
      "contextBridge exposes exactly the intended API",
      bridge
    );
    check(await cdp.eval("typeof window.require") === "undefined", "no window.require in renderer");
    check(await cdp.eval("typeof window.process") === "undefined", "no window.process in renderer");
    check(await cdp.eval("typeof window.ipcRenderer") === "undefined", "raw ipcRenderer not exposed");

    console.log("\n3. Assign source + two destinations through the real UI");
    // Inject the temp dirs the same way the folder picker would, then use
    // the app's own state functions and re-render.
    await cdp.eval(`
      extraFolders = ${JSON.stringify([source, destA, destB])};
      sourcePath = null; destPaths = new Set();
      render();
      true
    `);
    const rowCount = await cdp.eval("document.querySelectorAll('.volume').length");
    check(rowCount >= 3, "all three folders appear as assignable rows", `${rowCount} rows`);

    // Click the real buttons, found by their row's path text.
    await cdp.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.volume')];
        const find = (p) => rows.find(r => r.querySelector('.meta').textContent.startsWith(p));
        const btn = (row, label) => [...row.querySelectorAll('button')].find(b => b.textContent.includes(label));
        btn(find(${JSON.stringify(source)}), 'Source').click();
        btn(find(${JSON.stringify(destA)}), 'Dest').click();
        btn(find(${JSON.stringify(destB)}), 'Dest').click();
        return true;
      })()
    `);
    check(await cdp.eval("sourcePath") === source, "source assigned by clicking");
    check(await cdp.eval("[...destPaths].length") === 2, "two destinations assigned by clicking");
    const srcBadges = await cdp.eval("document.querySelectorAll('.badge.role-source').length");
    const dstBadges = await cdp.eval("document.querySelectorAll('.badge.role-dest').length");
    check(srcBadges === 1, "SOURCE badge rendered on exactly one card");
    check(dstBadges === 2, "DESTINATION badge rendered on both destination cards");
    check(await cdp.eval("document.getElementById('start').disabled") === false, "Copy button enabled once roles are set");

    console.log("\n4. Run the copy by clicking Copy & Verify");
    await cdp.eval(`
      window.__progressPhases = new Set();
      window.freeframe.onCopyProgress(p => window.__progressPhases.add(p.phase));
      window.__done = null;
      const orig = renderSummary;
      renderSummary = (s) => { window.__done = s; orig(s); };
      document.getElementById('start').click();
      true
    `);

    let summary = null;
    for (let i = 0; i < 200; i++) {
      summary = await cdp.eval("window.__done");
      if (summary) break;
      await sleep(100);
    }
    check(Boolean(summary), "copy completed and produced a summary");

    if (summary) {
      check(summary.allVerified === true, "allVerified via the real IPC path", JSON.stringify({
        mismatches: summary.mismatches.length, errors: summary.errors.length,
      }));
      check(summary.mode === "SECURE" && summary.algorithm === "xxh64", "SECURE / xxh64");
      check(summary.destPaths.length === 2, "both destinations in the summary");
      check(summary.filesVerified === 3, "3 of 3 files verified", String(summary.filesVerified));
      check(summary.copiedBytes === totalBytes, "byte count matches source", `${summary.copiedBytes}`);

      const phases = await cdp.eval("[...window.__progressPhases].join(',')");
      check(
        ["start", "bytes", "file-done", "done"].every((p) => phases.includes(p)),
        "copy:progress events crossed the bridge during the copy",
        phases
      );

      const verdict = await cdp.eval("document.querySelector('.verdict').textContent");
      check(verdict.includes("Safe to wipe"), "UI shows the verified verdict");
      const summaryClass = await cdp.eval("document.querySelector('.summary').className");
      check(summaryClass.includes("ok"), "summary box rendered in its success state");
    }

    console.log("\n5. Bytes on disk are actually identical");
    const { hashFileOnDisk } = require("../src/main/copy-engine");
    let identical = true;
    for (const rel of Object.keys(sizes)) {
      const s = await hashFileOnDisk(path.join(source, rel));
      const a = await hashFileOnDisk(path.join(destA, rel));
      const b = await hashFileOnDisk(path.join(destB, rel));
      if (s !== a || s !== b) { identical = false; console.log(`      ${rel}: ${s} / ${a} / ${b}`); }
    }
    check(identical, "independent re-hash: source == BACKUP_A == BACKUP_B");

    console.log(
      failures === 0
        ? `\nE2E PASSED — real app, real IPC, real files (${(totalBytes / 1024 / 1024).toFixed(1)} MB to 2 destinations in ${summary.durationMs}ms)`
        : `\n${failures} E2E CHECK(S) FAILED`
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    if (!child.killed) child.kill("SIGKILL");
    await fs.rm(tmp, { recursive: true, force: true });
    if (failures > 0 && mainLogs.length) {
      console.log("\n--- electron output ---\n" + mainLogs.join(""));
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E harness crashed:", err);
  process.exit(1);
});
