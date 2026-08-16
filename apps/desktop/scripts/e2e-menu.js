#!/usr/bin/env node
// Context-menu cleanup — three items.
//
//   1. Once a card holds a role, the opposite role's plain actions are gone
//      (but the dual-role capability still has a menu path).
//   2. "Source Folder ▸" / "Destination Folder ▸" submenus: Browse…,
//      that role's own recents, Clear Recents.
//   3. Recents are per device AND per role. The reported bug: one drive
//      whose source was PROG and destination was Prints offered "Prints"
//      under both labels.
//
// Section 3 reproduces that exact scenario, and additionally checks that a
// second drive's submenus never show the first drive's history.
//
// Run: node scripts/e2e-menu.js
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");
const APP = path.join(__dirname, "..");
const PORT = 9316;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { require("child_process").execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
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
    const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
    return r.result.value;
  };
  const shot = async (f) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    await fsp.writeFile(f, Buffer.from(s.data, "base64"));
  };
  await send("Runtime.enable");
  await sleep(1800);

  /** Open the menu on `p` and read back its top-level rows. */
  const openOn = (p, role) => ev(`(() => {
    openMenu({preventDefault(){},clientX:200,clientY:200}, ${JSON.stringify(p)}, ${JSON.stringify(role)});
    return [...menu.children].map(n =>
      n.classList.contains("sep") ? "---"
      : n.classList.contains("label") ? "[" + n.textContent + "]"
      : n.classList.contains("has-sub") ? n.querySelector("span").textContent + " >"
      : n.textContent + (n.disabled ? " (disabled)" : ""));
  })()`);

  /** Rows inside a named submenu, opening it the way a user would. */
  const openSub = (label) => ev(`(() => {
    const wrap = [...menu.querySelectorAll(".has-sub")]
      .find(w => w.querySelector("span").textContent === ${JSON.stringify(label)});
    if (!wrap) return null;
    wrap.querySelector(".sub-trigger").click();
    const panel = wrap.querySelector(".submenu");
    if (!panel.classList.contains("open")) return "NOT OPEN";
    return [...panel.children].map(n =>
      n.classList.contains("sep") ? "---"
      : n.classList.contains("label") ? "[" + n.textContent + "]"
      : n.textContent);
  })()`);

  const drive = await ev(`(volumes.find(v=>v.type==='removable')||volumes[0]).mountPoint`);
  const other = await ev(`(() => {
    const d = (volumes.find(v=>v.type==='removable')||volumes[0]).mountPoint;
    const o = volumes.find(v => v.mountPoint !== d);
    return o ? o.mountPoint : null;
  })()`);
  console.log(`Drive under test: ${drive}`);
  console.log(`Second drive:     ${other || "(none mounted — cross-device check will be skipped)"}\n`);

  // ── 1 ────────────────────────────────────────────────────────────────
  console.log("1. Opposite-role actions hidden once a card holds a role");

  await ev(`clearAll(); recentFolders = {}; render(); true`);
  let rows = await openOn(drive, undefined);
  check(rows.includes("Set as Source"), "unassigned: Set as Source offered");
  check(rows.includes("Set as Destination"), "unassigned: Set as Destination offered");
  check(rows.includes("Source Folder >") && rows.includes("Destination Folder >"),
    "unassigned: both role submenus offered", rows.filter(r => r.endsWith(" >")).join(", "));

  await ev(`clearAll(); sourcePath=${JSON.stringify(drive)}; render(); true`);
  rows = await openOn(drive, "source");
  check(!rows.some(r => r.startsWith("Set as Destination")),
    "as SOURCE: no \"Set as Destination\"", rows.join(" | "));
  check(!rows.includes("Destination Folder >"),
    "as SOURCE: no \"Destination Folder\" submenu");
  check(rows.includes("Source Folder >"), "as SOURCE: its own Source Folder submenu remains");
  check(rows.includes("Set as Source (disabled)"),
    "as SOURCE: Set as Source shown disabled — it IS the source", rows.join(" | "));
  check(rows.includes("Also use as Destination…"),
    "as SOURCE: the dual-role capability still has ONE menu path");

  await ev(`clearAll(); destNodes=[{id:'d1',path:${JSON.stringify(drive)},parentId:null}]; render(); true`);
  rows = await openOn(drive, "dest");
  check(!rows.some(r => r.startsWith("Set as Source")),
    "as DEST: no \"Set as Source\"", rows.join(" | "));
  check(!rows.includes("Source Folder >"), "as DEST: no \"Source Folder\" submenu");
  check(rows.includes("Destination Folder >"), "as DEST: its own Destination Folder submenu remains");
  check(rows.includes("Also use as Source…"), "as DEST: mirrored dual-role entry");

  // The entry must actually reach the conflict modal, not just exist.
  await ev(`closeMenu(); clearAll(); sourcePath=${JSON.stringify(drive)}; render();
    addDest(${JSON.stringify(drive)}, null); true`);
  check(await ev(`$("modal-backdrop").classList.contains("open")`),
    "…and it routes into the dual-role modal, so the capability really is intact");
  await ev(`closeModal(); clearAll(); render(); true`);

  // ── 2 ────────────────────────────────────────────────────────────────
  console.log("\n2. Role submenus: Browse… / Recent Folders: / Clear Recents");
  await ev(`clearAll(); recentFolders = {}; render(); true`);
  await openOn(drive, undefined);

  let sub = await openSub("Source Folder");
  check(Array.isArray(sub), "Source Folder submenu opens", String(sub));
  check(sub[0] === "Browse…", "first entry is Browse…", sub.join(" | "));
  check(sub.length === 1, "with no recents, nothing else is shown", sub.join(" | "));

  // Now give it real per-role history and re-check the structure.
  const PROG = `${drive}/PROG`, PRINTS = `${drive}/Prints`;
  await ev(`recentFolders = { ${JSON.stringify(drive)}: {
    source: [${JSON.stringify(PROG)}],
    destination: [${JSON.stringify(PRINTS)}]
  } }; render(); true`);
  await openOn(drive, undefined);

  sub = await openSub("Source Folder");
  check(JSON.stringify(sub) === JSON.stringify(["Browse…", "---", "[Recent Folders:]", "PROG", "---", "Clear Recents"]),
    "structure matches the reference exactly", sub.join(" | "));

  const flips = await ev(`(() => {
    const p = menu.querySelector(".submenu.open");
    const r = p.getBoundingClientRect();
    return { right: Math.round(r.right), win: window.innerWidth, onScreen: r.right <= window.innerWidth };
  })()`);
  check(flips.onScreen, "submenu stays on screen", `right=${flips.right} win=${flips.win}`);

  // Near the right edge it must flip rather than run off.
  const flipped = await ev(`(() => {
    openMenu({preventDefault(){},clientX:window.innerWidth-40,clientY:200}, ${JSON.stringify(drive)}, undefined);
    const wrap = [...menu.querySelectorAll(".has-sub")].find(w => w.querySelector("span").textContent === "Source Folder");
    wrap.querySelector(".sub-trigger").click();
    const p = wrap.querySelector(".submenu");
    return { flip: p.classList.contains("flip"), right: Math.round(p.getBoundingClientRect().right), win: window.innerWidth };
  })()`);
  check(flipped.flip, "opened near the right edge, it flips to the left");
  check(flipped.right <= flipped.win, "…and is still fully on screen", `right=${flipped.right}`);

  const low = await ev(`(() => {
    openMenu({preventDefault(){},clientX:200,clientY:window.innerHeight-30}, ${JSON.stringify(drive)}, undefined);
    const wrap = [...menu.querySelectorAll(".has-sub")].find(w => w.querySelector("span").textContent === "Source Folder");
    wrap.querySelector(".sub-trigger").click();
    const r = wrap.querySelector(".submenu").getBoundingClientRect();
    return { bottom: Math.round(r.bottom), top: Math.round(r.top), win: window.innerHeight };
  })()`);
  check(low.bottom <= low.win, "opened near the bottom, it's pulled up instead of running off",
    `bottom=${low.bottom} win=${low.win}`);
  check(low.top >= 0, "…without being pushed off the top instead", `top=${low.top}`);

  await ev(`openMenu({preventDefault(){},clientX:200,clientY:200}, ${JSON.stringify(drive)}, undefined);
    [...menu.querySelectorAll(".has-sub")].find(w=>w.querySelector("span").textContent==="Source Folder")
      .querySelector(".sub-trigger").click(); true`);
  await shot("/tmp/menu-submenu.png");

  // ── 3 ────────────────────────────────────────────────────────────────
  console.log("\n3. Recents are per-role — the reported bug");
  console.log(`     source used: PROG      destination used: Prints`);

  const srcSub = await openSub("Source Folder");
  await ev(`openMenu({preventDefault(){},clientX:200,clientY:200}, ${JSON.stringify(drive)}, undefined); true`);
  const dstSub = await openSub("Destination Folder");

  check(srcSub.includes("PROG") && !srcSub.includes("Prints"),
    "Source submenu lists PROG only — NOT the destination's folder", srcSub.join(" | "));
  check(dstSub.includes("Prints") && !dstSub.includes("PROG"),
    "Destination submenu lists Prints only — NOT the source's folder", dstSub.join(" | "));

  // Cross-device: the property that was already correct and had to stay so.
  if (other) {
    await ev(`openMenu({preventDefault(){},clientX:200,clientY:200}, ${JSON.stringify(other)}, undefined); true`);
    const otherSrc = await openSub("Source Folder");
    const hasSub = Array.isArray(otherSrc);
    check(hasSub, "second drive has its own Source Folder submenu");
    if (hasSub) {
      check(!otherSrc.includes("PROG") && !otherSrc.includes("Prints"),
        "…showing NONE of the first drive's history", otherSrc.join(" | "));
      check(!otherSrc.includes("Clear Recents"),
        "…and no Clear Recents, since it has no recents of its own");
    }
  }

  // Round-trip through the real IPC, including the persisted file.
  console.log("\n   Persistence, through the real IPC");
  const persisted = await ev(`(async () => {
    await window.freeframe.clearRecentFolders(${JSON.stringify(drive)}, "source");
    await window.freeframe.clearRecentFolders(${JSON.stringify(drive)}, "destination");
    await window.freeframe.rememberFolder(${JSON.stringify(drive)}, "source", ${JSON.stringify(PROG)});
    await window.freeframe.rememberFolder(${JSON.stringify(drive)}, "destination", ${JSON.stringify(PRINTS)});
    return await window.freeframe.getRecentFolders();
  })()`);
  const entry = persisted[drive] || {};
  check(JSON.stringify(entry.source) === JSON.stringify([PROG]), "source slot persisted", JSON.stringify(entry.source));
  check(JSON.stringify(entry.destination) === JSON.stringify([PRINTS]), "destination slot persisted", JSON.stringify(entry.destination));

  const promoted = await ev(`(async () => {
    await window.freeframe.rememberFolder(${JSON.stringify(drive)}, "source", ${JSON.stringify(drive + "/DAY02")});
    await window.freeframe.rememberFolder(${JSON.stringify(drive)}, "source", ${JSON.stringify(PROG)});
    return (await window.freeframe.getRecentFolders())[${JSON.stringify(drive)}].source;
  })()`);
  check(promoted[0] === PROG, "re-picking promotes rather than duplicating", promoted.join(", "));
  check(promoted.filter((f) => f === PROG).length === 1, "…and doesn't double-list it");

  const afterClear = await ev(`(async () => {
    await window.freeframe.clearRecentFolders(${JSON.stringify(drive)}, "source");
    return await window.freeframe.getRecentFolders();
  })()`);
  const e2 = afterClear[drive] || {};
  check(!e2.source, "Clear Recents empties that role");
  check(JSON.stringify(e2.destination) === JSON.stringify([PRINTS]),
    "…and leaves the OTHER role untouched", JSON.stringify(e2.destination));

  // A role-less call must be refused rather than guessed at.
  const refused = await ev(`(async () => {
    const before = JSON.stringify(await window.freeframe.getRecentFolders());
    await window.freeframe.rememberFolder(${JSON.stringify(drive)}, "banana", "/tmp/x");
    return before === JSON.stringify(await window.freeframe.getRecentFolders());
  })()`);
  check(refused, "an unknown role is refused, not filed under a guess");

  await ev(`(async () => {
    await window.freeframe.clearRecentFolders(${JSON.stringify(drive)}, "destination");
  })()`);

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  console.log("Screenshot: /tmp/menu-submenu.png");
  child.kill("SIGKILL");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
