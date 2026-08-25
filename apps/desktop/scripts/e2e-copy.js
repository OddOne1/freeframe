#!/usr/bin/env node
// End-to-end test through the REAL app, driving real mouse drags.
//
// scripts/test-copy.js exercises the copy engine directly. This one goes
// the whole way: it launches Electron, attaches to the renderer over the
// Chrome DevTools Protocol, dispatches actual mouse events to drag volumes
// into the Sources and Destinations zones, drops one destination onto
// another to form a cascade, runs the copy, and reads the result out of the
// real DOM.
//
// Real mouse events (Input.dispatchMouseEvent), not synthesized clicks on
// state functions — which is the whole reason the renderer uses pointer
// events rather than HTML5 drag-and-drop: HTML5 DnD cannot be driven
// synthetically, so the cascade interaction would be untestable.
//
// Run: node scripts/e2e-copy.js

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnElectron } = require("./lib/electron-harness");

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
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("Electron renderer never became inspectable");
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
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
  async eval(expression) {
    const res = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || JSON.stringify(res.exceptionDetails));
    }
    return res.result.value;
  }
  /** Center point of the first element matching `selector`. */
  async centerOf(selector) {
    const box = await this.eval(`
      (() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null; const r = e.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) }; })()
    `);
    if (!box) throw new Error(`No element for selector: ${selector}`);
    return box;
  }
  async mouse(type, x, y) {
    await this.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
    });
  }
  /** A real press-move-move-release drag. */
  async drag(fromSel, toSel, { steps = 6, holdAtTarget = false } = {}) {
    const a = await this.centerOf(fromSel);
    const b = await this.centerOf(toSel);
    await this.mouse("mousePressed", a.x, a.y);
    for (let i = 1; i <= steps; i++) {
      await this.mouse("mouseMoved", Math.round(a.x + ((b.x - a.x) * i) / steps), Math.round(a.y + ((b.y - a.y) * i) / steps));
      await sleep(12);
    }
    if (holdAtTarget) {
      // Pause on the target so the drop indicator can be observed before
      // release — that's the blue-outline affordance being asserted.
      const indicator = await this.eval(`document.querySelectorAll('.cascade-target').length`);
      await this.mouse("mouseReleased", b.x, b.y);
      return indicator;
    }
    await this.mouse("mouseReleased", b.x, b.y);
    return null;
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
  const destA = path.join(tmp, "RAID_A");
  const destB = path.join(tmp, "SHUTTLE_B");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destA, { recursive: true });
  await fs.mkdir(destB, { recursive: true });
  const sizes = await makeSource(source);
  const totalBytes = Object.values(sizes).reduce((a, b) => a + b, 0);

  console.log(`Source: ${source} (${Object.keys(sizes).length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`Destinations: ${destA}, ${destB}\n`);

  const child = spawnElectron(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  try {
    console.log("1. Launch + security posture");
    const target = await getRendererTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    check(true, "Electron launched and renderer is inspectable");

    const bridge = await cdp.eval("Object.keys(window.freeframe).sort().join(',')");
    check(
      // appInfo/getSettings/setSettings/openLogsFolder added with §58;
      // removeJob/clearFinishedJobs with §59; showWebView/hideWebView/
      // setWebViewInset with §60b — show/hide/position only, deliberately
      // NO handle on the embedded view itself. openSettingsWindow /
      // onSettingsTab / onSettingsChanged / onPresetsChanged with §61,
      // when Settings became a real window and two windows had to stay in
      // step with one store. onAccountChanged / reloadWebView with §64,
      // when login moved into Settings and Refresh started meaning "reload
      // the page you are looking at". validateFolderPattern with §65c, so
      // the editor and the engine refuse the same folder patterns from one
      // implementation rather than two.
      // This list is an allowlist, not a snapshot: it is here so a new
      // channel has to be a deliberate act rather than something that
      // arrives unnoticed.
      bridge === "appInfo,bumpSourceCounter,cancelCopy,chooseFolder,chooseSource,classifyPaths,clearFinishedJobs,clearRecentFolders,deletePreset,detachPanel,dockPanel,ejectVolume,freeframeFolderTree,freeframeListAssets,freeframeLogin,freeframeLogout,freeframeProjects,freeframeStatus,freeframeUpload,getAlgorithms,getDisplayNames,getRecentFolders,getSettings,hideWebView,listJobs,listPresets,listVolumes,onAccountChanged,onCopyProgress,onJobsChanged,onPanelDockChanged,onPresetsChanged,onSettingsChanged,onSettingsTab,onVolumesChanged,openJobLog,openLogsFolder,openSettingsWindow,pathForFile,previewNaming,reloadWebView,rememberFolder,removeJob,savePreset,setDisplayName,setSettings,setSourceCounter,setWebViewInset,showWebView,startCopy,validateFolderPattern",
      "contextBridge exposes exactly the intended API", bridge);
    check(await cdp.eval("typeof window.require") === "undefined", "no window.require");
    check(await cdp.eval("typeof window.process") === "undefined", "no window.process");
    check(await cdp.eval("typeof window.ipcRenderer") === "undefined", "raw ipcRenderer not exposed");

    console.log("\n2. Three-zone layout present");
    check(await cdp.eval("!!document.getElementById('zone-source')"), "Sources zone");
    check(await cdp.eval("!!document.getElementById('zone-volumes')"), "center volume column");
    check(await cdp.eval("!!document.getElementById('zone-dest')"), "Destinations zone");

    // Inject the temp dirs the way "Choose folder…" would, so there are
    // known cards to drag.
    //
    // deviceFor is stubbed for this file (§59): a picked folder now
    // collapses onto its containing drive's tile, and these temp dirs live
    // under /var/folders — i.e. on the boot volume — so with the real
    // implementation they correctly render as ONE "Macintosh HD" tile and
    // there is nothing per-folder to drag. That collapsing is the fix, not
    // a regression; this test is about drag/cascade mechanics, so it opts
    // out of the enclosing-volume question rather than asserting the old
    // behaviour. e2e-tile-dedup.js covers the collapsing itself.
    //
    // Stubbed rather than emptying `volumes`, because refresh() repopulates
    // that from the real machine between steps and the stub has to survive.
    await cdp.eval(`deviceFor = () => null; true`);
    await cdp.eval(`extraFolders = ${JSON.stringify([source, destA, destB])}; render(); true`);
    const cards = await cdp.eval("document.querySelectorAll('#zone-volumes .tile').length");
    check(cards >= 3, "all three folders listed in the center column", `${cards} cards`);

    const sel = (p) => `#zone-volumes .tile[data-path="${p}"]`;

    console.log("\n3. Drag a volume into Sources");
    await cdp.drag(sel(source), "#zone-source");
    check(await cdp.eval("sourcePath") === source, "source assigned by dragging");
    // §59 removed the text badge. Note what does NOT replace it here: the
    // coloured outline is applied only to Volumes-column tiles (makeTile
    // passes roleClass only when it is rendering without a role), so in the
    // Sources column the badge was the sole marker and the column itself is
    // now the whole signal — which is the argument for removing it there.
    check(await cdp.eval("document.querySelectorAll('#zone-source .tile').length") === 1,
      "the dragged folder appears in the Sources zone");
    check(await cdp.eval("!document.querySelector('#zone-source .tile-role')"),
      "and carries no redundant SOURCE badge — the column says it");

    console.log("\n4. Drag two volumes into Destinations");
    await cdp.drag(sel(destA), "#zone-dest");
    await cdp.drag(sel(destB), "#zone-dest");
    check(await cdp.eval("destNodes.length") === 2, "two destinations assigned by dragging");
    check(await cdp.eval("destNodes.every(n => n.parentId === null)"), "both are parallel (no parent) at this point");
    check(await cdp.eval("document.querySelectorAll('#zone-dest .tile').length") === 2,
      "both cards appear in the Destinations zone");
    check(await cdp.eval("document.querySelectorAll('#zone-dest .tile-role').length") === 0,
      "with no DEST badges (§59)");

    console.log("\n5. Drop one destination ONTO the other → cascade");
    const destSel = async (p) => {
      const id = await cdp.eval(`(destNodes.find(n => n.path === ${JSON.stringify(p)}) || {}).id`);
      return `#zone-dest .tile[data-dest-id="${id}"]`;
    };
    const aSel = await destSel(destA);
    const bSel = await destSel(destB);
    const indicatorCount = await cdp.drag(bSel, aSel, { holdAtTarget: true });
    check(indicatorCount === 1, "blue-outline drop indicator shown on the target while hovering", `${indicatorCount} target(s)`);

    const parentOfB = await cdp.eval(`
      (() => { const b = destNodes.find(n => n.path === ${JSON.stringify(destB)});
        const a = destNodes.find(n => n.path === ${JSON.stringify(destA)});
        return b.parentId === a.id; })()
    `);
    check(parentOfB, "B now cascades from A");
    check(await cdp.eval("document.querySelectorAll('#zone-dest .cascaded').length") === 1, "cascaded node rendered in its own indented group");
    const arrows = await cdp.eval("[...document.querySelectorAll('#zone-dest .arrow')].length");
    check(arrows >= 2, "directional arrows rendered for source→A and A→B", `${arrows} arrows`);
    const chainText = await cdp.eval("document.querySelector('#zone-dest .cascaded .chain-from').textContent");
    check(chainText.includes("RAID_A") && chainText.includes("SHUTTLE_B"), "cascade arrow labels the real flow direction", chainText);

    console.log("\n6. Run it — the cascaded leg must wait for its parent");
    await cdp.eval(`
      window.__events = [];
      window.freeframe.onCopyProgress(p => {
        if (p.phase === 'node-status') window.__events.push(p.node.id + ':' + p.node.status);
        if (p.phase === 'source-released') window.__events.push('source-released');
      });
      window.__done = null;
      const o = renderSummary; renderSummary = (s) => { window.__done = s; o(s); };
      document.getElementById('start').click(); true
    `);

    let summary = null;
    for (let i = 0; i < 300; i++) {
      summary = await cdp.eval("window.__done");
      if (summary) break;
      await sleep(100);
    }
    check(Boolean(summary), "copy completed and produced a summary");

    if (summary) {
      const aId = await cdp.eval(`(destNodes.find(n => n.path === ${JSON.stringify(destA)}) || {}).id`);
      const bId = await cdp.eval(`(destNodes.find(n => n.path === ${JSON.stringify(destB)}) || {}).id`);
      const events = await cdp.eval("window.__events");

      const aVerified = events.indexOf(`${aId}:verified`);
      const bCopying = events.indexOf(`${bId}:copying`);
      check(aVerified !== -1, "parent leg reported verified");
      check(bCopying !== -1, "cascaded leg reported copying");
      check(aVerified < bCopying, "CASCADE ORDER: B started only after A verified",
        `A:verified@${aVerified} < B:copying@${bCopying}`);

      const released = events.indexOf("source-released");
      check(released !== -1 && released < bCopying, "source released before the cascaded leg ran", `@${released}`);
      check(await cdp.eval("sourceReleased") === true, "renderer shows the card as ejectable");

      check(summary.allVerified === true, "allVerified through the real IPC path",
        JSON.stringify({ mismatches: summary.mismatches.length, errors: summary.errors.length }));
      check(summary.legCount === 2, "two legs, not one fan-out", String(summary.legCount));
      check(summary.nodes.length === 2 && summary.nodes.every((n) => n.status === "verified"), "both nodes verified");
      const nb = summary.nodes.find((n) => n.id === bId);
      check(nb && nb.parentId === aId, "tree shape survived the round trip");

      const verdict = await cdp.eval("document.querySelector('.verdict').textContent");
      check(verdict.includes("Safe to wipe"), "UI shows the verified verdict");
    }

    console.log("\n7. Bytes on disk are actually identical");
    const { hashFileOnDisk } = require("../src/main/copy-engine");
    let identical = true;
    for (const rel of Object.keys(sizes)) {
      const s = await hashFileOnDisk(path.join(source, rel));
      const a = await hashFileOnDisk(path.join(destA, rel));
      const b = await hashFileOnDisk(path.join(destB, rel));
      if (s !== a || s !== b) { identical = false; console.log(`      ${rel}: ${s} / ${a} / ${b}`); }
    }
    check(identical, "source == RAID_A == SHUTTLE_B (cascaded copy matches the ORIGINAL)");

    console.log("\n8. Right-click fallback exists for both assignment and cascading");
    await cdp.eval(`deviceFor = () => null; clearAll(); extraFolders = ${JSON.stringify([source, destA, destB])}; render(); true`);
    const box = await cdp.centerOf(sel(destA));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "right", buttons: 2, clickCount: 1 });
    await sleep(80);
    const menuItems = await cdp.eval(`[...document.querySelectorAll('#menu button')].map(b => b.textContent.trim())`);
    check(menuItems.includes("Set as Source"), "context menu offers Set as Source", menuItems.join(" | "));
    check(menuItems.includes("Set as Destination"), "context menu offers Set as Destination");

    // With a destination already present, the menu must offer Cascade from…
    await cdp.eval(`closeMenu(); addDest(${JSON.stringify(destA)}, null); true`);
    const box2 = await cdp.centerOf(sel(destB));
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box2.x, y: box2.y, button: "right", buttons: 2, clickCount: 1 });
    await sleep(80);
    const label = await cdp.eval(`[...document.querySelectorAll('#menu .label')].map(l => l.textContent.trim()).join(',')`);
    check(label.includes("Cascade from"), "context menu offers Cascade from… once a destination exists", label);

    console.log(
      failures === 0
        ? `\nE2E PASSED — real drags, real cascade, real files (${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${summary.legCount} legs in ${summary.durationMs}ms)`
        : `\n${failures} E2E CHECK(S) FAILED`
    );
  } finally {
    child.kill("SIGTERM");
    await sleep(300);
    if (!child.killed) child.kill("SIGKILL");
    await fs.rm(tmp, { recursive: true, force: true });
    if (failures > 0 && logs.length) console.log("\n--- electron output ---\n" + logs.join(""));
  }

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E harness crashed:", err);
  process.exit(1);
});
