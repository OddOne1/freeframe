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

    // ── §66 — the tile says used or free depending on its role ──────────
    console.log("6b. (\u00a766) Storage shown depends on the tile's role");
    const meta = await ev(`(() => {
      volumes = [
        { name: "S66_Card", mountPoint: "/Volumes/S66_Card", type: "external",
          totalBytes: 512 * 1024 ** 3, freeBytes: 100 * 1024 ** 3 },
        { name: "S66_Raid", mountPoint: "/Volumes/S66_Raid", type: "external",
          totalBytes: 8 * 1024 ** 4, freeBytes: 3 * 1024 ** 4 },
        { name: "S66_Idle", mountPoint: "/Volumes/S66_Idle", type: "external",
          totalBytes: 4 * 1024 ** 4, freeBytes: 1 * 1024 ** 4 },
        // A network volume reports no sizes at all.
        { name: "S66_Nas", mountPoint: "/Volumes/S66_Nas", type: "network",
          totalBytes: null, freeBytes: null },
        // And the half-reported case: free known, total missing. Without a
        // separate fixture the total-is-null guard is unreachable, since
        // the free-is-null check above would already have returned.
        // (No backticks in here — this comment lives inside a template
        // literal, and one would end it.)
        { name: "S66_Half", mountPoint: "/Volumes/S66_Half", type: "network",
          totalBytes: null, freeBytes: 50 * 1024 ** 3 },
      ];
      ffProjects = [{ id: "s66", name: "S66_Project", asset_count: 7 }];
      extraFolders = [];
      clearAll();
      render();
      setSource("/Volumes/S66_Card");
      addDest("/Volumes/S66_Raid", null);
      // A network share as a second destination: the free-is-null guard is
      // only observable HERE, because the dest branch returns before the
      // total-is-null check that would otherwise cover for it.
      addDest("/Volumes/S66_Nas", null);
      render();
      const pick = (zone, name) => {
        const t = [...document.querySelectorAll(zone + " .tile")]
          .find(x => (x.querySelector(".tile-name") || {}).textContent === name);
        if (!t) return null;
        const m = t.querySelector(".tile-meta");
        return { text: m.textContent, clipped: m.scrollWidth > m.clientWidth + 1,
                 twoLine: m.classList.contains("two-line") };
      };
      return {
        source: pick("#zone-source", "S66_Card"),
        dest: pick("#zone-dest", "S66_Raid"),
        idle: pick("#zone-volumes", "S66_Idle"),
        nasDest: pick("#zone-dest", "S66_Nas"),
        project: pick("#zone-volumes", "S66_Project"),
        half: pick("#zone-volumes", "S66_Half"),
      };
    })()`);

    // 512 total - 100 free = 412 used. Asserting the NUMBER, not just the
    // word: showing free space labelled "used" would pass a word check.
    check(meta.source && meta.source.text === "412.0 GB used",
      "a source shows what the card HOLDS — that is what is about to be copied",
      meta.source && meta.source.text);
    check(meta.dest && meta.dest.text === "3.0 TB free",
      "a destination still shows what REMAINS, unchanged", meta.dest && meta.dest.text);
    check(meta.idle && /3\.0 TB used/.test(meta.idle.text) && /1\.0 TB free/.test(meta.idle.text),
      "an unassigned tile shows both, since neither question has been asked yet",
      meta.idle && JSON.stringify(meta.idle.text));
    // The Volumes column caps tiles at 118px (§22f) and the pair does not
    // fit on one line there — it ellipsised the free figure away entirely
    // before this wrapped.
    check(meta.idle && meta.idle.twoLine && !meta.idle.clipped,
      "on two lines, so neither figure is ellipsised away",
      meta.idle && JSON.stringify(meta.idle));
    check(meta.nasDest && meta.nasDest.text === "/Volumes/S66_Nas",
      "a destination reporting no sizes falls back to its mount point, not \u201c\u2014 free\u201d",
      meta.nasDest && meta.nasDest.text);
    check(meta.half && meta.half.text === "/Volumes/S66_Half",
      "a volume that reports free but not total also falls back — used cannot be computed",
      meta.half && meta.half.text);
    check(meta.project && meta.project.text === "7 assets",
      "and a FreeFrame project is untouched", meta.project && meta.project.text);

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
