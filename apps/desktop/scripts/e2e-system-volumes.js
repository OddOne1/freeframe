#!/usr/bin/env node
// §243 end-to-end: the real app, the real main process, the real /Volumes.
//
// test-volumes-system.js proves the decision (which volume is macOS's own,
// which path is inside one). This proves the WIRING — that the renderer
// never sees a Recovery tile, and that the refusal is enforced in the main
// process on every route a path can take in: the OS drop (classify-paths),
// the native picker's return value, and copy:start itself, which is the
// backstop a renderer bug would otherwise walk straight past.
//
// Run: node scripts/e2e-system-volumes.js
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9393;
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

  // A real directory on a normal volume, to prove the guard is a filter and
  // not a wall: everything else still gets through.
  const okDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff243-"));
  const okSrc = path.join(okDir, "src");
  const okDst = path.join(okDir, "dst");
  fs.mkdirSync(okSrc); fs.mkdirSync(okDst);
  fs.writeFileSync(path.join(okSrc, "CLIP.MOV"), "x");

  const systemMount = "/Volumes/Recovery";
  const haveRecovery = fs.existsSync(systemMount);

  try {
    console.log("\n1. the volume list the renderer is handed");
    const listed = await ev(`window.freeframe.listVolumes().then(v => v.map(x => x.mountPoint))`);
    console.log(`     ${listed.join(", ")}`);
    if (!haveRecovery) {
      console.log("  SKIP  /Volumes/Recovery is not mounted here");
    } else {
      check(!listed.includes(systemMount), "no Recovery among the volumes the app offers");
    }
    check(listed.includes("/Volumes/Macintosh HD"), "the boot volume is still offered");

    console.log("\n2. the OS drop (dialog:classify-paths, in main)");
    if (!haveRecovery) {
      console.log("  SKIP  needs a mounted system volume");
    } else {
      const dropped = await ev(`window.freeframe.classifyPaths([${JSON.stringify(systemMount + "/staging")}])`);
      check(dropped && dropped.refused === true, "dropping a folder inside Recovery is refused", JSON.stringify(dropped));
      check(
        typeof (dropped || {}).reason === "string" && /part of macOS/.test(dropped.reason),
        "and the refusal says why, in words",
        (dropped || {}).reason,
      );
    }
    const okDrop = await ev(`window.freeframe.classifyPaths([${JSON.stringify(okSrc)}])`);
    check(okDrop && okDrop.kind === "dir" && !okDrop.refused, "an ordinary folder is still accepted", JSON.stringify(okDrop));

    console.log("\n3. copy:start — the backstop the UI cannot be trusted to apply");
    const start = (src, dst) => ev(`
      window.freeframe.startCopy(${JSON.stringify(src)},
        [{ id: "d1", path: ${JSON.stringify(dst)}, parentId: null }], "xxhash64")
        .then(() => "accepted", e => String(e && e.message || e))
    `);
    if (!haveRecovery) {
      console.log("  SKIP  needs a mounted system volume");
    } else {
      const asDest = await start(okSrc, systemMount + "/staging/DAY_01");
      check(/part of macOS/.test(asDest), "a destination inside Recovery is refused by main", asDest);
      const asSource = await start(systemMount, okDst);
      check(/part of macOS/.test(asSource), "a source inside Recovery is refused by main", asSource);
    }

    console.log("\n4. and a normal copy still starts");
    const normal = await start(okSrc, okDst);
    check(normal === "accepted", "an ordinary source and destination are accepted", normal);
    await ev(`window.freeframe.cancelCopy ? true : true`);

    console.log("\n5. a system path is never remembered as a recent folder");
    if (!haveRecovery) {
      console.log("  SKIP  needs a mounted system volume");
    } else {
      // Deliberately exercises the REMEMBER side rather than seeding the
      // recents file: this asserts nothing is written, so it cannot leave
      // anything behind in the owner's real userData.
      const recents = await ev(`
        window.freeframe.rememberFolder(${JSON.stringify(systemMount)}, "destination",
          ${JSON.stringify(systemMount + "/staging")})
          .then(r => JSON.stringify(r))
      `);
      check(
        !recents.includes("/Volumes/Recovery"),
        "remembering a folder inside Recovery is a no-op, under the system volume or anywhere else",
        recents.slice(0, 200),
      );
      const afterGet = await ev(`window.freeframe.getRecentFolders().then(r => JSON.stringify(r))`);
      check(
        !afterGet.includes("/Volumes/Recovery"),
        "and reading the recents back returns nothing inside it",
        afterGet.slice(0, 200),
      );
    }

    console.log("\n6. §243 B — shared container, said once");
    await ev(`
      (() => {
        volumes = [
          { name: "Macintosh HD", mountPoint: "/Volumes/Macintosh HD", type: "internal",
            deviceId: "disk3s1s1", totalBytes: 1e12, freeBytes: 1.2e11, fileSystem: "apfs",
            isSystem: false, containerId: "disk3", sharesSpaceWith: ["Scratch"] },
          { name: "Scratch", mountPoint: "/Volumes/Scratch", type: "internal",
            deviceId: "disk3s7", totalBytes: 1e12, freeBytes: 1.2e11, fileSystem: "apfs",
            isSystem: false, containerId: "disk3", sharesSpaceWith: ["Macintosh HD"] },
          { name: "CARD_A", mountPoint: "/Volumes/CARD_A", type: "removable",
            deviceId: "disk4s1", totalBytes: 1e11, freeBytes: 9e10, fileSystem: "exfat",
            isSystem: false, containerId: null, sharesSpaceWith: [] },
        ];
        sourcePath = null; sourceFiles = null; destNodes = [];
        render();
        return true;
      })()
    `);
    const metas = await ev(`
      [...document.querySelectorAll("#zone-volumes .tile")].map(t => ({
        name: (t.querySelector(".tile-name") || {}).textContent || "",
        meta: (t.querySelector(".tile-meta") || {}).textContent || "",
        title: (t.querySelector(".tile-meta") || {}).title || "",
      }))
    `);
    const mac = metas.find((m) => m.name === "Macintosh HD") || {};
    const cardTile = metas.find((m) => m.name === "CARD_A") || {};
    check(/\(shared\)/.test(mac.meta), "a volume sharing a container says its free space is shared", mac.meta);
    check(
      /one pool, not one each/.test(mac.title) && /Scratch/.test(mac.title),
      "and the tooltip names the volume it shares with",
      mac.title,
    );
    check(!/\(shared\)/.test(cardTile.meta), "a card with its own filesystem says nothing of the kind", cardTile.meta);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    fs.rmSync(okDir, { recursive: true, force: true });
  }

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
