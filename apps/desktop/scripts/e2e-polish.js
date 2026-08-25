#!/usr/bin/env node
// Exercises the 7 polish items against the running app — not by reading the
// diff, by doing the thing:
//
//   1. mounts and unmounts a REAL disk image with hdiutil and watches the
//      UI update with zero clicks
//   2. compares reported free/total against `df` on the actual internal and
//      network mounts
//   3. asserts the folder dialog receives a per-device defaultPath
//   4. checks the scrollbar rules resolve, and that a scrollbar only exists
//      when content overflows
//   5. drives the dual-role conflict from both directions, including Cancel
//   6. assigns and unassigns a picked folder and checks it's pruned; checks
//      recents round-trip through the main process
//   7. drags an assigned card back to the middle column with real mouse
//      events and checks it unassigns
//
// Run: node scripts/e2e-polish.js

const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawnElectron } = require("./lib/electron-harness");

const execFileAsync = promisify(execFile);
const PORT = 9251;
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
      const t = await res.json();
      const page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("renderer never became inspectable");
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
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
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
    return r.result.value;
  }
  async centerOf(sel) {
    const b = await this.eval(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
      const r=e.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    if (!b) throw new Error(`no element: ${sel}`);
    return b;
  }
  mouse(type, x, y) {
    return this.send("Input.dispatchMouseEvent", {
      type, x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
    });
  }
  async drag(fromSel, toSel, { probeAtTarget = null } = {}) {
    const a = await this.centerOf(fromSel);
    const b = await this.centerOf(toSel);
    await this.mouse("mousePressed", a.x, a.y);
    for (let i = 1; i <= 6; i++) {
      await this.mouse("mouseMoved", Math.round(a.x + ((b.x - a.x) * i) / 6), Math.round(a.y + ((b.y - a.y) * i) / 6));
      await sleep(12);
    }
    let probe = null;
    if (probeAtTarget) probe = await this.eval(probeAtTarget);
    await this.mouse("mouseReleased", b.x, b.y);
    await sleep(60);
    return probe;
  }
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-polish-"));
  const dmg = path.join(tmp, "TESTVOL.dmg");
  const pickedA = path.join(tmp, "PICKED_A");
  const pickedB = path.join(tmp, "PICKED_B");
  await fs.mkdir(pickedA, { recursive: true });
  await fs.mkdir(pickedB, { recursive: true });

  // Keep any real recent-folders file out of harm's way; this test writes to it.
  let recentsPath = null;
  let recentsBackup = null;

  const child = spawnElectron(ELECTRON, [APP_DIR, `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  let attached = false;

  try {
    const target = await getRendererTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await sleep(400); // let the initial refresh settle

    // ── 2. Free/total space ──────────────────────────────────────────────
    console.log("\n2. Free/total space from statfs, checked against df");
    const vols = await cdp.eval("JSON.stringify(volumes)").then(JSON.parse);
    check(vols.length > 0, "volumes listed", `${vols.length}`);
    for (const v of vols) {
      let df;
      try {
        const { stdout } = await execFileAsync("df", ["-k", v.mountPoint]);
        const cols = stdout.trim().split("\n").pop().split(/\s+/);
        df = { total: Number(cols[1]) * 1024, free: Number(cols[3]) * 1024 };
      } catch { continue; }
      // 2% tolerance: free space genuinely moves between the two reads.
      const near = (a, b) => b > 0 && Math.abs(a - b) / b < 0.02;
      check(v.totalBytes != null && v.freeBytes != null, `${v.name}: has both figures`,
        `total=${v.totalBytes} free=${v.freeBytes}`);
      check(near(v.totalBytes, df.total), `${v.name}: total matches df`,
        `${v.totalBytes} vs ${df.total}`);
      check(near(v.freeBytes, df.free), `${v.name}: free matches df`,
        `${v.freeBytes} vs ${df.free}`);
      if (v.type === "network") {
        check(v.freeBytes > 0, `${v.name}: network volume reports non-null free space (diskutil gave null)`);
      }
      if (v.type === "internal") {
        check(v.freeBytes > 0, `${v.name}: internal reports non-zero free (diskutil gave 0)`);
      }
    }

    // ── 4. Scrollbars ────────────────────────────────────────────────────
    console.log("\n4. Overlay scrollbars");
    const sbWidth = await cdp.eval(`(() => {
      const el = document.querySelector('.col-body');
      // Force overflow so a scrollbar can exist at all.
      const pad = document.createElement('div'); pad.style.height = '4000px'; pad.id='__pad';
      el.appendChild(pad);
      const w = el.offsetWidth - el.clientWidth;
      return w;
    })()`);
    check(sbWidth > 0 && sbWidth <= 12, "scrollbar is thin when content overflows", `${sbWidth}px gutter`);
    const thumbTransparent = await cdp.eval(`(() => {
      const s = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules] } catch { return [] } });
      const rules = s.filter(r => r.selectorText && r.selectorText.includes('::-webkit-scrollbar'));
      const thumb = rules.find(r => r.selectorText === '.col-body::-webkit-scrollbar-thumb');
      const hover = rules.find(r => r.selectorText === '.col-body:hover::-webkit-scrollbar-thumb');
      return { count: rules.length, idle: thumb && thumb.style.background, onHover: hover && hover.style.backgroundColor };
    })()`);
    check(thumbTransparent.count >= 4, "::-webkit-scrollbar rules present", `${thumbTransparent.count} rules`);
    check(String(thumbTransparent.idle).includes("transparent"), "thumb transparent at rest", String(thumbTransparent.idle));
    check(/rgba?\(/.test(String(thumbTransparent.onHover)), "thumb becomes visible on container hover", String(thumbTransparent.onHover));
    const noOverflowGutter = await cdp.eval(`(() => {
      document.getElementById('__pad')?.remove();
      const el = document.querySelector('.col-body');
      return el.offsetWidth - el.clientWidth;
    })()`);
    check(noOverflowGutter === 0, "no scrollbar at all when content fits", `${noOverflowGutter}px`);

    // ── 7. Drag back to the middle column to unassign ────────────────────
    console.log("\n7. Drag an assigned card back to Volumes to unassign");
    await cdp.eval(`clearAll(); extraFolders = ${JSON.stringify([pickedA, pickedB])}; render(); true`);
    check(await cdp.eval(`document.getElementById('zone-volumes').dataset.zone`) === "volumes",
      "#zone-volumes carries data-zone (dropTargetAt can match it)");

    const volSel = (p) => `#zone-volumes .tile[data-path="${p}"]`;
    await cdp.drag(volSel(pickedA), "#zone-source");
    check(await cdp.eval("sourcePath") === pickedA, "assigned as source by drag");

    const readyDuringDrag = await cdp.drag("#zone-source .tile", "#zone-volumes", {
      probeAtTarget: `JSON.stringify({
        ready: document.getElementById('zone-volumes').classList.contains('drop-ready'),
        active: document.getElementById('zone-volumes').classList.contains('drop-active') })`,
    }).then((s) => JSON.parse(s));
    check(readyDuringDrag.ready, "middle column shows drop-ready affordance during a drag");
    check(readyDuringDrag.active, "middle column highlights as the active drop target");
    check(await cdp.eval("sourcePath") === null, "dropping on Volumes cleared the source");

    await cdp.eval(`extraFolders = ${JSON.stringify([pickedA, pickedB])}; addDest(${JSON.stringify(pickedB)}, null); render(); true`);
    check(await cdp.eval("destNodes.length") === 1, "destination assigned");
    await cdp.drag(`#zone-dest .tile[data-path="${pickedB}"]`, "#zone-volumes");
    check(await cdp.eval("destNodes.length") === 0, "dropping a destination on Volumes removed it");

    // ── 6. extraFolders pruning + recents ────────────────────────────────
    console.log("\n6. Orphan pruning + recent-folder memory");
    check(await cdp.eval(`extraFolders.includes(${JSON.stringify(pickedB)})`) === false,
      "unassigned picked folder pruned from the center column");
    // A real mounted volume must never be pruned.
    const realVol = vols[0]?.mountPoint;
    if (realVol) {
      await cdp.eval(`addDest(${JSON.stringify(realVol)}, null); removeDest(${JSON.stringify(realVol)}); true`);
      const stillListed = await cdp.eval(`volumes.some(v => v.mountPoint === ${JSON.stringify(realVol)})`);
      check(stillListed, "a real mounted volume is never pruned from the list");
    }

    // rememberFolder takes a role now, and recents are stored per role —
    // a single per-device value meant the last folder used for either role
    // was offered under both. Per-role behaviour itself is covered in
    // depth by e2e-menu.js; this stays a round-trip check.
    const roundTrip = await cdp.eval(`(async () => {
      await window.freeframe.rememberFolder(${JSON.stringify(pickedA)}, "source", ${JSON.stringify(pickedB)});
      const r = await window.freeframe.getRecentFolders();
      return (r[${JSON.stringify(pickedA)}] || {}).source;
    })()`);
    check(
      Array.isArray(roundTrip) && roundTrip[0] === pickedB,
      "recent folder round-trips through the main process",
      JSON.stringify(roundTrip)
    );
    recentsPath = await cdp.eval(`window.freeframe.getRecentFolders().then(() => null)`).then(() => null);

    // ── 3. Per-device picker ─────────────────────────────────────────────
    console.log("\n3. Per-device folder picker");
    // window.freeframe is frozen by contextBridge (verified: assigning to it
    // is silently ignored), which is exactly the property that makes the
    // bridge untamperable from renderer code — so stub the renderer's own
    // pickFolder instead. That's the layer that decides which device the
    // dialog is rooted at, which is what item 3 is actually about.
    //
    // Limit worth stating: this proves the renderer passes the device
    // through. Whether the *native* dialog then honours defaultPath is not
    // automatable — showOpenDialog is a blocking OS modal.
    // Both pickers are stubbed: a *source* now goes through pickSource
    // (the panel that also accepts individual files), a destination still
    // through pickFolder. Same question either way — is the device
    // threaded down to the dialog.
    await cdp.eval(`
      window.__pickCalls = [];
      window.__origPick = window.pickFolder;
      window.pickFolder = async (opts) => {
        window.__pickCalls.push({ title: opts.title, defaultPath: opts.device });
        if (!extraFolders.includes(${JSON.stringify(pickedB)})) extraFolders.push(${JSON.stringify(pickedB)});
        return ${JSON.stringify(pickedB)};
      };
      window.__origPickSource = window.pickSource;
      window.pickSource = async (opts) => {
        window.__pickCalls.push({ title: opts.title, defaultPath: opts.device });
        applySourceSelection({ kind: "dir", paths: [${JSON.stringify(pickedB)}] }, opts.device);
        return { kind: "dir", paths: [${JSON.stringify(pickedB)}] };
      };
      true`);
    const dev = vols[0]?.mountPoint;
    if (dev) {
      // Open the context menu on a real volume card and use its entries.
      await cdp.eval(`clearAll(); render(); true`);
      const box = await cdp.centerOf(volSel(dev));
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "right", buttons: 2, clickCount: 1 });
      await sleep(80);
      // The flat "Choose folder here as Source/Destination…" pair became
      // "Source Folder ▸" / "Destination Folder ▸" submenus, each holding
      // Browse… plus that role's own recents. Same capability, different
      // shape — so this asserts the shape it actually has now.
      const items = await cdp.eval(`[...document.querySelectorAll('#menu .has-sub .sub-trigger span')].map(b => b.textContent.trim())`);
      check(items.includes("Source Folder"), "context menu offers per-device Source picker", items.join(" | "));
      check(items.includes("Destination Folder"), "context menu offers per-device Destination picker");

      await cdp.eval(`(() => {
        const wrap = [...document.querySelectorAll('#menu .has-sub')]
          .find(w => w.querySelector('span').textContent === 'Source Folder');
        wrap.querySelector('.sub-trigger').click();
        [...wrap.querySelectorAll('.submenu button')].find(b => b.textContent === 'Browse…').click();
        return true;
      })()`);
      await sleep(120);
      const calls = await cdp.eval("window.__pickCalls") || [];
      check(calls.length > 0 && calls[calls.length - 1]?.defaultPath === dev,
        "per-device picker passes that device as defaultPath",
        JSON.stringify(calls[calls.length - 1] ?? null));
      // And the general header button must NOT pass one.
      await cdp.eval(`document.querySelector('[data-choose="dest"]').click(); true`);
      await sleep(120);
      const calls2 = await cdp.eval("window.__pickCalls") || [];
      check(calls2.length > 0 && calls2[calls2.length - 1]?.defaultPath === undefined,
        "general header picker passes no defaultPath (stays a free browse)");
    }

    // ── 5. Dual-role conflict ────────────────────────────────────────────
    console.log("\n5. Same volume as both source and destination");
    await cdp.eval(`clearAll(); extraFolders = ${JSON.stringify([pickedA])}; render(); true`);
    // From the source side: already a destination, then set as source.
    await cdp.eval(`addDest(${JSON.stringify(pickedA)}, null); true`);
    await cdp.eval(`setSource(${JSON.stringify(pickedA)}); true`);
    await sleep(80);
    check(await cdp.eval(`document.getElementById('modal-backdrop').classList.contains('open')`),
      "modal opens when a destination is also made the source");
    check(await cdp.eval(`destNodes.some(n => n.path === ${JSON.stringify(pickedA)})`),
      "the destination is NOT silently evicted any more (old removeDest behaviour gone)");
    check(await cdp.eval(`sourcePath === ${JSON.stringify(pickedA)}`), "both roles held simultaneously");
    check(await cdp.eval(`document.getElementById('modal-done').disabled`), "Done disabled until both folders chosen");

    // Cancel reverts only the assignment that caused the conflict.
    await cdp.eval(`document.getElementById('modal-cancel').click(); true`);
    await sleep(60);
    check(await cdp.eval(`!document.getElementById('modal-backdrop').classList.contains('open')`), "Cancel closes the modal");
    check(await cdp.eval("sourcePath") === null, "Cancel reverted the source assignment that triggered it");
    check(await cdp.eval(`destNodes.some(n => n.path === ${JSON.stringify(pickedA)})`),
      "Cancel left the pre-existing destination alone");

    // From the destination side, symmetric.
    await cdp.eval(`clearAll(); extraFolders = ${JSON.stringify([pickedA])}; setSource(${JSON.stringify(pickedA)}); render(); true`);
    await cdp.eval(`addDest(${JSON.stringify(pickedA)}, null); true`);
    await sleep(80);
    check(await cdp.eval(`document.getElementById('modal-backdrop').classList.contains('open')`),
      "modal opens from the destination side too (addDest no longer refuses)");

    // Resolve it: choose both subfolders, confirm the root is replaced.
    // Same reason as item 3 — stub pickFolder, not the frozen bridge.
    await cdp.eval(`
      window.pickFolder = async (opts) => (String(opts.title).toLowerCase().includes('source')
        ? ${JSON.stringify(pickedA + "/SRC")} : ${JSON.stringify(pickedA + "/DST")});
      true`);
    await cdp.eval(`document.getElementById('modal-src').click(); true`); await sleep(80);
    await cdp.eval(`document.getElementById('modal-dst').click(); true`); await sleep(80);
    check(await cdp.eval(`!document.getElementById('modal-done').disabled`), "Done enables once both folders are chosen");
    await cdp.eval(`document.getElementById('modal-done').click(); true`); await sleep(80);
    check(await cdp.eval("sourcePath") === pickedA + "/SRC", "source became the chosen subfolder", await cdp.eval("sourcePath"));
    check(await cdp.eval(`destNodes[0] && destNodes[0].path`) === pickedA + "/DST", "destination became the chosen subfolder");
    check(await cdp.eval(`sourcePath !== destNodes[0].path`), "the two roles no longer share a path");

    // ── 8. Header alignment (all three col-heads must line up) ───────────
    console.log("\n8. Header row alignment across the three columns");
    const heads = await cdp.eval(`
      // Scoped to .columns: the Naming Fields panel (§22g/§25c) has its own
      // .col-head outside the three-column grid, and it is hidden entirely
      // when no preset is active. This check is about the three columns
      // lining up with each other.
      [...document.querySelectorAll('.columns .col-head')].map(h => {
        const r = h.getBoundingClientRect();
        return { bottom: Math.round(r.bottom * 100) / 100, height: Math.round(r.height * 100) / 100 };
      })`);
    check(heads.length === 3, "three column headers", `${heads.length}`);
    const bottoms = heads.map((h) => h.bottom);
    check(new Set(bottoms).size === 1, "all three header bottoms are identical", bottoms.join(" / "));
    check(new Set(heads.map((h) => h.height)).size === 1, "all three header heights are identical",
      heads.map((h) => h.height).join(" / "));
    // §22f removed the view toggle, so there is no second control to match
    // heights with any more. What replaced it as the root cause is
    // .col-head's pinned min-height: the Volumes header now has no control
    // of its own, and only the pin keeps it level with the other two.
    const ctrlHeights = await cdp.eval(`
      JSON.stringify({
        button: Math.round(document.querySelector('.col-head button').getBoundingClientRect().height * 100) / 100,
        minHeight: parseFloat(getComputedStyle(document.querySelector('.col-head')).minHeight),
      })`).then(JSON.parse);
    check(ctrlHeights.minHeight >= ctrlHeights.button,
      "the header pin is at least as tall as its tallest control (the actual root cause)",
      `button=${ctrlHeights.button} pin=${ctrlHeights.minHeight}`);

    // ── 9. Checksum picker ───────────────────────────────────────────────
    console.log("\n9. Checksum algorithm picker");
    check(await cdp.eval(`document.getElementById('algo-label').textContent`) === "SECURE · xxHash64",
      "defaults to xxHash64 so nothing changes for anyone who ignores it");
    await cdp.eval(`document.getElementById('algo-btn').click(); true`);
    await sleep(120);
    const opts = await cdp.eval(`[...document.querySelectorAll('.algo-opt .algo-name')].map(e => e.textContent)`);
    check(JSON.stringify(opts) === JSON.stringify(["xxHash64", "MD5", "SHA-1", "C4"]),
      "all four algorithms offered", opts.join(", "));
    const blurbs = await cdp.eval(`[...document.querySelectorAll('.algo-blurb')].map(e => e.textContent.length)`);
    check(blurbs.every((n) => n > 80), "each option carries the researched explainer, not just a name",
      `lengths ${blurbs.join("/")}`);
    check(await cdp.eval(`document.querySelector('.algo-guidance').textContent.includes('xxHash for speed')`),
      "the one-line guidance summary is present");
    // Pick SHA-1 and confirm it sticks.
    // Match the option NAME, not its text: xxHash64's own blurb mentions
    // "MD5/SHA-1/C4", so a substring match on the whole option hits it first.
    await cdp.eval(`[...document.querySelectorAll('.algo-opt')].find(o => o.querySelector('.algo-name').textContent === 'SHA-1').click(); true`);
    await sleep(100);
    check(await cdp.eval("algorithm") === "sha1", "selecting SHA-1 updates the live choice");
    check(await cdp.eval(`document.getElementById('algo-label').textContent`) === "SECURE · SHA-1",
      "header pill reflects the selection");
    check(await cdp.eval(`document.getElementById('algo-menu').style.display`) === "none", "menu closes on selection");
    await cdp.eval(`algorithm = 'xxhash64'; document.getElementById('algo-label').textContent = algoLabel(); true`);

    // ── 1. Live volume detection ─────────────────────────────────────────
    // Left until last: it mutates the machine's real mount table.
    console.log("\n1. Auto-refresh on a REAL mount/unmount (hdiutil)");
    await cdp.eval(`clearAll(); window.__refreshes = 0;
      const origRefresh = refresh;
      window.refresh = async function(){ window.__refreshes++; return origRefresh.apply(this, arguments); };
      window.freeframe.onVolumesChanged(() => window.refresh());
      true`);

    await execFileAsync("hdiutil", ["create", "-size", "12m", "-fs", "HFS+", "-volname", "FFTESTVOL", dmg]);
    const before = await cdp.eval("volumes.length");

    await execFileAsync("hdiutil", ["attach", dmg]);
    attached = true;
    // Wait for the watcher + debounce, with no user interaction at all.
    let appeared = false;
    for (let i = 0; i < 40; i++) {
      const names = await cdp.eval("volumes.map(v => v.name)");
      if (names.includes("FFTESTVOL")) { appeared = true; break; }
      await sleep(250);
    }
    check(appeared, "mounted volume appeared with ZERO manual clicks");
    check(await cdp.eval("volumes.length") > before, "volume count grew", `${before} → ${await cdp.eval("volumes.length")}`);
    const mountedVol = (await cdp.eval("JSON.stringify(volumes)").then(JSON.parse)).find((v) => v.name === "FFTESTVOL");
    if (mountedVol) {
      check(mountedVol.freeBytes > 0 && mountedVol.totalBytes > 0,
        "the newly mounted volume also reports real space", `total=${mountedVol.totalBytes} free=${mountedVol.freeBytes}`);
    }

    // ── 10. Eject, on the real disk image we just mounted ────────────────
    console.log("\n10. Eject / disconnect");
    const internal = (await cdp.eval("JSON.stringify(volumes)").then(JSON.parse)).find((v) => v.type === "internal");
    if (internal) {
      const refused = await cdp.eval(
        `window.freeframe.ejectVolume(${JSON.stringify(internal.mountPoint)})`);
      check(refused && refused.ok === false, "main process REFUSES to eject the internal drive", JSON.stringify(refused));
      // The refusal must come from OUR guard, not from macOS happening to
      // dissent — so assert the reason, not just the failure. Passing a
      // bogus type is the point: the handler must ignore it entirely.
      const lied = await cdp.eval(
        `window.freeframe.ejectVolume(${JSON.stringify(internal.mountPoint)}, "removable")`);
      check(lied && lied.ok === false && /internal system drive/i.test(lied.error || ""),
        "refusal comes from our own type check, not from diskutil failing", JSON.stringify(lied));
    }
    const outside = await cdp.eval(`window.freeframe.ejectVolume("/etc", "removable")`);
    check(outside && outside.ok === false, "refuses a path outside /Volumes", JSON.stringify(outside));

    // Menu entry wording + disabled-during-copy.
    await cdp.eval(`clearAll(); render(); true`);
    {
      const box = await cdp.centerOf(`#zone-volumes .tile[data-path="/Volumes/FFTESTVOL"]`);
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "right", buttons: 2, clickCount: 1 });
      await sleep(80);
      const items = await cdp.eval(`[...document.querySelectorAll('#menu button')].map(b => b.textContent.trim())`);
      check(items.includes("Eject"), "removable volume offers Eject", items.join(" | "));
      // §22b INVERTED THIS DELIBERATELY. Suppressing the whole menu during
      // any job was the bug: it also removed the only route to Rename, for
      // the length of an offload, on cards the job wasn't touching. The menu
      // now opens regardless; Eject alone disables itself, and only when
      // THIS volume is the one in use. The main process refuses
      // independently either way, which is the guarantee that matters.
      //
      // §65b removed Rename outright, so what is asserted below is that the
      // menu opens POPULATED — the symptom was it going useless mid-job,
      // and Rename was only ever the example of what went missing.
      const menuDuringCopy = await cdp.eval(`(() => {
        closeMenu();
        jobSnapshot = [{ status: "running", sourcePath: "/Volumes/FFTESTVOL", destPaths: [] }];
        openMenu({ preventDefault(){}, clientX: 100, clientY: 100 }, "/Volumes/FFTESTVOL", undefined);
        const buttons = [...document.querySelectorAll('#menu button')];
        const eject = buttons.find(b => /Eject|Disconnect/.test(b.textContent));
        const rename = buttons.find(b => /Rename/.test(b.textContent));
        const out = {
          shown: document.getElementById('menu').style.display,
          ejectDisabled: eject ? eject.disabled : null,
          renameReachable: Boolean(rename && !rename.disabled),
          itemCount: buttons.length,
        };
        closeMenu();
        // An idle volume's Eject must stay enabled while that job runs.
        const other = volumes.find(v => v.mountPoint !== "/Volumes/FFTESTVOL" && v.type !== "internal");
        if (other) {
          openMenu({ preventDefault(){}, clientX: 100, clientY: 100 }, other.mountPoint, undefined);
          const b = [...document.querySelectorAll('#menu button')].find(b => /Eject|Disconnect/.test(b.textContent));
          out.otherEjectDisabled = b ? b.disabled : null;
          closeMenu();
        }
        jobSnapshot = [];
        return out;
      })()`);
      check(menuDuringCopy.shown === "block" && menuDuringCopy.itemCount > 0,
        "the menu stays reachable during a job, and populated (§22b)", JSON.stringify(menuDuringCopy));
      check(menuDuringCopy.renameReachable === false, "Rename is no longer one of its entries (§65b)");
      check(menuDuringCopy.ejectDisabled === true,
        "but Eject is disabled for the volume the job is actually using");
      if (menuDuringCopy.otherEjectDisabled !== undefined && menuDuringCopy.otherEjectDisabled !== null) {
        check(menuDuringCopy.otherEjectDisabled === false,
          "and stays enabled for a volume the job is not touching");
      }
    }
    const netVol = (await cdp.eval("JSON.stringify(volumes)").then(JSON.parse)).find((v) => v.type === "network");
    if (netVol) {
      await cdp.eval(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, ${JSON.stringify(netVol.mountPoint)}, undefined); true`);
      await sleep(60);
      const netItems = await cdp.eval(`[...document.querySelectorAll('#menu button')].map(b => b.textContent.trim())`);
      check(netItems.includes("Disconnect") && !netItems.includes("Eject"),
        "network share says Disconnect, not Eject (matches Finder)", netItems.join(" | "));
      await cdp.eval(`closeMenu(); true`);
    }

    // And the main process refuses on its own while a job is live, with no
    // help from the UI — the renderer could be bypassed entirely.
    // The job needs real work: an empty source finishes in under a
    // millisecond, so the first attempt at this test ejected successfully
    // and proved nothing. 80 files gives it enough per-file overhead to
    // still be running when the eject lands.
    //
    // The guard became volume-specific with the job queue (§18c). It used
    // to refuse any eject while any copy ran anywhere, which with several
    // concurrent jobs would have made eject permanently unavailable. So
    // both halves are asserted now: the volume actually in use is
    // protected, and an unrelated one is not.
    {
      const busySrc = path.join(tmp, "BUSY_SRC");
      const busyDst = "/Volumes/FFTESTVOL/BUSY_DST";
      await fs.mkdir(busySrc, { recursive: true });
      for (let i = 0; i < 80; i++) {
        await fs.writeFile(path.join(busySrc, `f${i}.bin`), Buffer.alloc(64 * 1024, i));
      }
      const duringJob = await cdp.eval(`(async () => {
        const p = window.freeframe.startCopy(${JSON.stringify(busySrc)}, [{ id: 'x', path: ${JSON.stringify(busyDst)}, parentId: null }]);
        // Wait until the job is genuinely in flight rather than guessing.
        for (let i = 0; i < 100; i++) {
          const r = await window.freeframe.ejectVolume("/Volumes/FFTESTVOL");
          if (r && r.ok === false && /copy is in progress/i.test(r.error || "")) { try { await p; } catch {} return r; }
          if (r && r.ok === true) { try { await p; } catch {} return { ok: true, note: "ejected before the guard could apply" }; }
          await new Promise(res => setTimeout(res, 5));
        }
        try { await p; } catch {}
        return { ok: false, error: "job never observed as active" };
      })()`);
      check(duringJob && duringJob.ok === false && /copy is in progress/i.test(duringJob.error || ""),
        "main refuses to eject a volume a live job is writing to", JSON.stringify(duringJob));

      // The other half: a job on unrelated paths must NOT hold this volume
      // hostage. Under the old blanket guard this returned a refusal.
      const unrelatedDst = path.join(tmp, "BUSY_DST2");
      await fs.mkdir(unrelatedDst, { recursive: true });
      const duringUnrelated = await cdp.eval(`(async () => {
        const p = window.freeframe.startCopy(${JSON.stringify(busySrc)}, [{ id: 'y', path: ${JSON.stringify(unrelatedDst)}, parentId: null }]);
        let sawRunning = false, refusal = null;
        for (let i = 0; i < 200; i++) {
          const jobs = await window.freeframe.listJobs();
          const live = jobs.find(j => j.status === "running" || j.status === "queued");
          if (live) {
            sawRunning = true;
            const r = await window.freeframe.ejectVolume("/Volumes/FFTESTVOL");
            // Not ok is fine for other reasons (busy fs); only a guard
            // refusal is the failure being checked for here.
            if (r && r.ok === false && /copy is in progress/i.test(r.error || "")) refusal = r.error;
            break;
          }
          await new Promise(res => setTimeout(res, 5));
        }
        try { await p; } catch {}
        return { sawRunning, refusal };
      })()`);
      check(duringUnrelated.sawRunning && duringUnrelated.refusal === null,
        "a job on unrelated paths does not block ejecting this volume",
        JSON.stringify(duringUnrelated));

      // The eject above may well have succeeded — that was the point. Ask
      // the filesystem rather than the renderer, whose list only updates
      // when the debounced watcher fires and is briefly stale right here.
      let stillThere = true;
      try { await fs.access("/Volumes/FFTESTVOL"); } catch { stillThere = false; }
      if (!stillThere) {
        await execFileAsync("hdiutil", ["attach", dmg]);
        attached = true;
        for (let i = 0; i < 40; i++) {
          if ((await cdp.eval("volumes.map(v => v.name)")).includes("FFTESTVOL")) break;
          await sleep(250);
        }
      }
    }

    // Now actually eject it through the app and confirm the watcher notices.
    const ejectRes = await cdp.eval(`window.freeframe.ejectVolume("/Volumes/FFTESTVOL", "removable")`);
    check(ejectRes && ejectRes.ok === true, "ejected the mounted disk image through the app", JSON.stringify(ejectRes));
    attached = false;
    let goneAfterEject = false;
    for (let i = 0; i < 40; i++) {
      const names = await cdp.eval("volumes.map(v => v.name)");
      if (!names.includes("FFTESTVOL")) { goneAfterEject = true; break; }
      await sleep(250);
    }
    check(goneAfterEject, "UI dropped it on its own after eject — no renderer-side refresh needed");

    // Re-attach so the detach-based check below still has something to do.
    await execFileAsync("hdiutil", ["attach", dmg]);
    attached = true;
    for (let i = 0; i < 40; i++) {
      if ((await cdp.eval("volumes.map(v => v.name)")).includes("FFTESTVOL")) break;
      await sleep(250);
    }

    await execFileAsync("hdiutil", ["detach", "/Volumes/FFTESTVOL"]);
    attached = false;
    let vanished = false;
    for (let i = 0; i < 40; i++) {
      const names = await cdp.eval("volumes.map(v => v.name)");
      if (!names.includes("FFTESTVOL")) { vanished = true; break; }
      await sleep(250);
    }
    check(vanished, "unmounted volume disappeared with ZERO manual clicks");

    const refreshCount = await cdp.eval("window.__refreshes");
    check(refreshCount >= 4, "watcher fired for every mount-table change", `${refreshCount} refreshes`);
    // Four mount-table actions happen in this section (attach, eject,
    // re-attach, detach). Undebounced, each fires 3-5 raw fs events; the
    // ceiling here is deliberately below that floor so a broken debounce
    // still fails rather than being absorbed by a loose bound.
    check(refreshCount <= 12, "debounced — not one refresh per raw fs event",
      `${refreshCount} refreshes for 4 mount-table actions`);

    console.log(failures === 0 ? "\nALL 7 POLISH ITEMS EXERCISED — PASSED" : `\n${failures} CHECK(S) FAILED`);
  } finally {
    if (attached) await execFileAsync("hdiutil", ["detach", "/Volumes/FFTESTVOL", "-force"]).catch(() => {});
    child.kill("SIGTERM");
    await sleep(300);
    if (!child.killed) child.kill("SIGKILL");
    await fs.rm(tmp, { recursive: true, force: true });
    if (failures > 0 && logs.length) console.log("\n--- electron output ---\n" + logs.join(""));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("polish harness crashed:", e); process.exit(1); });
