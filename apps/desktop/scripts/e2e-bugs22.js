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
    check(layout.sourceBadge, "the source tile still carries its Source badge");
    check(layout.destBadge, "the destination tile still carries its Dest badge");

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

    // ── §22e — click the name to rename ──────────────────────────────────
    console.log("\n3. (22e) Clicking a name opens the label-only rename");
    const rename = await ev(`(() => {
      const target = volumes[0].mountPoint;
      const tile = document.querySelector('#zone-volumes .tile[data-path=' + JSON.stringify(target) + ']');
      const name = tile.querySelector(".tile-name");
      name.click();
      const open = document.getElementById("rename-backdrop").classList.contains("open");
      const sub = document.getElementById("rename-sub").textContent;
      closeRename();
      return { open, sub, cursor: getComputedStyle(name).cursor };
    })()`);
    check(rename.open, "one click on the name opens the dialog");
    check(/keeps its real name on disk/.test(rename.sub),
      "and it is explicitly the cosmetic, app-only rename", rename.sub);
    check(rename.cursor === "text", "the name looks editable on hover", rename.cursor);

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

      // The menu must open, and Rename must be usable.
      closeMenu();
      openMenu({ preventDefault(){}, clientX: 50, clientY: 50 }, busyVol, undefined);
      out.menuShown = document.getElementById("menu").style.display === "block";
      out.renameOffered = [...document.querySelectorAll("#menu button")].some(b => /Rename/.test(b.textContent));
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
    check(busy.renameOffered, "and Rename is reachable — the actual reported symptom");
    check(busy.busyDragRefused, "the card the job is using still can't be dragged away");
    if (busy.idleVol) check(busy.idleAssignable === true, "an unrelated volume is still assignable");
    check(busy.startDisabled === false, "Start is not disabled by an unrelated running job");
    check(busy.refreshDisabled === false, "neither is Refresh");
    check(busy.duplicateRefused === true, "but re-submitting the identical job is refused");

    // ── §22c — token chips ───────────────────────────────────────────────
    console.log("\n5. (22c) A token chip lands in the field the cursor is in");
    await ev(`(() => { editingPreset = { id: null, name: "t", folderTemplate: "{date}",
      fileTemplate: "CLIP", fields: [], filters: null }; renderPresetPane(); return true; })()`);
    const chips = await ev(`(() => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const folder = inputs.find(i => i.dataset.tpl === "folderTemplate");
      const file = inputs.find(i => i.dataset.tpl === "fileTemplate");
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
      out.draftFile = editingPreset.fileTemplate;
      out.draftFolder = editingPreset.folderTemplate;
      out.caret = file.selectionStart;
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
    check(chips.draftFile === chips.fileAfter, "the draft preset was updated too");
    check(chips.caret === "CL{counter}".length, "the caret sits after the inserted token", `${chips.caret}`);

    // ── §22d — the Fields row fits ───────────────────────────────────────
    console.log("\n6. (22d) Field rows stay inside the modal");
    const overflow = await ev(`(() => {
      // The modal must actually be OPEN, or every rect is 0 wide and the
      // overflow assertions below pass without measuring anything.
      document.getElementById("preset-backdrop").classList.add("open");
      editingPreset = { id: null, name: "t", folderTemplate: "", fileTemplate: "", filters: null,
        fields: [{ key: "operator", label: "Operator name that is long", type: "select", required: true }] };
      renderPresetPane();
      const pane = document.getElementById("preset-pane");
      const row = document.querySelector(".field-row");
      const modal = document.querySelector(".preset-modal");
      return {
        rowRight: Math.round(row.getBoundingClientRect().right),
        paneRight: Math.round(pane.getBoundingClientRect().right),
        modalRight: Math.round(modal.getBoundingClientRect().right),
        paneScroll: pane.scrollWidth - pane.clientWidth,
        grouped: !!row.querySelector(".field-row-controls"),
        paneWidth: Math.round(pane.getBoundingClientRect().width),
      };
    })()`);
    await ev(`document.getElementById("preset-backdrop").classList.remove("open"); true`);
    check(overflow.paneWidth > 100,
      "the modal is really open, so these rects mean something", `pane ${overflow.paneWidth}px`);
    check(overflow.rowRight <= overflow.paneRight + 1,
      "the row ends inside its pane", `row ${overflow.rowRight} vs pane ${overflow.paneRight}`);
    check(overflow.rowRight <= overflow.modalRight + 1,
      "and inside the modal", `row ${overflow.rowRight} vs modal ${overflow.modalRight}`);
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

    const perSource = await ev(`(async () => {
      clearAll();
      sourceCounters.clear();
      await window.freeframe.setSourceCounter(1);
      const a = volumes[0].mountPoint;
      const b = (volumes[1] || {}).mountPoint || "/tmp";
      setSource(a); await new Promise(r => setTimeout(r, 60));
      const first = sourceCounter;
      setSource(b); await new Promise(r => setTimeout(r, 60));
      const second = sourceCounter;
      // Going back to a card assigned earlier must reuse its number.
      setSource(a); await new Promise(r => setTimeout(r, 60));
      const back = sourceCounter;
      clearAll();
      return { first, second, back };
    })()`);
    check(perSource.first === 1 && perSource.second === 2,
      "a second card gets the next number", `${perSource.first} then ${perSource.second}`);
    check(perSource.back === 1,
      "re-selecting the first card reuses its number rather than burning a new one", `${perSource.back}`);

    // ── §24a/§24b — project folder roles, and dragging after picking one ──
    console.log("\n8. (24a/24b) A project's two folder roles are independent")
    const proj = await ev(`(() => {
      clearAll();
      ffProjects = [{ id: "p-24", name: "Roles Project", asset_count: 2,
        poster_url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" }];
      render();
      const pick = (role, id, name) => {
        showFolderPicker("p-24", [{ id, name, children: [] }], role);
        [...document.querySelectorAll("#ffdir-tree .ffdir-row")]
          .find(r => r.dataset.folderId === id).click();
        document.getElementById("ffdir-save").click();
      };
      pick("source", "f-src", "Dailies");
      pick("destination", "f-dst", "Deliverables");
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
    check((proj.labels || []).length === 2, "the tile names both", JSON.stringify(proj.labels))

    const cleared = await ev(`(() => {
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
