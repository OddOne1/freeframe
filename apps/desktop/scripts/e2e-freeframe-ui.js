#!/usr/bin/env node
// The FreeFrame side of the app, end to end:
//
//   1. Projects render as projects — poster or the project's own gradient,
//      the Clapperboard glyph, a "project" badge — not as the internal-drive
//      laptop icon in a grey box.
//   2. The sign-in screen matches apps/web's, structurally and in its
//      measurements.
//   3. The in-project folder picker, and the folder id it threads into an
//      upload.
//   4. A project (or a folder inside one) used as a *source*.
//
// Runs against a real signed-in session where one exists — the project
// list, folder tree and asset listing are then the real ones from the API.
// Where no session exists it falls back to injected fixtures so the render
// paths are still exercised; each section says which mode it ran in.
//
// Run: node scripts/e2e-freeframe-ui.js
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");
const APP = path.join(__dirname, "..");
const PORT = 9312;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  // A leftover Electron on this port serves the OLD page — this has made a
  // real fix look like a no-op three times now.
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
  let id = 0;
  const pend = new Map();
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
    await fs.writeFile(f, Buffer.from(s.data, "base64"));
  };

  // Uncaught exceptions during load are collected before anything else: the
  // outage this harness family exists for was invisible to tests that
  // injected state and never exercised the app's own start-up.
  const pageErrors = [];
  await send("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || "unknown");
    }
  });
  await sleep(2000);

  console.log("0. Page load");
  check(pageErrors.length === 0, "no uncaught exception during load", pageErrors.join(" | "));

  const live = await ev(`(async()=>{const s=await window.freeframe.freeframeStatus();return !!s.loggedIn})()`);
  console.log(`     mode: ${live ? "LIVE — signed in against the real API" : "FIXTURE — no session, injected data"}\n`);

  // ── 1. Projects look like projects ────────────────────────────────────
  console.log("1. Project tiles");

  // Two fixtures either way, so both branches (poster / no poster) are
  // covered even in live mode where no real project has a poster set.
  await ev(`
    ffProjects = [
      { id: "aaaaaaaa-1111-2222-3333-444444444444", name: "Poster Project",
        asset_count: 12, poster_url: "/stream/hls/p.jpg?token=x" },
      { id: "bbbbbbbb-5555-6666-7777-888888888888", name: "Gradient Project",
        asset_count: 3, poster_url: null },
    ];
    volumesView = "square"; render(); true`);

  const ffTiles = await ev(`document.querySelectorAll('#zone-volumes .tile[data-path^="freeframe://"]').length`);
  check(ffTiles === 2, "both projects render as tiles", `${ffTiles} found`);

  const gradSel = `#zone-volumes .tile[data-path="freeframe://bbbbbbbb-5555-6666-7777-888888888888"]`;
  const gradBg = await ev(`document.querySelector('${gradSel} .tile-media').style.backgroundImage`);
  check(gradBg.includes("linear-gradient"), "posterless project gets a gradient, not an icon box", gradBg.slice(0, 60) + "…");
  check(gradBg.includes("radial-gradient"), "…including the radial highlight apps/web layers on");

  // The whole point of copying apps/web's hash rather than inventing one.
  const webGradient = (projectId) => {
    const presets = [
      "#7c3aed", "#2563eb", "#059669", "#f97316", "#e11d48", "#06b6d4", "#0ea5e9", "#ec4899",
    ];
    const hash = projectId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    return presets[hash % presets.length];
  };
  const expectFrom = webGradient("bbbbbbbb-5555-6666-7777-888888888888");
  const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
  check(gradBg.includes(rgb(expectFrom)), `gradient matches apps/web's own hash for this id (${expectFrom})`, gradBg.slice(0, 80));

  check(
    await ev(`!document.querySelector('${gradSel} .tile-icon')`),
    "no generic icon-in-a-box on a project tile"
  );
  check(
    await ev(`!!document.querySelector('${gradSel} .tile-scrim')`),
    "bottom scrim present so badges stay legible"
  );

  const posterSel = `#zone-volumes .tile[data-path="freeframe://aaaaaaaa-1111-2222-3333-444444444444"]`;
  const posterSrc = await ev(`(document.querySelector('${posterSel} .tile-poster')||{}).src || ""`);
  check(posterSrc.startsWith("http"), "poster_url resolved to an absolute URL against the signed-in server", posterSrc.slice(0, 60));
  check(posterSrc.includes("/stream/hls/p.jpg"), "…preserving the proxy path and its token");
  check(
    await ev(`getComputedStyle(document.querySelector('${posterSel} .tile-poster')).objectFit`) === "cover",
    "poster is object-fit:cover, not letterboxed"
  );

  const badge = await ev(`document.querySelector('${gradSel} .tile-badge').textContent`);
  check(badge === "project", `type badge reads "project", not the raw "freeframe" enum`, badge);

  // The reported bug itself: typeIcon had no freeframe key, so a project
  // fell through the || and rendered as the internal-drive glyph.
  //
  // §22f removed the list view, so the check is no longer "does the list
  // renderer give it a glyph" — there is one renderer, and a project is
  // deliberately the one entry that gets artwork INSTEAD of an icon box.
  // What still has to hold is that it never renders as a drive.
  // Wrapped in an IIFE: this harness's ev() evaluates an expression, so a
  // bare `return` at the top level is a syntax error.
  const projectTreatment = await ev(`(() => {
    render();
    const c = document.querySelector('#zone-volumes .tile[data-path="${gradSel.split('"')[1]}"]');
    if (!c) return "NO CARD";
    return JSON.stringify({
      driveIconBox: !!c.querySelector('.tile-icon'),
      artwork: !!c.querySelector('.tile-poster') ||
        !!(c.querySelector('.tile-media') && c.querySelector('.tile-media').style.backgroundImage),
    });
  })()`);
  check(projectTreatment !== "NO CARD", "the project renders");
  const treatment = projectTreatment === "NO CARD" ? {} : JSON.parse(projectTreatment);
  check(treatment.driveIconBox === false,
    "and NOT as a drive icon box — the original bug", projectTreatment);
  check(treatment.artwork === true, "it gets its poster or gradient instead", projectTreatment);
  check(await ev(`typeIcon('freeframe')`) === "freeframe", "typeIcon resolves 'freeframe' instead of falling back");
  check(await ev(`typeIcon('freeframe')`) !== await ev(`typeIcon('internal')`), "…and no longer collides with the internal-drive icon");

  await ev(`volumesView='square'; render(); true`);
  await shot("/tmp/ff-tiles.png");

  // ── 2. Sign-in screen ─────────────────────────────────────────────────
  console.log("\n2. Sign-in screen");
  await ev(`openLogin(); true`);
  check(await ev(`$("login-backdrop").classList.contains("open")`), "opens");

  const card = await ev(`(() => {
    const c = getComputedStyle(document.querySelector(".login-card"));
    return { r: c.borderRadius, p: c.padding, w: document.querySelector(".login-stack").getBoundingClientRect().width };
  })()`);
  check(card.r === "12px", "card radius 12px (rounded-xl)", card.r);
  check(card.p === "24px", "card padding 24px (p-6)", card.p);
  check(Math.round(card.w) === 384, "stack is max-w-sm = 384px", String(card.w));

  const inputH = await ev(`getComputedStyle(document.querySelector(".login-field input")).height`);
  check(inputH === "40px", "inputs are h-10 = 40px", inputH);
  const btnH = await ev(`getComputedStyle(document.querySelector(".login-submit")).height`);
  check(btnH === "44px", "primary button is size=lg h-11 = 44px", btnH);

  check(await ev(`!!document.querySelector(".login-glow")`), "accent glow behind the card");
  check(
    await ev(`getComputedStyle(document.querySelector(".login-glow")).filter.includes("blur")`),
    "…is actually blurred"
  );
  check(
    (await ev(`document.querySelector(".login-tagline").textContent`)).includes("Collaborative media review"),
    "same tagline as the web login's footer"
  );
  check(
    await ev(`getComputedStyle($("ff-error")).display`) === "none",
    "error box hidden when there's nothing to say (no reserved blank line)"
  );
  await ev(`setLoginError("Invalid email or password"); true`);
  check(await ev(`getComputedStyle($("ff-error")).display`) === "block", "…and shown once there is");
  await ev(`setLoginError(""); true`);

  const logoOk = await ev(`(() => {
    const i = $("ff-logo");
    return i && i.complete && i.naturalWidth > 0;
  })()`);
  check(logoOk, "the real apps/web wordmark loaded (synced by sync-tokens.js)");

  await shot("/tmp/ff-login.png");
  await ev(`closeLogin(); true`);
  check(await ev(`$("ff-pass").value === ""`), "password cleared on close");

  // ── 3. Folder picker ──────────────────────────────────────────────────
  console.log("\n3. In-project folder picker");

  const tree = live
    ? null
    : `[{id:"f1",name:"Dailies",item_count:4,children:[{id:"f1a",name:"Day 01",item_count:2,children:[]}]},
        {id:"f2",name:"Selects",item_count:1,children:[]}]`;

  const projId = live
    ? await ev(`(async()=>{const r=await window.freeframe.freeframeProjects();
        return (r.projects&&r.projects[0])?r.projects[0].id:null})()`)
    : "bbbbbbbb-5555-6666-7777-888888888888";

  if (live && projId) {
    await ev(`(async()=>{const r=await window.freeframe.freeframeProjects();
      ffProjects=r.projects||[]; render(); return true})()`);
  }

  // Live mode goes through the real fetch; fixture mode calls the render
  // half directly. showFolderPicker is split out of openProjectFolders for
  // exactly this reason — no test-only branch inside the production path.
  const opened = await ev(`(async () => {
    ${tree
      ? `showFolderPicker(${JSON.stringify(projId)}, ${tree}, "destination");`
      : `await openProjectFolders(${JSON.stringify(projId)}, "destination");`}
    return $("ffdir-backdrop").classList.contains("open");
  })()`);
  check(opened, "picker opens for a project");

  const rows = await ev(`document.querySelectorAll("#ffdir-tree .ffdir-row").length`);
  check(rows >= 1, "tree rendered with at least the project root", `${rows} rows`);
  const rootRow = await ev(`document.querySelector("#ffdir-tree .ffdir-row").textContent`);
  console.log(`     root row: ${JSON.stringify(rootRow)}`);

  // Selecting a real (non-root) folder is what the whole item is for.
  const picked = await ev(`(() => {
    const rows = [...document.querySelectorAll("#ffdir-tree .ffdir-row")];
    const nonRoot = rows.find(r => r.dataset.folderId && r.dataset.folderId !== "root");
    if (!nonRoot) return null;
    nonRoot.click();
    return { id: nonRoot.dataset.folderId, name: nonRoot.textContent.trim() };
  })()`);

  if (picked) {
    check(true, `selected a non-root folder`, `${picked.name} (${picked.id.slice(0, 8)})`);
    // Captured while the picker is still open — a shot of the closed dialog
    // proves nothing about the thing being tested.
    await shot("/tmp/ff-folders.png");
    await ev(`$("ffdir-save").click(); true`);
    // §24a — recorded per ROLE now, not once per project.
    const stored = await ev(`JSON.stringify(projectFolderFor(${JSON.stringify(projId)}, "destination")||null)`);
    check(stored.includes(picked.id), "chosen folder id recorded against the project's destination role", stored);
    check(
      await ev(`$("ffdir-backdrop").classList.contains("open")`) === false,
      "picker closes on save"
    );
    // The actual point of item 2: this id is what reaches freeframeUpload.
    const threaded = await ev(`uploadFolderIdFor(${JSON.stringify(projId)}, "destination")`);
    check(threaded === picked.id, "uploadFolderIdFor() returns it — this is what goes to freeframeUpload's 3rd arg", String(threaded));
    check(
      (await ev(`(entryFor("freeframe://" + ${JSON.stringify(projId)}).folderLabels || []).length`)) > 0,
      "the tile says which folder it will upload into"
    );
  } else {
    check(false, "no non-root folder available to select", live ? "live project has no folders" : "fixture tree missing");
    await shot("/tmp/ff-folders.png");
  }

  // Root is still reachable, and is still what an untouched project means.
  await ev(`delete projectFolder[${JSON.stringify(projId)}]; render(); true`);
  check(
    (await ev(`uploadFolderIdFor(${JSON.stringify(projId)}, "destination")`)) === null,
    "an untouched project still uploads to the root (null), as before"
  );

  // ── 4. Project as a source ────────────────────────────────────────────
  console.log("\n4. Project as a source");
  const srcPath = `freeframe://${projId}`;
  await ev(`clearAll(); setSource(${JSON.stringify(srcPath)}); render(); true`);
  check(await ev(`sourcePath === ${JSON.stringify(srcPath)}`), "a project can now be set as the source");
  check(
    await ev(`document.querySelectorAll('#zone-source .tile[data-path="${srcPath}"]').length`) === 1,
    "…and appears in the Sources zone"
  );

  // The old guard actively refused this; make sure the refusal is gone from
  // the menu too, not just from setSource.
  const menuDisabled = await ev(`(() => {
    openMenu({preventDefault(){},clientX:10,clientY:10}, ${JSON.stringify(srcPath)}, undefined);
    const b = [...document.querySelectorAll("#menu button")].find(x => x.textContent === "Set as Source");
    const d = b ? b.disabled : "MISSING";
    closeMenu();
    return d;
  })()`);
  check(menuDisabled === true, "\"Set as Source\" disabled only because it IS the source", String(menuDisabled));

  await ev(`clearAll(); render(); true`);
  const menuEnabled = await ev(`(() => {
    openMenu({preventDefault(){},clientX:10,clientY:10}, ${JSON.stringify(srcPath)}, undefined);
    const b = [...document.querySelectorAll("#menu button")].find(x => x.textContent === "Set as Source");
    const d = b ? b.disabled : "MISSING";
    closeMenu();
    return d;
  })()`);
  check(menuEnabled === false, "…and enabled otherwise (it was hard-disabled for projects before)", String(menuEnabled));

  await shot("/tmp/ff-source.png");

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  console.log("Screenshots: /tmp/ff-tiles.png /tmp/ff-login.png /tmp/ff-folders.png /tmp/ff-source.png");
  child.kill("SIGKILL");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
