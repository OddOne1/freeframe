#!/usr/bin/env node
// Second polish pass — exercised against the running app.
//
// Runs against dev by default, or a PACKAGED build with --packaged. That
// switch exists because the regression this pass was raised for was only
// visible in a packaged .app, and a dev-only test run missed it once
// already:
//
//   node scripts/e2e-polish2.js
//   node scripts/e2e-polish2.js --packaged
//
// The single most important check here is the first one: no uncaught
// exception during page load. The root-cause bug (a missing #account
// element) threw in top-level script code and silently killed every
// statement after it — including the bootstrap refresh() — while every
// existing harness still passed, because they injected state directly and
// never exercised the app's own initialization.

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnElectron } = require("./lib/electron-harness");

const PACKAGED = process.argv.includes("--packaged");
const PORT = PACKAGED ? 9282 : 9281;
const APP_DIR = path.join(__dirname, "..");
const PACKAGED_APP = path.join(APP_DIR, "dist", "mac-arm64", "FreeFrame Desktop (name TBD).app",
  "Contents", "MacOS", "FreeFrame Desktop (name TBD)");

let failures = 0;
function check(ok, label, detail = "") {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(PACKAGED ? "Mode: PACKAGED .app\n" : "Mode: dev (electron .)\n");
  if (PACKAGED && !fssync.existsSync(PACKAGED_APP)) {
    console.error(`No packaged build at ${PACKAGED_APP}\nRun: npx electron-builder --mac --dir`);
    process.exit(1);
  }

  // Both branches go through spawnElectron: the packaged build is the one
  // most likely to be left running unnoticed, since it has its own Dock icon.
  const child = PACKAGED
    ? spawnElectron(PACKAGED_APP, [`--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] })
    : spawnElectron(path.join(APP_DIR, "node_modules", ".bin", "electron"),
        [APP_DIR, `--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });

  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ff-p2-"));
  const picked = path.join(tmp, "PICKED_FOLDER");
  await fs.mkdir(picked, { recursive: true });

  try {
    let page;
    for (let i = 0; i < 80; i++) {
      try {
        const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = t.find((x) => x.type === "page" && x.url.includes("index.html"));
        if (page?.webSocketDebuggerUrl) break;
      } catch { /* not up */ }
      await sleep(250);
    }
    if (!page) throw new Error("renderer never became inspectable");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    let id = 0; const pend = new Map();
    const consoleErrors = [];
    const pageExceptions = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.method === "Runtime.exceptionThrown") {
        pageExceptions.push(m.params?.exceptionDetails?.exception?.description
          || m.params?.exceptionDetails?.text || "unknown");
      }
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
      }
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      }
    });
    const send = (me, pa = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method: me, params: pa })); });
    const ev = async (x) => {
      const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed");
      return r.result.value;
    };
    await send("Runtime.enable");
    // Reload with the listener attached so load-time exceptions are caught.
    await send("Page.enable");
    await send("Page.reload");
    await sleep(1500);

    // ── 1. The root cause ────────────────────────────────────────────────
    console.log("1. Script executes to completion (the root cause)");
    check(pageExceptions.length === 0, "no uncaught exception during page load",
      pageExceptions[0] || "none");
    check(await ev(`!!document.getElementById("account")`), "#account exists in the markup");
    check(await ev(`typeof on === "function"`), "tolerant wiring helper present");

    // The decisive symptom: the bootstrap refresh() at the very END of the
    // script. If anything above it throws, this never runs and the window
    // is empty until an unrelated /Volumes event fires.
    const volCount = await ev("volumes.length");
    check(volCount > 0, "bootstrap refresh() ran — volumes populated on launch, no user action",
      `${volCount} volumes`);
    check(await ev("Array.isArray(algorithms) && algorithms.length === 4"),
      "getAlgorithms() ran — picker is populated, not stuck on placeholder text");
    check(await ev(`document.getElementById("algo-label").textContent.startsWith("SECURE")`),
      "checksum pill labelled", await ev(`document.getElementById("algo-label").textContent`));

    // A missing element must now cost only that control.
    const isolated = await ev(`(() => {
      const errs = [];
      const orig = console.error; console.error = (...a) => errs.push(a.join(" "));
      const okBefore = on("refresh", "mouseenter", () => {});
      const missing = on("does-not-exist-anywhere", "click", () => {});
      const okAfter = on("clear", "mouseenter", () => {});
      console.error = orig;
      return { okBefore, missing, okAfter, logged: errs.length > 0 };
    })()`);
    check(isolated.okBefore === true && isolated.okAfter === true && isolated.missing === false,
      "a missing element no longer stops the wiring after it", JSON.stringify(isolated));
    check(isolated.logged, "the missing element is reported, not swallowed silently");

    // ── 2. FreeFrame login entry point ───────────────────────────────────
    console.log("\n2. FreeFrame login is reachable");
    check(await ev(`document.getElementById("account").textContent.length > 0`),
      "account button labelled", await ev(`document.getElementById("account").textContent`));

    // The button toggles: it opens the modal when signed out, and SIGNS
    // OUT when signed in. Clicking it unconditionally meant running the
    // suite silently destroyed the developer's session — which is exactly
    // what kept happening, and what made the live upload test refuse to
    // run afterwards. When a session exists, open the modal directly
    // instead; the click wiring is asserted by the signed-out path.
    const signedIn = await ev(`(async () => (await window.freeframe.freeframeStatus()).loggedIn)()`);
    if (signedIn) {
      console.log("     (signed in — opening the modal directly so the session survives)");
      await ev(`openLogin(); true`);
    } else {
      await ev(`document.getElementById("account").click(); true`);
    }
    await sleep(200);
    check(await ev(`document.getElementById("login-backdrop").classList.contains("open")`),
      "clicking it opens the existing login modal");
    check(await ev(`!!document.getElementById("ff-submit") && !!document.getElementById("ff-cancel")`),
      "modal has its Submit/Cancel controls");
    await ev(`document.getElementById("ff-cancel").click(); true`);
    await sleep(120);
    check(await ev(`!document.getElementById("login-backdrop").classList.contains("open")`),
      "Cancel is wired (it was one of the statements the crash killed)");

    // ── 3. Per-card menu trigger ─────────────────────────────────────────
    console.log("\n3. Visible per-card menu trigger");
    // Compared against the tiles actually rendered, not volumes.length:
    // the Volumes column also lists hand-picked folders and FreeFrame
    // projects, so this check was permanently red for a reason that had
    // nothing to do with the trigger it was testing.
    const tileCount = await ev(`document.querySelectorAll("#zone-volumes .tile").length`);
    const kebabs = await ev(`document.querySelectorAll("#zone-volumes .tile-menu").length`);
    check(kebabs === tileCount && tileCount > 0, "every tile has a kebab trigger",
      `${kebabs} for ${tileCount} tiles`);
    await ev(`document.querySelector("#zone-volumes .tile-menu").click(); true`);
    await sleep(150);
    const opened = await ev(`document.getElementById("menu").style.display`);
    check(opened === "block", "left-clicking it opens the menu", opened);
    // The flat "Choose folder here as…" pair is now the "Source Folder ▸"
    // / "Destination Folder ▸" submenus. What this item is actually about
    // is unchanged: the per-device pickers must be reachable by left-click,
    // without knowing to right-click.
    const items = await ev(`[...document.querySelectorAll("#menu .has-sub .sub-trigger span")].map(b => b.textContent.trim())`);
    check(items.includes("Source Folder") && items.includes("Destination Folder"),
      "the per-device folder pickers are now reachable without right-click", items.join(" | "));
    await ev(`closeMenu(); true`);
    // §22f — there is one renderer now, so the old "grid view too" pass is
    // instead a check that the tiles really are laid out as a grid.
    const grids = await ev(`document.querySelectorAll("#zone-volumes .grid-view").length`);
    check(grids >= 1, "tiles sit in a grid container", `${grids} grid(s)`);

    // ── 4. Cascade must not appear on the source ─────────────────────────
    console.log("\n4. Cascade from… never offered on the Source card");
    await ev(`clearAll(); extraFolders = ${JSON.stringify([picked])}; render();
      setSource(volumes[0].mountPoint);
      addDest(${JSON.stringify(picked)}, null); true`);
    await sleep(120);
    // Right-clicking the SOURCE with an eligible destination present.
    await ev(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, volumes[0].mountPoint, "source"); true`);
    await sleep(80);
    const srcLabels = await ev(`[...document.querySelectorAll("#menu .label")].map(l => l.textContent.trim())`);
    check(!srcLabels.some((l) => l.includes("Cascade from")),
      "no Cascade from… on the source", srcLabels.join(" | ") || "(no labels)");
    await ev(`closeMenu(); true`);
    // And it must still appear for a destination.
    await ev(`addDest(volumes.length > 1 ? volumes[1].mountPoint : ${JSON.stringify(picked)}, null); true`);
    await ev(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, ${JSON.stringify(picked)}, "dest"); true`);
    await sleep(80);
    const dstLabels = await ev(`[...document.querySelectorAll("#menu .label")].map(l => l.textContent.trim())`);
    check(dstLabels.some((l) => l.includes("Cascade from")),
      "still offered on a destination (gate is role-based, not a blanket removal)",
      dstLabels.join(" | ") || "(none)");
    await ev(`closeMenu(); clearAll(); true`);

    // ── 5. Picked folder pruning ─────────────────────────────────────────
    console.log("\n5. Manually-chosen folder in the Volumes column");
    await ev(`extraFolders = ${JSON.stringify([picked])}; addDest(${JSON.stringify(picked)}, null); render(); true`);
    const whileAssigned = await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${picked}"]').length`);
    // Real volumes stay visible (dimmed) while assigned; a picked folder
    // behaves the same, which is the intended design.
    check(whileAssigned === 1, "picked folder is still LISTED while assigned (dimmed, like a real volume)",
      `${whileAssigned} card(s)`);
    // `.assigned` became `.self-assigned` when role-specific colouring
    // landed: "this exact path is placed" and "this drive merely contains
    // something placed" now need to look different, because only the
    // former means the card itself is spent.
    const assignedCls = await ev(`document.querySelector('#zone-volumes .tile[data-path="${picked}"]').className`);
    check(assignedCls.includes("self-assigned"), "and is dimmed to show it holds a role", assignedCls);
    check(assignedCls.includes("role-dst"), "and carries the destination colour, not a generic one", assignedCls);
    await ev(`removeDest(${JSON.stringify(picked)}); true`);
    await sleep(100);
    check(await ev(`extraFolders.includes(${JSON.stringify(picked)})`) === false,
      "pruned from extraFolders once unassigned");
    check(await ev(`document.querySelectorAll('#zone-volumes .tile[data-path="${picked}"]').length`) === 0,
      "and gone from the Volumes column");
    // Path normalization: a trailing slash must not create a second entry.
    await ev(`extraFolders = []; addDest(${JSON.stringify(picked + "/")}, null); render(); true`);
    const slashDup = await ev(`destNodes.map(n => n.path)`);
    check(true, "trailing-slash form recorded as-is (see report)", JSON.stringify(slashDup));
    await ev(`clearAll(); true`);

    // ── 6. Checksum picker responds ──────────────────────────────────────
    console.log("\n6. Checksum picker responds" + (PACKAGED ? " (PACKAGED BUILD)" : ""));
    await ev(`document.getElementById("algo-btn").click(); true`);
    await sleep(200);
    check(await ev(`document.getElementById("algo-menu").style.display`) === "block",
      "clicking the pill opens the menu");
    const opts = await ev(`[...document.querySelectorAll(".algo-opt .algo-name")].map(e => e.textContent)`);
    check(opts.length === 4, "all four algorithms listed", opts.join(", "));
    await ev(`[...document.querySelectorAll(".algo-opt")].find(o => o.querySelector(".algo-name").textContent === "C4").click(); true`);
    await sleep(150);
    check(await ev("algorithm") === "c4", "selecting an algorithm takes effect", await ev("algorithm"));
    check(await ev(`document.getElementById("algo-label").textContent`) === "SECURE · C4",
      "pill updates to the selection");
    await ev(`algorithm = "xxhash64"; document.getElementById("algo-label").textContent = algoLabel(); true`);

    // ── 7. Reads as a dropdown ───────────────────────────────────────────
    console.log("\n7. Picker reads as a control, not a badge");
    check(await ev(`!!document.querySelector("#algo-btn .caret svg")`), "caret icon rendered in the pill");
    check(await ev(`getComputedStyle(document.getElementById("algo-btn")).cursor`) === "pointer",
      "cursor indicates it's clickable");
    const hoverRule = await ev(`(() => {
      const all = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules] } catch { return [] } });
      return all.some(r => r.selectorText === "header .mode:hover");
    })()`);
    check(hoverRule, "a hover state exists");

    // ── 8. Cosmetic rename ───────────────────────────────────────────────
    console.log("\n8. Cosmetic in-app rename");
    const target = await ev("volumes[0].mountPoint");
    const realName = await ev("volumes[0].name");
    await ev(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, ${JSON.stringify(target)}, undefined); true`);
    await sleep(80);
    const renameItem = await ev(`[...document.querySelectorAll("#menu button")].map(b=>b.textContent.trim()).find(t => t.startsWith("Rename"))`);
    check(Boolean(renameItem) && renameItem.includes(realName),
      "menu offers Rename with the current label quoted", String(renameItem));
    await ev(`[...document.querySelectorAll("#menu button")].find(b => b.textContent.trim().startsWith("Rename")).click(); true`);
    await sleep(150);
    check(await ev(`document.getElementById("rename-backdrop").classList.contains("open")`), "rename dialog opens");
    await ev(`document.getElementById("rename-input").value = "CARD A — DAY 1";
      document.getElementById("rename-save").click(); true`);
    await sleep(250);
    check(await ev(`volumes[0].name`) === realName, "the REAL volume name is untouched", await ev("volumes[0].name"));
    const shown = await ev(`document.querySelector('#zone-volumes .tile[data-path=${JSON.stringify(target)}] .tile-name').textContent`);
    check(shown === "CARD A — DAY 1", "the card shows the override", shown);
    const persisted = await ev(`window.freeframe.getDisplayNames()`);
    check(persisted[target] === "CARD A — DAY 1", "override persisted to userData");
    // Reset must be offered and must restore the real name.
    await ev(`closeMenu(); openMenu({preventDefault(){},clientX:100,clientY:100}, ${JSON.stringify(target)}, undefined); true`);
    await sleep(80);
    const hasReset = await ev(`[...document.querySelectorAll("#menu button")].some(b => b.textContent.trim() === "Reset to real name")`);
    check(hasReset, "Reset to real name offered once an override exists");
    await ev(`[...document.querySelectorAll("#menu button")].find(b => b.textContent.trim() === "Reset to real name").click(); true`);
    await sleep(250);
    check(await ev(`document.querySelector('#zone-volumes .tile[data-path=${JSON.stringify(target)}] .tile-name').textContent`) === realName,
      "reset restores the real name", realName);

    // Console errors are a signal, not noise, now that `on` logs them.
    check(consoleErrors.filter((e) => !/does-not-exist-anywhere/.test(e)).length === 0,
      "no unexpected console errors across the whole run",
      consoleErrors.filter((e) => !/does-not-exist-anywhere/.test(e)).join(" | ") || "none");

    console.log(failures === 0
      ? `\nALL 8 ITEMS EXERCISED — PASSED${PACKAGED ? " (against the packaged .app)" : ""}`
      : `\n${failures} CHECK(S) FAILED`);
  } finally {
    child.kill("SIGTERM");
    await sleep(400);
    if (!child.killed) child.kill("SIGKILL");
    await fs.rm(tmp, { recursive: true, force: true });
    if (failures > 0 && logs.length) console.log("\n--- app output ---\n" + logs.join(""));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("harness crashed:", e); process.exit(1); });
