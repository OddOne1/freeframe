#!/usr/bin/env node
// The six bugs from hands-on testing (CLAUDE.md §22a-f, §22h), each
// exercised the way it was reported rather than checked for compilation.
//
// Two of these are only observable in the real app: whether a running job
// still freezes cards it isn't touching (§22b), and whether a token chip
// lands in the field the cursor is in (§22c). Both were invisible to every
// existing harness, which is how they survived to be found by hand.
//
// Run: node scripts/e2e-bugs22.js
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9352;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fail = 0;
const check = (ok, label, detail = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
};

(async () => {
  try { execSync(`pkill -f 'remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(900);

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
  if (!page) { console.error("Electron never came up"); child.kill("SIGKILL"); process.exit(1); }

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
  const pageErrors = [];
  await send("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Runtime.exceptionThrown") {
      pageErrors.push(m.params.exceptionDetails?.exception?.description || "unknown");
    }
  });
  await sleep(1800);

  try {
    console.log("0. Load");
    check(pageErrors.length === 0, "no uncaught exception", pageErrors.join(" | "));
    const volCount = await ev("volumes.length");
    check(volCount >= 1, "volumes listed", `${volCount}`);

    // ── §22f — one renderer, no toggle ───────────────────────────────────
    console.log("\n1. (22f) Sources and Destinations are tiles, and the toggle is gone");
    const layout = await ev(`(() => {
      clearAll();
      setSource(volumes[0].mountPoint);
      const other = volumes[1] || volumes[0];
      addDest(other.mountPoint === volumes[0].mountPoint ? "/tmp" : other.mountPoint, null);
      render();
      return {
        toggle: !!document.getElementById("view-toggle"),
        anyListCard: document.querySelectorAll(".card").length,
        sourceTiles: document.querySelectorAll("#zone-source .tile").length,
        destTiles: document.querySelectorAll("#zone-dest .tile").length,
        volumeTiles: document.querySelectorAll("#zone-volumes .tile").length,
        sourceBadge: !!document.querySelector("#zone-source .tile-role.src"),
        destBadge: !!document.querySelector("#zone-dest .tile-role.dst"),
      };
    })()`);
    check(layout.toggle === false, "the view toggle is gone from the DOM");
    check(layout.anyListCard === 0, "no list-view cards remain anywhere", `${layout.anyListCard}`);
    check(layout.sourceTiles === 1, "the Sources column renders a tile", `${layout.sourceTiles}`);
    check(layout.destTiles >= 1, "so does Destinations", `${layout.destTiles}`);
    check(layout.volumeTiles >= 1, "and Volumes", `${layout.volumeTiles}`);
    // §59 removed the badges everywhere: the Volumes column has the
    // coloured outline, and in the Source/Dest columns the column itself is
    // the label. Inverted rather than deleted — §22f's point was that these
    // columns render TILES, which the two checks above still cover.
    check(!layout.sourceBadge, "and no longer a redundant Source badge (§59)");
    check(!layout.destBadge, "nor a Dest badge");

    // A destination tile has to keep what only the list view used to show.
    const destDetail = await ev(`(() => {
      const n = destNodes[0];
      nodeStatus = new Map([[n.id, { status: "copying", percent: 42 }]]);
      render();
      const tile = document.querySelector("#zone-dest .tile");
      return {
        status: !!tile.querySelector(".tile-status .status-text"),
        text: (tile.querySelector(".tile-status .status-text") || {}).textContent,
        bar: (tile.querySelector(".node-bar > div") || {}).style?.width,
      };
    })()`);
    check(destDetail.status && destDetail.text === "Copying",
      "a destination tile shows its status", destDetail.text);
    check(destDetail.bar === "42%", "…and its progress bar", destDetail.bar);
    await ev(`nodeStatus = new Map(); render(); true`);

    // ── §22a — drives vs projects ────────────────────────────────────────
    console.log("\n2. (22a) Volumes separates drives from FreeFrame projects");
    const split = await ev(`(() => {
      // Forced, not assumed: this machine may already be signed in with
      // real projects, and reading the "before" state without clearing
      // them tests nothing.
      ffProjects = []; render();
      const before = [...document.querySelectorAll("#zone-volumes .zone-group")].map(g => g.textContent);
      ffProjects = [{ id: "p1", name: "Just Ride", asset_count: 3 }];
      render();
      const after = [...document.querySelectorAll("#zone-volumes .zone-group")].map(g => g.textContent);
      const grids = document.querySelectorAll("#zone-volumes .grid-view").length;
      const projectTile = !!document.querySelector('#zone-volumes .tile[data-path="freeframe://p1"]');
      ffProjects = []; render();
      return { before, after, grids, projectTile };
    })()`);
    check(split.before.length === 0, "no headings when there is only one kind", split.before.join("/"));
    check(split.after.join("|") === "Drives|FreeFrame Projects",
      "both sections labelled once a project exists", split.after.join(" | "));
    check(split.grids === 2, "each section gets its own grid", `${split.grids}`);
    check(split.projectTile, "the project keeps its own tile treatment");

    // ── §65b — §22e's click-to-rename is REMOVED ─────────────────────────
    // Inverted rather than deleted, so the coverage survives the removal:
    // the name must no longer read or behave as a control anywhere.
    console.log("\n3. (65b) The tile name is not a rename control any more");
    const rename = await ev(`(() => {
      const target = volumes[0].mountPoint;
      const tile = document.querySelector('#zone-volumes .tile[data-path=' + JSON.stringify(target) + ']');
      const name = tile.querySelector(".tile-name");
      name.click();
      return {
        backdrop: !!document.getElementById("rename-backdrop"),
        cursor: getComputedStyle(name).cursor,
        renamable: name.classList.contains("renamable"),
        title: name.title,
        openRename: typeof openRename,
      };
    })()`);
    check(rename.backdrop === false, "the rename modal is gone from the DOM, not merely unopened");
    check(rename.openRename === "undefined", "and so is the function that opened it", rename.openRename);
    check(rename.cursor !== "text" && !rename.renamable,
      "the name no longer looks editable on hover", `${rename.cursor} / renamable=${rename.renamable}`);
    check(!/rename/i.test(rename.title || ""), "and its tooltip no longer offers one", rename.title);

    // Setting a label is gone; CLEARING one is not, and the store is still
    // READ. A label stored before the removal would otherwise be permanent
    // with nothing left able to clear it.
    const override = await ev(`(async () => {
      const target = volumes[0].mountPoint;
      const real = volumes[0].name;
      displayNames = await window.freeframe.setDisplayName(target, "CARD A — DAY 1");
      render();
      const tile = document.querySelector('#zone-volumes .tile[data-path=' + JSON.stringify(target) + ']');
      const shown = tile ? tile.querySelector(".tile-name").textContent : null;

      closeMenu();
      openMenu({ preventDefault(){}, clientX: 60, clientY: 60 }, target, undefined);
      const items = [...document.querySelectorAll("#menu button")].map(b => b.textContent.trim());
      const reset = [...document.querySelectorAll("#menu button")]
        .find(b => b.textContent.trim() === "Reset to real name");
      const hasReset = Boolean(reset);
      if (reset) reset.click();
      closeMenu();
      await new Promise(r => setTimeout(r, 300));
      const after = document.querySelector('#zone-volumes .tile[data-path=' + JSON.stringify(target) + ']');
      return {
        shown, hasReset, real,
        restored: after ? after.querySelector(".tile-name").textContent : null,
        offersRename: items.some(t => /Rename/.test(t)),
        realUntouched: volumes[0].name === real,
      };
    })()`);
    check(override.shown === "CARD A — DAY 1",
      "a stored override is still shown on the tile — the store is read, only the writer went",
      String(override.shown));
    check(override.realUntouched, "and the real volume name was never touched", String(override.real));
    check(override.offersRename === false, "the menu offers no Rename");
    check(override.hasReset, "but it does still offer Reset to real name");
    check(override.restored === override.real,
      "and Reset clears the override, so it cannot become permanent", String(override.restored));

    // ── §22b — a running job pins only its own cards ─────────────────────
    console.log("\n4. (22b) A running job no longer freezes the whole UI");
    const busy = await ev(`(() => {
      clearAll();
      const busyVol = volumes[0].mountPoint;
      const idleVol = (volumes[1] || {}).mountPoint || null;
      setSource(busyVol);
      render();
      // Exactly what main broadcasts while a job runs.
      jobSnapshot = [{ id: "j1", status: "running", sourcePath: busyVol, destPaths: ["/tmp/x"] }];
      const out = { busyVol, idleVol };

      // The menu must open, and must still offer real actions. §22b's
      // reported symptom was Rename becoming unreachable during a job;
      // §65b removed Rename entirely, so the thing to assert is that the
      // menu is populated at all rather than opening empty.
      closeMenu();
      openMenu({ preventDefault(){}, clientX: 50, clientY: 50 }, busyVol, undefined);
      out.menuShown = document.getElementById("menu").style.display === "block";
      out.menuItems = [...document.querySelectorAll("#menu button")].map(b => b.textContent.trim());
      out.renameOffered = out.menuItems.some(t => /Rename/.test(t));
      closeMenu();

      // The busy source is pinned…
      out.busyDragRefused = beginDrag({ button: 0, clientX: 0, clientY: 0, preventDefault(){} }, busyVol, "source") === undefined
        && drag === null;

      // …while an unrelated volume stays fully assignable.
      if (idleVol) { addDest(idleVol, null); out.idleAssignable = destNodes.some(n => n.path === idleVol); }

      // Start must not be disabled just because something is running.
      render();
      out.startDisabled = document.getElementById("start").disabled;
      out.refreshDisabled = document.getElementById("refresh").disabled;

      // …but the same job submitted twice is refused.
      jobSnapshot = [{ id: "j2", status: "running", sourcePath, destPaths: destNodes.map(n => n.path) }];
      render();
      out.duplicateRefused = document.getElementById("start").disabled;

      jobSnapshot = []; clearAll(); render();
      return out;
    })()`);
    check(busy.menuShown, "the context menu opens during a job");
    check(busy.menuItems.length > 0,
      "and it is populated, not opened empty — §22b's symptom was the menu going useless mid-job",
      (busy.menuItems || []).join(" | "));
    check(!busy.renameOffered, "Rename is no longer among them (\u00a765b)");
    check(busy.busyDragRefused, "the card the job is using still can't be dragged away");
    if (busy.idleVol) check(busy.idleAssignable === true, "an unrelated volume is still assignable");
    check(busy.startDisabled === false, "Start is not disabled by an unrelated running job");
    check(busy.refreshDisabled === false, "neither is Refresh");
    check(busy.duplicateRefused === true, "but re-submitting the identical job is refused");

    // §61/§62 — the preset editor lives in the Settings window now, and its
    // draft is private to the module. These two sections drive it through
    // the real UI instead of poking at a variable that no longer exists —
    // which is the better test anyway, since the chips ARE a UI behaviour.
    async function attachSettings(tries = 40) {
      for (let i = 0; i < tries; i++) {
        try {
          const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
          const pg = t.find((x) => x.type === "page" && x.url.includes("settings.html"));
          if (pg?.webSocketDebuggerUrl) {
            const w = new WebSocket(pg.webSocketDebuggerUrl);
            await new Promise((r) => w.addEventListener("open", r));
            let n = 0; const q = new Map();
            w.addEventListener("message", (e) => {
              const m = JSON.parse(e.data);
              if (m.id && q.has(m.id)) { const f = q.get(m.id); q.delete(m.id); f(m.result); }
            });
            const call = (me, pa = {}) => new Promise((res) => {
              const i = ++n; q.set(i, res); w.send(JSON.stringify({ id: i, method: me, params: pa }));
            });
            await call("Runtime.enable");
            return { ws: w, ev: async (x) => (await call("Runtime.evaluate",
              { expression: x, awaitPromise: true, returnByValue: true, timeout: 30000 })).result?.value };
          }
        } catch {}
        await sleep(250);
      }
      return null;
    }

    // ── §22c — token chips ───────────────────────────────────────────────
    console.log("\n5. (22c) A token chip lands in the field the cursor is in");
    await ev(`document.getElementById("settings-btn").click(); true`);
    const st = await attachSettings();
    check(Boolean(st), "the Settings window opened");
    if (!st) { console.log("cannot continue"); process.exit(1); }
    // Wait for the window's own DOM before touching it: attach succeeds as
    // soon as the target exists, which can be before settings.html has
    // loaded — and a throw there is invisible, since this minimal helper
    // does not read exceptionDetails.
    for (let i = 0; i < 40; i++) {
      if (await st.ev(`!!document.querySelector('nav button[data-tab="presets"]')`)) break;
      await sleep(200);
    }
    await st.ev(`document.querySelector('nav button[data-tab="presets"]').click(); true`);
    check(await st.ev(`document.getElementById("tab-presets").classList.contains("active")`),
      "the Naming Presets tab is showing — the rects below are meaningless otherwise");
    for (let i = 0; i < 40 && !(await st.ev(`!!document.getElementById("preset-new")`)); i++) await sleep(200);
    await st.ev(`document.getElementById("preset-new").click(); true`);
    await sleep(400);

    const chips = await st.ev(`(() => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const folder = inputs.find(i => i.dataset.tpl === "folderTemplate");
      const file = inputs.find(i => i.dataset.tpl === "fileTemplate");
      const set = (input, v) => {
        input.value = v;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set(folder, "{date}");
      set(file, "CLIP");
      const rowOf = (input) => input.nextElementSibling.nextElementSibling;
      const chipTexts = (input) => [...rowOf(input).querySelectorAll("code")].map(c => c.textContent);
      const clickChip = (input, text) => {
        const c = [...rowOf(input).querySelectorAll("code")].find(x => x.textContent === text);
        if (!c) return false;
        c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        return true;
      };
      const out = { folderChips: chipTexts(folder), fileChips: chipTexts(file) };

      // Caret in the MIDDLE of the file name, then click {counter}.
      file.focus();
      file.setSelectionRange(2, 2);
      out.clicked = clickChip(file, "{counter}");
      out.fileAfter = file.value;
      out.folderAfter = folder.value;
      out.caret = file.selectionStart;

      // The draft is private now, so it is proved by saving and reading it
      // back rather than by inspecting a variable.
      const name = document.querySelector('#preset-pane input[data-role="preset-name"]');
      name.value = "Chip Test";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      return out;
    })()`);
    check(chips.folderChips.includes("{sourcecounter}"),
      "the folder field offers {sourcecounter}", chips.folderChips.join(" "));
    check(!chips.folderChips.includes("{counter}"),
      "and does NOT offer {counter} — the folder-per-file footgun");
    check(chips.fileChips.includes("{counter}"), "the file field offers {counter}");
    check(!chips.fileChips.includes("{sourcecounter}"), "and not {sourcecounter}");
    check(chips.clicked, "the chip was clickable");
    check(chips.fileAfter === "CL{counter}IP",
      "inserted at the CARET of the focused field, not appended", chips.fileAfter);
    check(chips.folderAfter === "{date}",
      "and the folder pattern was left completely alone", chips.folderAfter);
    check(chips.caret === "CL{counter}".length, "the caret sits after the inserted token", `${chips.caret}`);

    await st.ev(`document.getElementById("preset-save").click(); true`);
    await sleep(800);
    const saved = await ev(`window.freeframe.listPresets().then(s =>
      JSON.stringify((s.presets.find(p => p.name === "Chip Test") || {})))`);
    const savedObj = JSON.parse(saved || "{}");
    check(savedObj.fileTemplate === "CL{counter}IP" && savedObj.folderTemplate === "{date}",
      "and the draft behind the inputs matched — proved by saving and reading it back",
      `${savedObj.folderTemplate} / ${savedObj.fileTemplate}`);

    // ── §22d — the Fields row fits ───────────────────────────────────────
    console.log("\n6. (22d) Field rows stay inside the pane");
    const overflow = await st.ev(`(() => {
      const add = [...document.querySelectorAll("#preset-pane button")]
        .find(b => b.textContent.trim() === "Add field");
      add.click();
      const label = document.querySelector(".field-row input[type=text]");
      label.value = "Operator name that is long";
      label.dispatchEvent(new Event("input", { bubbles: true }));
      const pane = document.getElementById("preset-pane");
      const row = document.querySelector(".field-row");
      return {
        rowRight: Math.round(row.getBoundingClientRect().right),
        paneRight: Math.round(pane.getBoundingClientRect().right),
        paneScroll: pane.scrollWidth - pane.clientWidth,
        grouped: !!row.querySelector(".field-row-controls"),
        paneWidth: Math.round(pane.getBoundingClientRect().width),
      };
    })()`);
    // The pane must really be laid out, or every rect is 0 wide and the
    // assertions below pass without measuring anything.
    check(overflow.paneWidth > 100,
      "the pane is really laid out, so these rects mean something", `pane ${overflow.paneWidth}px`);
    check(overflow.rowRight <= overflow.paneRight + 1,
      "the row ends inside its pane", `row ${overflow.rowRight} vs pane ${overflow.paneRight}`);
    check(overflow.paneScroll <= 0, "nothing overflows horizontally", `${overflow.paneScroll}px`);
    check(overflow.grouped, "the trailing controls travel as one group");

    // ── §22h — the source counter ────────────────────────────────────────
    console.log("\n7. (22h) {sourcecounter} numbers cards, not files");
    const counter = await ev(`(async () => {
      await window.freeframe.setSourceCounter(7);
      const a = await window.freeframe.bumpSourceCounter();
      const b = await window.freeframe.bumpSourceCounter();
      const store = await window.freeframe.listPresets();
      const preview = await window.freeframe.previewNaming("CARD_{sourcecounter}", "", {}, "/Volumes/A001");
      await window.freeframe.setSourceCounter(1);
      return { a, b, stored: store.sourceCounter, preview };
    })()`);
    check(counter.a === 7 && counter.b === 8, "each claim takes the next number", `${counter.a}, ${counter.b}`);
    check(counter.stored === 9, "and the store advances past them", `${counter.stored}`);
    check(counter.preview.ok && /CARD_00\d/.test(counter.preview.result),
      "the token renders in a folder pattern", JSON.stringify(counter.preview));

    // §22h claimed a number the moment a path became the Source, and kept
    // one per card so swapping back reused it. §71 removed BOTH: nothing is
    // claimed until a job that actually renames starts, so there is no
    // per-card number to remember. Inverted rather than deleted — assigning
    // a source consuming a number is the exact bug §71 fixed, and it must
    // not come back. The positive half (a renaming job takes exactly one,
    // and renders it) lives in e2e-field-panel.js section 5.
    const perSource = await ev(`(async () => {
      clearAll();
      await window.freeframe.setSourceCounter(1);
      const a = volumes[0].mountPoint;
      const b = (volumes[1] || {}).mountPoint || "/tmp";
      setSource(a); await new Promise(r => setTimeout(r, 60));
      setSource(b); await new Promise(r => setTimeout(r, 60));
      setSource(a); await new Promise(r => setTimeout(r, 60));
      const stored = (await window.freeframe.listPresets()).sourceCounter;
      clearAll();
      return { stored, perPathMapGone: typeof sourceCounters === "undefined" };
    })()`);
    check(perSource.stored === 1,
      "assigning three sources consumes no numbers at all (\u00a771)", `${perSource.stored}`);
    check(perSource.perPathMapGone,
      "and the per-card map is gone, not merely unused — there is nothing to remember before a job runs");

    // ── §24a/§24b — project folder roles, and dragging after picking one ──
    console.log("\n8. (24a/24b) A project's two folder roles are independent")
    const proj = await ev(`(() => {
      clearAll();
      ffProjects = [{ id: "p-24", name: "Roles Project", asset_count: 2,
        poster_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }];
      render();
      // Configured WITHOUT going through the picker, so no role is taken —
      // the picker now assigns as well as remembers (§24c), which is
      // exactly what the next block checks. This block is about the two
      // slots being independent, and about an unheld role staying silent.
      setProjectFolder("p-24", "source", { id: "f-src", name: "Dailies", path: "/Dailies" });
      setProjectFolder("p-24", "destination", { id: "f-dst", name: "Deliverables", path: "/Deliverables" });
      render();
      return {
        source: projectFolderFor("p-24", "source"),
        destination: projectFolderFor("p-24", "destination"),
        sourceId: uploadFolderIdFor("p-24", "source"),
        destId: uploadFolderIdFor("p-24", "destination"),
        labels: entryFor("freeframe://p-24").folderLabels,
      };
    })()`)
    check(proj.source && proj.source.id === "f-src", "the source role holds its own folder",
      JSON.stringify(proj.source))
    check(proj.destination && proj.destination.id === "f-dst",
      "and the destination role holds a different one", JSON.stringify(proj.destination))
    check(proj.sourceId === "f-src" && proj.destId === "f-dst",
      "each role threads its own id to the API", `${proj.sourceId} / ${proj.destId}`)
    // §24c — configuring a folder is no longer enough to caption the
    // tile with it; the project has to actually hold that role.
    check((proj.labels || []).length === 0,
      "a configured-but-unassigned folder does NOT caption the tile", JSON.stringify(proj.labels))

    // §24c — picking a folder from the role submenu must also take the role.
    const assigned = await ev(`(() => {
      clearAll(); render();
      showFolderPicker("p-24", [{ id: "f-src", name: "Dailies", children: [] }], "source");
      [...document.querySelectorAll("#ffdir-tree .ffdir-row")]
        .find(r => r.dataset.folderId === "f-src").click();
      document.getElementById("ffdir-save").click();
      return { source: sourcePath, labels: entryFor("freeframe://p-24").folderLabels };
    })()`)
    check(assigned.source === "freeframe://p-24",
      "picking a Source folder puts the project in Sources — no extra drag", String(assigned.source))
    check((assigned.labels || []).join("|") === "from /Dailies",
      "and NOW the tile captions it, because the role is held", JSON.stringify(assigned.labels))

    const asDest = await ev(`(() => {
      clearAll(); render();
      showFolderPicker("p-24", [{ id: "f-dst", name: "Deliverables", children: [] }], "destination");
      [...document.querySelectorAll("#ffdir-tree .ffdir-row")]
        .find(r => r.dataset.folderId === "f-dst").click();
      document.getElementById("ffdir-save").click();
      return { dests: destNodes.map(n => n.path), labels: entryFor("freeframe://p-24").folderLabels };
    })()`)
    check(asDest.dests.includes("freeframe://p-24"),
      "picking a Destination folder puts it in Destinations", JSON.stringify(asDest.dests))
    check((asDest.labels || []).join("|") === "to /Deliverables",
      "captioned for the destination role only", JSON.stringify(asDest.labels))

    // The same-project-both-sides guard has to still fire through this
    // path, not just through a drag.
    const conflict = await ev(`(() => {
      clearAll(); render();
      setSource("freeframe://p-24");
      showFolderPicker("p-24", [{ id: "f-dst", name: "Deliverables", children: [] }], "destination");
      [...document.querySelectorAll("#ffdir-tree .ffdir-row")]
        .find(r => r.dataset.folderId === "f-dst").click();
      document.getElementById("ffdir-save").click();
      return { dests: destNodes.map(n => n.path),
               warned: document.getElementById("summary").textContent.includes("Same project on both sides") };
    })()`)
    check(conflict.dests.length === 0,
      "the same project is refused as a destination while it is the source", JSON.stringify(conflict.dests))
    check(conflict.warned, "and the conflict is explained, via the menu path too")

    const cleared = await ev(`(() => {
      clearAll(); render();
      setProjectFolder("p-24", "source", { id: "f-src", name: "Dailies", path: "/Dailies" });
      setProjectFolder("p-24", "destination", { id: "f-dst", name: "Deliverables", path: "/Deliverables" });
      setProjectFolder("p-24", "source", null); render();
      return { source: projectFolderFor("p-24", "source"),
               destination: projectFolderFor("p-24", "destination") };
    })()`)
    check(cleared.source === null, "clearing one role empties it")
    check(cleared.destination && cleared.destination.id === "f-dst",
      "and leaves the other alone — the whole point of §24a", JSON.stringify(cleared.destination))

    // §24b hardening. This asserts the PROPERTY, not the interaction:
    // synthetic mouse events cannot trigger a native image drag, so no
    // harness can exercise the failure itself. What it can pin is that the
    // poster never becomes natively draggable again.
    const posterDrag = await ev(`(() => {
      const img = document.querySelector('#zone-volumes .tile[data-path="freeframe://p-24"] img.tile-poster');
      if (!img) return null;
      return { draggable: img.draggable, userDrag: getComputedStyle(img).webkitUserDrag };
    })()`)
    check(posterDrag && posterDrag.draggable === false,
      "a project poster is not natively draggable (§24b)", JSON.stringify(posterDrag))
    check(posterDrag && posterDrag.userDrag === "none", "…and CSS agrees")

    // The exact sequence from the report: pick a folder, then drag.
    const dragAfterPick = await ev(`(() => {
      clearAll(); render();
      showFolderPicker("p-24", [{ id: "f-src", name: "Dailies", children: [] }], "source");
      [...document.querySelectorAll("#ffdir-tree .ffdir-row")]
        .find(r => r.dataset.folderId === "f-src").click();
      document.getElementById("ffdir-save").click();
      const tile = document.querySelector('#zone-volumes .tile[data-path="freeframe://p-24"]');
      return {
        tileExists: !!tile,
        pickerClosed: !document.getElementById("ffdir-backdrop").classList.contains("open"),
        notBusy: !isBusy("freeframe://p-24"),
      };
    })()`)
    check(dragAfterPick.tileExists, "the tile survives a folder selection")
    check(dragAfterPick.pickerClosed, "the picker closes, leaving no overlay over it")
    check(dragAfterPick.notBusy, "and nothing marks it busy, so beginDrag's only gate is open")
    await ev(`ffProjects = []; clearAll(); render(); true`)

    console.log("\n9. (25a/25b/25c) Window floor, wrapping, and the Naming Fields panel")
    const chrome = await ev(`(() => {
      const head = getComputedStyle(document.querySelector("header"));
      const col = getComputedStyle(document.querySelector(".col-head"));
      return {
        headerWrap: head.flexWrap, headerRowGap: head.rowGap,
        colWrap: col.flexWrap,
        colTitleEllipsis: getComputedStyle(document.querySelector(".col-head h2")).textOverflow,
        colButtonShrink: getComputedStyle(document.querySelector(".col-head button")).flexShrink,
        showLabel: document.getElementById("fields-show").textContent.trim(),
        panelHeading: document.querySelector("#fields-panel h2").textContent.trim(),
      };
    })()`)
    check(chrome.headerWrap === "wrap", "the header wraps instead of clipping (§25b)", chrome.headerWrap)
    check(chrome.headerRowGap !== "0px" && chrome.headerRowGap !== "normal",
      "…with a row gap so a wrapped line isn't flush", chrome.headerRowGap)
    // Deliberately NOT wrap — see the comment on .col-head. A wrapped
    // column header breaks the three-header alignment, so the title
    // ellipsizes and the button holds its width instead.
    check(chrome.colWrap === "nowrap", "column headers do NOT wrap (alignment wins)", chrome.colWrap)
    check(chrome.colTitleEllipsis === "ellipsis",
      "…their titles ellipsize instead, so controls never clip", chrome.colTitleEllipsis)
    check(chrome.colButtonShrink === "0",
      "…and the button is never squeezed", chrome.colButtonShrink)
    check(chrome.showLabel === "Naming Fields", "the reopen button is renamed (§25c)", chrome.showLabel)
    check(chrome.panelHeading === "Naming Fields", "and so is the panel heading", chrome.panelHeading)

    // §25a. A SOURCE-LEVEL pin, and deliberately labelled as one: Electron
    // does not expose CDP's Browser domain, so getWindowBounds/
    // setWindowBounds are unavailable, and a renderer cannot resize its own
    // BrowserWindow. This cannot prove the OS clamps the drag — it only
    // catches the values being lowered again, which is the regression worth
    // catching.
    const mainSrc = require("node:fs").readFileSync(
      require("node:path").join(APP, "src", "main", "main.js"), "utf8");
    const minW = (mainSrc.match(/minWidth:\s*(\d+)/) || [])[1];
    const minH = (mainSrc.match(/minHeight:\s*(\d+)/) || [])[1];
    const launchW = (mainSrc.match(/width:\s*(\d+)/) || [])[1];
    const launchH = (mainSrc.match(/height:\s*(\d+)/) || [])[1];
    check(minW === launchW && minH === launchH,
      "the window floor equals its launch size — not smaller (§25a, source-level)",
      `min ${minW}x${minH} vs launch ${launchW}x${launchH}`);

    const panelVis = await ev(`(async () => {
      const store = await window.freeframe.savePreset({
        name: "Vis Test", folderTemplate: "{date}", fileTemplate: "", fields: [] });
      presetStore = store;
      const p = store.presets.find(x => x.name === "Vis Test");

      activePresetId = null; updatePresetLabel();
      const none = {
        panelHidden: document.getElementById("fields-panel").classList.contains("hidden"),
        buttonShown: document.getElementById("fields-show").classList.contains("on"),
      };

      activePresetId = p.id; updatePresetLabel();
      const withPreset = {
        panelHidden: document.getElementById("fields-panel").classList.contains("hidden"),
      };

      // A manual Hide must still work, and must survive under the gate.
      setFieldsPanel(true);
      const hiddenManually = {
        panelHidden: document.getElementById("fields-panel").classList.contains("hidden"),
        buttonShown: document.getElementById("fields-show").classList.contains("on"),
      };
      setFieldsPanel(false);

      activePresetId = null; updatePresetLabel();
      await window.freeframe.deletePreset(p.id);
      return { none, withPreset, hiddenManually };
    })()`)
    check(panelVis.none.panelHidden === true,
      "with no preset the panel is hidden outright, not showing an empty state")
    check(panelVis.none.buttonShown === false, "and its reopen button is gone too")
    check(panelVis.withPreset.panelHidden === false, "selecting a preset brings it back")
    check(panelVis.hiddenManually.panelHidden === true, "Hide still hides it")
    check(panelVis.hiddenManually.buttonShown === true, "…and then the reopen button is offered")

    check(pageErrors.length === 0, "no uncaught exception across the whole run", pageErrors.join(" | "));
  } finally {
    ws.close();
    child.kill("SIGKILL");
  }

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nHARNESS ERROR", err);
  process.exit(1);
});
