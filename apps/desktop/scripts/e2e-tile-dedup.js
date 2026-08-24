#!/usr/bin/env node
// Boot-volume duplicate tile, outline-only roles, menu cleanup (§59).
//
// The priority item is #0: picking two folders on the SAME drive must
// outline that one drive, never sprout extra tiles. It reproduces with a
// synthetic volume list because the real one depends on what is plugged in
// — the bug is in deviceFor's matching, not in enumeration, and driving
// the renderer's own state is what exercises it deterministically.
//
// Run: node scripts/e2e-tile-dedup.js
const { execSync } = require("node:child_process");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9379;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  const child = spawnElectron(
    path.join(APP, "node_modules", ".bin", "electron"),
    [APP, `--remote-debugging-port=${PORT}`],
    { stdio: "ignore" },
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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 60000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
    return r.result.value;
  };
  await send("Runtime.enable");
  await sleep(1800);

  /** A boot volume plus one external, as listVolumes() would report them. */
  const setup = (src, dst) => `
    (() => {
      volumes = [
        { name: "Macintosh HD", mountPoint: "/Volumes/Macintosh HD", type: "internal",
          deviceId: "disk1s1", totalBytes: 1e12, freeBytes: 5e11, fileSystem: "APFS" },
        { name: "CARD_A", mountPoint: "/Volumes/CARD_A", type: "removable",
          deviceId: "disk4s1", totalBytes: 1e11, freeBytes: 9e10, fileSystem: "ExFAT" },
      ];
      extraFolders = [${JSON.stringify(src)}, ${JSON.stringify(dst)}];
      sourcePath = ${JSON.stringify(src)};
      sourceFiles = null;
      destNodes = [{ id: "d1", path: ${JSON.stringify(dst)}, parentId: null }];
      render();
      return true;
    })()
  `;

  const tiles = `[...document.querySelectorAll("#zone-volumes .tile")].map(t =>
      (t.querySelector(".tile-name") || {}).textContent || "")`;

  try {
    console.log("0. The duplicate tile (the priority fix)");
    await ev(setup("/Users/me/Downloads", "/Users/me/Desktop"));
    await sleep(300);

    const bootTiles = await ev(tiles);
    check(bootTiles.filter((n) => n.includes("Downloads") || n.includes("Desktop")).length === 0,
      "two boot-drive folders produce NO standalone tiles", JSON.stringify(bootTiles));
    check(bootTiles.filter((n) => n.includes("Macintosh HD")).length === 1,
      "exactly one tile for the drive itself", JSON.stringify(bootTiles));
    check(await ev(`deviceFor("/Users/me/Downloads")`) === "/Volumes/Macintosh HD",
      "a /Users path resolves to the internal volume rather than null",
      "the whole root cause: APFS firmlinks mean it never carries the mount prefix");

    const cls = await ev(`
      [...document.querySelectorAll("#zone-volumes .tile")]
        .find(t => (t.querySelector(".tile-name")||{}).textContent.includes("Macintosh HD")).className
    `);
    check(/role-both/.test(cls), "and it is outlined as holding both roles", cls);

    console.log("1. Externals still work (no regression)");
    await ev(setup("/Volumes/CARD_A/DCIM", "/Volumes/CARD_A/Proxies"));
    await sleep(300);
    const ext = await ev(tiles);
    check(ext.filter((n) => n.includes("DCIM") || n.includes("Proxies")).length === 0,
      "picked folders on an external collapse onto its tile too", JSON.stringify(ext));
    check(await ev(`deviceFor("/Volumes/CARD_A/DCIM")`) === "/Volumes/CARD_A",
      "and the longest-prefix match still wins over the internal fallback");

    console.log("2. Outlines only");
    check(await ev(`document.querySelectorAll(".tile-roles, .tile-role").length`) === 0,
      "no Source/Dest text badge anywhere, in any column");
    check(await ev(`
      (() => {
        const t = [...document.querySelectorAll("#zone-volumes .tile")]
          .find(x => x.className.includes("role-both"));
        return getComputedStyle(t).backgroundImage.includes("repeating-linear-gradient");
      })()
    `), "role-both is repeating diagonal stripes, not a half-and-half split");
    check(await ev(`
      (() => {
        const t = [...document.querySelectorAll("#zone-volumes .tile")]
          .find(x => x.className.includes("role-both"));
        return parseFloat(getComputedStyle(t).borderTopLeftRadius) > 0;
      })()
    `), "and the corners are still round — the reason border-image was avoided");

    console.log("3. Context menu on a source tile");
    const srcMenu = await ev(`
      (() => {
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "/Volumes/CARD_A/DCIM", "source");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(srcMenu.length > 0,
      "the menu rendered at all — every 'is absent' check below is vacuous otherwise",
      `${srcMenu.length} items`);
    check(!srcMenu.some((t) => t === "Set as Source"),
      "own role is gone, not greyed", JSON.stringify(srcMenu));
    check(!srcMenu.some((t) => t.startsWith("Rename")),
      "Rename is gone — the tile name is already click-to-rename");
    check(srcMenu.includes("Remove"), "Remove stays for a source");
    check(srcMenu.includes("Choose a different folder/file…"),
      "and a swap-in-place entry is offered");

    console.log("4. Context menu on a destination tile");
    const dstMenu = await ev(`
      (() => {
        closeMenu();
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "/Volumes/CARD_A/Proxies", "dest");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(dstMenu.length > 0, "the menu rendered at all", `${dstMenu.length} items`);
    check(!dstMenu.some((t) => t === "Set as Destination"), "own role gone", JSON.stringify(dstMenu));
    check(!dstMenu.some((t) => t.startsWith("Rename")), "Rename gone");
    check(!dstMenu.includes("Remove"),
      "Remove is gone entirely for a destination — swap, never clear to empty");
    check(dstMenu.includes("Choose a different folder/file…"), "swap-in-place is how it changes");

    console.log("5. A FreeFrame project keeps its own folder actions");
    const projMenu = await ev(`
      (() => {
        closeMenu();
        ffProjects = [{ id: "p1", name: "Padel", posterUrl: null }];
        destNodes = [{ id: "d9", path: "freeframe://p1", parentId: null }];
        render();
        openMenu({ preventDefault(){}, stopPropagation(){}, clientX: 20, clientY: 20 },
                 "freeframe://p1", "dest");
        return [...document.querySelectorAll("#menu button")].map(i => i.textContent.trim());
      })()
    `);
    check(projMenu.length > 0, "the menu rendered at all", `${projMenu.length} items`);
    check(projMenu.some((t) => /Destination Folder/.test(t)),
      "its §24a submenus are untouched", JSON.stringify(projMenu));
    check(!projMenu.includes("Choose a different folder/file…"),
      "and it does NOT also get the generic swap entry — that ambiguity is what §24a removed");

    console.log("6. The panel's Clear controls exist in both windows");
    check(await ev(`!!document.getElementById("jobs-clear")`), "docked panel has Clear");
    const panelSrc = require("node:fs").readFileSync(
      path.join(APP, "src", "renderer", "panel.html"), "utf8");
    check(/id="clear"/.test(panelSrc) && /clearFinishedJobs/.test(panelSrc),
      "and so does the detached window");
    const js = require("node:fs").readFileSync(
      path.join(APP, "src", "renderer", "panel.js"), "utf8");
    check(/job-remove/.test(js) && /onRemove/.test(js),
      "renderJobs emits a per-row remove");
    check(/status === "running" \|\| j\.status === "queued"[\s\S]{0,400}else if \(onRemove\)/.test(js),
      "and only ever instead of Cancel, never alongside it");
  } finally {
    try { ws.close(); } catch {}
    try { child.kill(); } catch {}
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
