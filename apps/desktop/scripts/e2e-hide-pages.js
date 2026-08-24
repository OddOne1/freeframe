#!/usr/bin/env node
// Hiding drives/projects (CLAUDE.md §60a) and the page switcher for the
// embedded FreeFrame web view (§60b), in the real app.
//
// The unit tests cover the settings normalisation and the view's layout
// and token contract. What only the running app can show is the wiring:
//   * hiding filters the Volumes column and NOTHING else — an assigned
//     Source/Destination tile must survive its drive being hidden, which
//     is the one requirement a naive "filter everywhere" would break while
//     still looking correct in Settings
//   * hiding is not a one-way door: the Hidden list can bring it back,
//     including a drive that is no longer plugged in
//   * switching pages hides the Offload UI and asks main for the view
//
// Run: node scripts/e2e-hide-pages.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9381;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

async function launch() {
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
  return { child, ws, ev };
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  const userData = path.join(
    process.env.HOME, "Library", "Application Support",
    require(path.join(APP, "package.json")).build?.productName || "FreeFrame Desktop (name TBD)",
  );
  await fsp.rm(path.join(userData, "settings.json"), { force: true });

  const { child, ws, ev } = await launch();

  // Two fake drives, so the test does not depend on what is plugged in.
  // Driven through the same state the real volume list populates.
  await ev(`
    (() => {
      volumes = [
        { name: "CardA", mountPoint: "/Volumes/CardA", type: "external", totalBytes: 1e10, freeBytes: 5e9 },
        { name: "CardB", mountPoint: "/Volumes/CardB", type: "external", totalBytes: 1e10, freeBytes: 5e9 },
      ];
      ffProjects = [{ id: "proj-1", name: "Shoot One" }];
      hiddenVolumeNames = []; hiddenProjectIds = [];
      render();
      return true;
    })()
  `);

  const tiles = () => ev(`[...document.querySelectorAll("#zone-volumes .tile-name")].map(n => n.textContent.trim())`);

  console.log("1. Nothing is hidden to begin with");
  let names = await tiles();
  check(names.includes("CardA") && names.includes("CardB") && names.includes("Shoot One"),
    "both drives and the project are in the Volumes column", names.join(", "));

  console.log("2. Hiding a drive");
  await ev(`
    (() => {
      hiddenVolumeNames = ["CardA"];
      render();
      return true;
    })()
  `);
  names = await tiles();
  check(!names.includes("CardA"), "the hidden drive leaves the Volumes column");
  check(names.includes("CardB"), "and the one beside it stays", names.join(", "));

  console.log("3. An assigned tile survives its drive being hidden (spec item 4)");
  // The requirement in full: hiding declutters the browse view, it does
  // not dismantle a configured job. A filter applied in allEntries() —
  // or anywhere upstream of volumesColumnEntries() — would pass every
  // check above and silently fail this one.
  await ev(`
    (() => {
      hiddenVolumeNames = [];
      render();
      setSource("/Volumes/CardA");
      addDest("/Volumes/CardB", null);
      hiddenVolumeNames = ["CardA", "CardB"];
      render();
      return true;
    })()
  `);
  const src = await ev(`[...document.querySelectorAll("#zone-source .tile-name")].map(n => n.textContent.trim())`);
  const dst = await ev(`[...document.querySelectorAll("#zone-dest .tile-name")].map(n => n.textContent.trim())`);
  check(src.includes("CardA"), "the assigned Source tile is still there", src.join(", ") || "(empty)");
  check(dst.includes("CardB"), "so is the assigned Destination tile", dst.join(", ") || "(empty)");
  check(!(await tiles()).includes("CardA"), "while the middle column still hides it");
  // Presence of a tile is not enough: entryFor() falls back to a name
  // derived from the path when it cannot resolve an entry, so a filter
  // applied one level too far up still renders a tile with the right
  // LABEL while silently losing the drive's type, free space and poster.
  // Assert the assigned tiles resolve to the real drives.
  const srcType = await ev(`entryFor("/Volumes/CardA").type`);
  const dstFree = await ev(`entryFor("/Volumes/CardB").freeBytes`);
  check(srcType === "external",
    "and it resolves to the real drive, not a degraded path-derived stand-in", String(srcType));
  check(dstFree === 5e9, "with its capacity intact", String(dstFree));

  console.log("4. Hiding a project uses its id, not its name");
  await ev(`
    (() => {
      clearAll(); hiddenVolumeNames = []; hiddenProjectIds = ["proj-1"]; render(); return true;
    })()
  `);
  check(!(await tiles()).includes("Shoot One"), "the project leaves the column");
  check(await ev(`isHiddenEntry({ kind: "freeframe", projectId: "proj-1", name: "Renamed" })`),
    "still hidden after a rename — a project has a real stable id to key on");

  console.log("5. Settings lists both, and hiding is reversible");
  await ev(`hiddenProjectIds = []; hiddenVolumeNames = ["CardA"]; render(); true`);
  await ev(`document.getElementById("settings-btn").click(); true`);
  await sleep(500);

  const visibleRows = await ev(`[...document.querySelectorAll("#settings-visible .hide-row .hide-name")].map(n => n.textContent.trim())`);
  check(visibleRows.includes("CardA"),
    "a hidden drive is STILL listed in Settings — otherwise toggling it would make its own undo vanish",
    visibleRows.join(", "));
  const hiddenRows = await ev(`[...document.querySelectorAll("#settings-hidden .hide-row .hide-name")].map(n => n.textContent.trim())`);
  check(hiddenRows.includes("CardA"), "and it appears in the Hidden items list", hiddenRows.join(", "));

  // An unplugged hidden drive: the whole point of listing orphans.
  await ev(`document.getElementById("settings-close").click(); true`);
  await sleep(300);
  await ev(`hiddenVolumeNames = ["CardA", "GoneForever"]; true`);
  await ev(`document.getElementById("settings-btn").click(); true`);
  await sleep(500);
  const orphans = await ev(`[...document.querySelectorAll("#settings-hidden .hide-row .hide-name")].map(n => n.textContent.trim())`);
  check(orphans.includes("GoneForever"),
    "a hidden drive that is no longer connected is listed too, so it can still be un-hidden",
    orphans.join(", "));

  await ev(`
    (() => {
      const rows = [...document.querySelectorAll("#settings-hidden .hide-row")];
      const row = rows.find(r => r.querySelector(".hide-name").textContent.trim() === "CardA");
      const box = row.querySelector("input[type=checkbox]");
      box.checked = true;
      box.dispatchEvent(new Event("change"));
      return true;
    })()
  `);
  await sleep(400);
  check(!(await ev(`hiddenVolumeNames.includes("CardA")`)), "un-hiding from that list works");
  check((await tiles()).includes("CardA"), "and the drive comes back to the Volumes column");

  console.log("6. It persists");
  const stored = await ev(`window.freeframe.getSettings().then(s => JSON.stringify(s.hiddenVolumeNames))`);
  check(JSON.parse(stored).includes("GoneForever"),
    "the hidden list is written to settings.json, not just held in memory", stored);

  await ev(`document.getElementById("settings-close").click(); true`);
  await sleep(300);

  console.log("7. Page switcher (§60b)");
  check(await ev(`!!document.getElementById("page-offload") && !!document.getElementById("page-freeframe")`),
    "both pages have a tab");
  check(await ev(`document.getElementById("page-offload").classList.contains("active")`),
    "Offload is the page the app starts on");
  check(await ev(`getComputedStyle(document.querySelector(".workspace")).display !== "none"`),
    "and its columns are showing");

  // The switcher must sit in the header, because the header is the strip
  // the embedded view is told not to cover. Anywhere else and the way
  // back would be underneath a native view with no z-index to argue with.
  check(await ev(`!!document.querySelector("header #pages")`),
    "the switcher lives in the header, the one strip the embedded view does not cover");

  await ev(`document.getElementById("page-freeframe").click(); true`);
  await sleep(900);
  check(await ev(`document.body.classList.contains("page-web")`), "switching marks the body");

  check(await ev(`getComputedStyle(document.querySelector(".workspace")).display === "none"`),
    "the Offload UI is hidden rather than left laying out underneath a native view");
  check(await ev(`getComputedStyle(document.querySelector("header")).display !== "none"`),
    "but the header stays, so there is a way back");
  check(await ev(`document.getElementById("page-freeframe").classList.contains("active")
    && document.getElementById("page-freeframe").getAttribute("aria-selected") === "true"`),
    "and the tab reads as selected");

  // The renderer checks above only prove the renderer's half. This is the
  // half that matters: a real native view exists, and it is pointed at the
  // web app derived from the API base URL — not at a second hardcoded one.
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const embedded = targets.find((t) => t.type === "page" && !t.url.includes("index.html"));
  check(Boolean(embedded), "a real embedded view was created by the main process",
    targets.map((t) => t.url).join(" | "));
  check(Boolean(embedded) && embedded.url.startsWith("https://frame.yon.studio"),
    "pointed at the web app derived from the API base URL", embedded?.url || "(none)");

  // The SSO half, proved inside the embedded page rather than inferred.
  // Asserted as an INVARIANT against the desktop's own login state, so it
  // says something real whether or not this machine happens to have a
  // stored session: tokens present exactly when the desktop is logged in.
  if (embedded?.webSocketDebuggerUrl) {
    const desktopLoggedIn = await ev(`ffStatus.loggedIn === true`);
    const w2 = new WebSocket(embedded.webSocketDebuggerUrl);
    await new Promise((r) => w2.addEventListener("open", r));
    let i2 = 0; const p2 = new Map();
    w2.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && p2.has(m.id)) { const q = p2.get(m.id); p2.delete(m.id); q(m.result); }
    });
    const ev2 = (expr) => new Promise((res) => {
      const i = ++i2; p2.set(i, res);
      w2.send(JSON.stringify({ id: i, method: "Runtime.evaluate",
        params: { expression: expr, returnByValue: true } }));
    });
    // The embedded view uses the default session, so its localStorage
    // SURVIVES app restarts. Reading it as-is would pass on tokens an
    // earlier run left on disk, proving nothing about injection. Wipe both
    // stores and reload: the preload's marker lives in sessionStorage, so
    // clearing it is what lets injection run again.
    // Cookies survive localStorage.clear(), so they are expired explicitly
    // too — otherwise the cookie assertion below passes on a stale cookie
    // an earlier run set, and would keep passing with injection removed.
    await ev2(`
      localStorage.clear(); sessionStorage.clear();
      for (const k of ["ff_access_token", "ff_refresh_token"]) {
        document.cookie = k + "=; path=/; max-age=0";
      }
      location.reload(); true
    `);
    await sleep(3500);

    // Geometry, measured rather than inferred. showWebView(0) — a view
    // covering the header, i.e. no way back to the Offload page — passes
    // every DOM check above, because the DOM is not what moves.
    const headerH = await ev(`Math.round(document.querySelector("header").getBoundingClientRect().height)`);
    const contentH = await ev(`window.innerHeight`);
    const viewH = await ev2(`window.innerHeight`);
    const gotH = viewH?.result?.value;
    check(headerH > 0 && Math.abs(gotH - (contentH - headerH)) <= 2,
      "the embedded view starts below the app header rather than covering it — otherwise the page switcher is buried",
      `view ${gotH}, window ${contentH}, header ${headerH}`);

    const injected = await ev2(`JSON.stringify({
      access: !!localStorage.getItem("ff_access_token"),
      refresh: !!localStorage.getItem("ff_refresh_token"),
      cookie: /ff_access_token=/.test(document.cookie),
    })`);
    const got = JSON.parse(injected?.result?.value || "{}");
    check(Boolean(got.access) === desktopLoggedIn && Boolean(got.refresh) === desktopLoggedIn,
      `the embedded page holds the desktop's tokens exactly when the desktop is logged in (logged in: ${desktopLoggedIn})`,
      JSON.stringify(got));
    check(Boolean(got.cookie) === desktopLoggedIn,
      "and the matching cookie, so the Next middleware authenticates the first request too");
    try { w2.close(); } catch {}
  } else {
    check(false, "could not attach to the embedded view to verify token injection");
  }

  await ev(`document.getElementById("page-offload").click(); true`);
  await sleep(600);
  check(!(await ev(`document.body.classList.contains("page-web")`)), "switching back restores Offload");
  check(await ev(`getComputedStyle(document.querySelector(".workspace")).display !== "none"`),
    "and its columns return");

  await ev(`document.getElementById("page-freeframe").click(); true`);
  await sleep(700);
  const again = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const same = again.find((t) => t.type === "page" && !t.url.includes("index.html"));
  check(Boolean(same) && embedded && same.id === embedded.id,
    "and switching away and back reuses the SAME view rather than reloading it — "
    + "an in-flight upload on that page must survive a look at the Offload columns");
  await ev(`document.getElementById("page-offload").click(); true`);
  await sleep(400);

  console.log("8. The renderer never gets a handle on the view");
  const keys = await ev(`Object.keys(window.freeframe).filter(k => /webview|WebView/i.test(k)).sort().join(",")`);
  check(keys === "hideWebView,setWebViewInset,showWebView",
    "only show/hide/inset cross the bridge — the view itself stays in main", keys);

  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(600);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
