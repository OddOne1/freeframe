#!/usr/bin/env node
// Settings screen + live speed/ETA (CLAUDE.md §58), in the real app.
//
// The unit test covers the rate arithmetic and the settings normalisation.
// What only the running app can show is the wiring:
//   * the modal opens, and is a modal (the shared .ff-backdrop class carries
//     no styles — a backdrop relying on it alone sits invisible or
//     permanently on top, which is §23d's own scar)
//   * choosing a default persists it AND pre-selects the per-job picker on
//     the next launch, without removing the per-job override
//   * a progress tick carrying speed/eta reaches both the docked footer and
//     the jobs panel
//
// Run: node scripts/e2e-settings.js
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnElectron } = require("./lib/electron-harness");

const APP = path.join(__dirname, "..");
const PORT = 9377;
// Unique per run: this writes into the real preset store, and a fixed name
// piles up a duplicate every time the suite is run.
const PRESET_NAME = `E2E Preset ${Date.now()}`;
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

async function shutdown(child, ws) {
  try { ws.close(); } catch {}
  try { child.kill(); } catch {}
  await sleep(600);
}

/** Attach to another of this app's windows by URL fragment. Settings is a
 *  real BrowserWindow now (§61), so it is a separate target — not a node in
 *  the main window's DOM. */
async function attach(urlPart, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = t.find((x) => x.type === "page" && x.url.includes(urlPart));
      if (page?.webSocketDebuggerUrl) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener("open", r));
        let id = 0; const pend = new Map();
        ws.addEventListener("message", (e) => {
          const m = JSON.parse(e.data);
          if (m.id && pend.has(m.id)) {
            const q = pend.get(m.id); pend.delete(m.id);
            m.error ? q.reject(new Error(JSON.stringify(m.error))) : q.resolve(m.result);
          }
        });
        const send = (me, pa = {}) => new Promise((res, rej) => {
          const i = ++id; pend.set(i, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: i, method: me, params: pa }));
        });
        await send("Runtime.enable");
        const ev = async (x) => {
          const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true, timeout: 30000 });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "threw");
          return r.result.value;
        };
        return { ws, ev, url: page.url };
      }
    } catch {}
    await sleep(250);
  }
  return null;
}

/** The Settings window populates asynchronously (algorithms, volumes and
 *  projects all come from main). Attaching succeeds the moment the target
 *  exists, which is before any of that has landed. */
async function waitFor(ev, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { if (await ev(expr)) return true; } catch {}
    await sleep(200);
  }
  return false;
}

(async () => {
  try { execSync(`pkill -f 'apps/desktop.*remote-debugging-port=${PORT}' || true`); } catch {}
  await sleep(800);

  // Start from no stored settings. Without this the run inherits whatever
  // the last one wrote, and "the picker starts on the saved value" can pass
  // just because the saved value happens to equal the built-in default.
  const userData = path.join(
    process.env.HOME, "Library", "Application Support",
    require(path.join(APP, "package.json")).build?.productName || "FreeFrame Desktop (name TBD)",
  );
  await fsp.rm(path.join(userData, "settings.json"), { force: true });

  // ── Launch 1: open Settings, change the default ──
  console.log("1. The Settings screen");
  let { child, ws, ev } = await launch();

  const settingsPath = await ev(`window.freeframe.appInfo().then(i => i.logsPath)`);
  check(typeof settingsPath === "string" && settingsPath.includes("logs"),
    "app info reports the logs folder the app actually writes to", settingsPath);

  check(await ev(`!!document.getElementById("settings-btn")`), "there is a way in");
  check(!(await ev(`!!document.getElementById("settings-backdrop")`)),
    "and the old in-page modal is gone, not merely hidden");

  await ev(`document.getElementById("settings-btn").click(); true`);
  const settings = await attach("settings.html");
  check(Boolean(settings), "clicking it opens a REAL separate window, not a modal", settings?.url || "(none)");
  if (!settings) { console.log("\ncannot continue without the Settings window."); process.exit(1); }
  const sev = settings.ev;

  // "Not a modal" is asserted at the SOURCE, and that limitation is worth
  // stating: a modal's input blocking is enforced by the OS, and CDP's
  // dispatchMouseEvent goes straight to the renderer, so no runtime probe
  // from here can tell a parented modal from an independent window.
  const mainSrc = await fsp.readFile(path.join(APP, "src", "main", "main.js"), "utf8");
  // Comments stripped first — the block's own comment explains why it is
  // NOT parented, and matching that would pass forever regardless of code.
  const block = mainSrc
    .slice(mainSrc.indexOf('ipcMain.handle("settings:open"'), mainSrc.indexOf("settingsWindow.loadFile"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check(!/\bmodal:\s*true/.test(block) && !/\bparent:\s*mainWindow/.test(block),
    "created without parent or modal — it sits beside the main window rather than on top of it");
  check(/minWidth|resizable:\s*true/.test(block) || !/resizable:\s*false/.test(block),
    "and is resizable");

  console.log("2. General — a themed picker, not a native select");
  check(await waitFor(sev, `document.querySelectorAll("#algo-list .algo-opt").length > 1`),
    "the picker populates from main's own algorithm list");
  check(!(await sev(`!!document.getElementById("settings-algo")`)),
    "the native <select> is gone");
  const opts = await sev(`document.querySelectorAll("#algo-list .algo-opt").length`);
  check(opts > 1, "replaced by the app's own option list", `${opts} options`);
  check(await sev(`!!document.querySelector("#algo-list .algo-opt .algo-name")
      && !!document.querySelector("#algo-list .algo-opt .algo-blurb")`),
    "carrying a name AND the explanation a native select cannot show");
  check(await sev(`getComputedStyle(document.querySelector("#algo-list")).backgroundColor !== "rgb(255, 255, 255)"`),
    "and it is themed with the app's own colours");
  check(await sev(`document.querySelectorAll("#algo-list .algo-opt.selected").length === 1`),
    "exactly one option reads as chosen");

  const builtIn = await ev(`window.freeframe.getAlgorithms().then(r => r.default || "xxhash64")`);
  // Deliberately something OTHER than the built-in default, so the relaunch
  // check below can tell "the saved value was applied" from "the default
  // happened to be right anyway".
  const chosen = await sev(`
    (() => {
      const sel = document.querySelector("#algo-list .algo-opt.selected");
      const other = [...document.querySelectorAll("#algo-list .algo-opt")].find(o => o !== sel);
      other.click();
      return [...document.querySelectorAll("#algo-list .algo-opt")].indexOf(other);
    })()
  `);
  await sleep(600);
  const persisted = await ev(`window.freeframe.getSettings().then(s => s.defaultChecksumAlgo)`);
  check(typeof persisted === "string" && persisted !== builtIn,
    "picking one writes it straight away, with no Save step to forget",
    `${builtIn} → ${persisted}`);

  console.log("3. Volumes — exactly one list");
  await sev(`document.querySelector('nav button[data-tab="volumes"]').click(); true`);
  check(!(await sev(`!!document.getElementById("settings-hidden")`)),
    "the second 'Hidden items' list is gone — it duplicated every connected row");
  check(await sev(`document.querySelectorAll(".hide-list").length === 1`), "there is exactly one list");

  // §65b — it clipped after about four rows however much room the window
  // had. Measured against the pane rather than against a number, so this
  // keeps meaning something if the window size changes.
  const height = await sev(`
    (() => {
      const list = document.querySelector(".hide-list");
      const main = document.querySelector("main");
      const r = list.getBoundingClientRect();
      return {
        list: Math.round(r.height),
        main: Math.round(main.getBoundingClientRect().height),
        clipped: list.scrollHeight > list.clientHeight + 1,
        rows: document.querySelectorAll(".hide-row").length,
      };
    })()
  `);
  check(height.list > 180,
    "the list is no longer capped at the old fixed 180px", `${height.list}px`);
  check(height.list > height.main * 0.5,
    "it takes the pane's available height instead of a fixed few rows",
    `${height.list}px of ${height.main}px`);
  check(!height.clipped,
    "and nothing scrolls prematurely at this row count", `${height.rows} rows`);

  // §62 — grouped rather than interleaved. The per-row "drive"/"project"
  // tag was carrying that distinction alone, in a list where the two
  // alternated.
  const groups = await sev(`[...document.querySelectorAll(".hide-group-title")].map(n => n.textContent.trim())`);
  check(Array.isArray(groups) && groups.join(",") === "Drives,Projects",
    "split into a Drives group and a Projects group", (groups || []).join(" | "));
  check(await sev(`[...document.querySelectorAll(".hide-row")].every(r => r.closest(".hide-group"))`),
    "and every row lives inside one of them, none left loose");
  check(!(await sev(`[...document.querySelectorAll(".hide-kind")].length`)),
    "the per-row kind tag is gone — the group heading says it now");

  // A hidden drive that is not plugged in was the only content unique to
  // the old second list. It has to survive the merge, or hiding an item
  // and unplugging it would strand the setting with no way back.
  await ev(`window.freeframe.setSettings({ hiddenVolumeNames: ["GoneForever"] })`);
  // Written from the MAIN window on purpose: it proves the broadcast, which
  // is what replaced the modal's local re-render when Settings became a
  // separate window.
  check(await waitFor(sev, `[...document.querySelectorAll(".hide-name")].some(n => n.textContent.trim() === "GoneForever")`),
    "an edit made in another window reaches this one via the broadcast");
  const orphanRow = await sev(`
    (() => {
      const row = [...document.querySelectorAll(".hide-row")]
        .find(r => r.querySelector(".hide-name").textContent.trim() === "GoneForever");
      if (!row) return null;
      return {
        tagged: !!row.querySelector(".hide-orphan"),
        text: (row.querySelector(".hide-orphan") || {}).textContent || "",
        checked: row.querySelector("input").checked,
      };
    })()
  `);
  check(Boolean(orphanRow), "a disconnected hidden drive is still listed");
  check(orphanRow && orphanRow.tagged && /not connected/i.test(orphanRow.text),
    "tagged in place rather than exiled to a second list", orphanRow?.text);
  check(orphanRow && orphanRow.checked === false, "and shown as hidden");
  check(await sev(`
    (() => {
      const row = [...document.querySelectorAll(".hide-row")]
        .find(r => r.querySelector(".hide-name").textContent.trim() === "GoneForever");
      const g = row.closest(".hide-group");
      return g && g.querySelector(".hide-group-title").textContent.trim() === "Drives";
    })()
  `), "filed under Drives, not a third pile for disconnected things");
  await ev(`window.freeframe.setSettings({ hiddenVolumeNames: [] })`);

  console.log("4. Naming Presets — relocated and grouped");
  check(!(await ev(`!!document.getElementById("preset-backdrop")`)),
    "the standalone preset modal is gone from the main window");
  await sev(`document.querySelector('nav button[data-tab="presets"]').click(); true`);
  check(await sev(`!!document.getElementById("preset-list") && !!document.getElementById("preset-pane")`),
    "the editor is here instead");

  await sev(`document.getElementById("preset-new").click(); true`);
  await sleep(300);
  const sections = await sev(`[...document.querySelectorAll("#preset-pane .pe-section-title")].map(n => n.textContent)`);
  check(Array.isArray(sections) && sections.length >= 4,
    "and reads as titled sections rather than one continuous list", (sections || []).join(" | "));
  check((sections || []).some((t) => /field/i.test(t)) && (sections || []).some((t) => /pattern/i.test(t)),
    "including Fields and the naming pattern");
  // The filtering block already had this treatment; it must not have been
  // left as the odd one out now that everything else is a card.
  check(await sev(`!!document.querySelector("#preset-pane .pe-section .filter-block")`),
    "with the existing filtering block folded into the same language");

  // §62 — folder structure moved OUT of the collapsed Filtering block. It
  // decides where every file lands, which is not a question about which
  // files are skipped.
  const folder = await sev(`
    (() => {
      const opt = [...document.querySelectorAll("#preset-pane option")]
        .find(o => o.textContent.includes("Keep the source's folder structure"));
      if (!opt) return null;
      return {
        insideFiltering: !!opt.closest(".filter-block"),
        section: (opt.closest(".pe-section")?.querySelector(".pe-section-title") || {}).textContent || "",
        // offsetParent is null for anything inside a closed <details>.
        visible: !!opt.closest("select").offsetParent,
      };
    })()
  `);
  check(Boolean(folder), "the folder-structure control is in the editor");
  check(folder && !folder.insideFiltering, "no longer nested inside the Filtering block");
  check(folder && folder.visible,
    "and visible without expanding anything — it was behind a collapsed section before");
  check(folder && /folder/i.test(folder.section), "under its own heading", folder?.section);

  // The pill in the main window was the ONLY way to choose an active
  // preset — there is no other selector, and saving in the editor is what
  // used to make one active. Moving the editor out without replacing it
  // would have left the app unable to select a preset at all.
  console.log("4b. Choosing a preset still works from the main window");
  await sev(`
    (() => {
      const input = document.querySelector('#preset-pane input[data-role="preset-name"]');
      input.value = ${JSON.stringify(PRESET_NAME)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("preset-save").click();
      return true;
    })()
  `);
  check(await waitFor(ev, `presetStore.presets.some(p => p.name === ${JSON.stringify(PRESET_NAME)})`),
    "a preset saved in the Settings window reaches the main window on its own");

  // The handler reloads presets from main before drawing, so the menu
  // fills a tick after the click rather than during it.
  await ev(`document.getElementById("preset-btn").click(); true`);
  await sleep(600);
  const menuItems = await ev(`[...document.querySelectorAll("#menu button")].map(b => b.textContent.trim())`);
  check(Array.isArray(menuItems) && menuItems.some((t) => t.includes(PRESET_NAME)),
    "the pill opens a selector listing it", (menuItems || []).join(" | "));
  check((menuItems || []).some((t) => /No naming preset/.test(t)),
    "with a way back to no preset at all");
  check((menuItems || []).some((t) => /Manage presets/.test(t)),
    "and a route to the editor, which now lives in Settings");

  const picked = await ev(`
    (() => {
      const b = [...document.querySelectorAll("#menu button")].find(x => x.textContent.includes(${JSON.stringify(PRESET_NAME)}));
      b.click();
      return document.getElementById("preset-label").textContent;
    })()
  `);
  check(picked === PRESET_NAME, "picking one makes it active", picked);

  // Deleting the active preset in the other window has to clear it here,
  // or the main window would go on naming a preset that no longer exists.
  // §62 — Delete moved out of the scrolling pane to sit beside Save. A
  // destructive action at the far bottom of a pane is both hard to find and
  // easy to hit on the way past.
  const delPlacement = await sev(`
    (() => {
      const del = document.getElementById("preset-delete");
      const save = document.getElementById("preset-save");
      if (!del || del.hidden) return { present: false };
      const c = getComputedStyle(del);
      return {
        present: true,
        leftOfSave: del.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false,
        adjacent: del.nextElementSibling === save,
        danger: del.classList.contains("danger"),
        colour: c.color,
        inPane: !!document.getElementById("preset-pane").contains(del),
      };
    })()
  `);
  check(delPlacement && delPlacement.present, "Delete is offered for a saved preset");
  check(delPlacement && delPlacement.adjacent && delPlacement.leftOfSave,
    "sitting immediately left of Save, not at the bottom of the editor pane");
  check(delPlacement && !delPlacement.inPane, "and out of the scrolling pane entirely");
  check(delPlacement && delPlacement.danger && delPlacement.colour !== "rgb(255, 255, 255)",
    "styled as destructive using the app's own status-error colour", delPlacement?.colour);

  const delResult = await sev(`(() => { document.getElementById("preset-delete").click(); return true; })()`);
  check(await waitFor(ev, `document.getElementById("preset-label").textContent === "No naming preset"`),
    "and deleting it there clears the selection here");

  // ── §65 — the editor half ───────────────────────────────────────────────
  console.log("4c. (\u00a765) Choice fields, pruned chips, split previews");
  await sev(`document.getElementById("preset-new").click(); true`);
  await sleep(300);

  const types = await sev(`[...document.querySelectorAll("#preset-pane button")]
    .find(b => b.textContent.trim() === "Add field").click(),
    [...document.querySelectorAll(".field-row select option")].map(o => o.textContent)`);
  check(Array.isArray(types) && types.join(",") === "Text,Choice",
    "the field type is Text or Choice — Suggesting is gone, not renamed", (types || []).join(","));

  const choice = await sev(`
    (() => {
      const sel = document.querySelector(".field-row select");
      sel.value = "choice";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      const box = document.querySelector(".choice-options");
      if (!box) return null;
      box.querySelector(".choice-add").click();
      const box2 = document.querySelector(".choice-options");
      const row = box2.querySelector(".choice-row");
      const [label, token] = row.querySelectorAll("input");
      label.value = "Mathias"; label.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        rows: box2.querySelectorAll(".choice-row").length,
        inputsPerRow: row.querySelectorAll("input").length,
        tokenPlaceholder: token.placeholder,
        hasOther: /Other/.test(box2.textContent),
        otherDefault: box2.querySelector(".choice-other input").checked,
        controls: row.querySelectorAll(".choice-row-controls button").length,
      };
    })()
  `);
  check(Boolean(choice), "picking Choice reveals an option list to author");
  check(choice && choice.rows === 1 && choice.inputsPerRow === 2,
    "each option row carries a Label and a Token", JSON.stringify(choice));
  check(choice && choice.tokenPlaceholder === "Mathias",
    "and the Token's placeholder shows what a blank one will render as — the fallback is visible, not remembered",
    choice?.tokenPlaceholder);
  check(choice && choice.controls === 3, "with reorder and remove controls", String(choice?.controls));
  check(choice && choice.hasOther && choice.otherDefault === false,
    "an 'Other…' checkbox exists and is off by default — a closed list unless asked for");

  // §65.6 — chips pruned, tokens NOT removed from the engine.
  const chips = await sev(`
    (() => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const rowOf = (i) => i.nextElementSibling.nextElementSibling;
      const texts = (tpl) => {
        const inp = inputs.find(i => i.dataset.tpl === tpl);
        return [...rowOf(inp).querySelectorAll("code")].map(c => c.textContent);
      };
      return { folder: texts("folderTemplate"), file: texts("fileTemplate") };
    })()
  `);
  const all = [...(chips.folder || []), ...(chips.file || [])];
  for (const gone of ["{ext}", "{cardname}", "{datetime}", "{date}", "{time}"]) {
    check(!all.includes(gone), `${gone} is no longer offered as a chip`);
  }
  for (const kept of ["{YYYY}", "{YY}", "{MM}", "{DD}", "{hh}", "{mm}"]) {
    check(all.includes(kept), `${kept} is offered`, all.join(" "));
  }
  check((chips.file || []).includes("{counter}") && (chips.file || []).includes("{name}"),
    "the file field keeps {counter} and {name}", (chips.file || []).join(" "));
  check((chips.folder || []).includes("{sourcecounter}") && !(chips.folder || []).includes("{counter}"),
    "and the folder field keeps only the per-source counter", (chips.folder || []).join(" "));

  // §65.8/.9 — two scoped previews, amber on what the user did not write.
  const previews = await sev(`
    (async () => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const set = (tpl, v) => {
        const i = inputs.find(x => x.dataset.tpl === tpl);
        i.value = v; i.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("folderTemplate", "{YYYY}{MM}{DD}");
      set("fileTemplate", "SHOT");
      await new Promise(r => setTimeout(r, 500));
      const fo = document.getElementById("tpl-preview-folder");
      const fi = document.getElementById("tpl-preview-file");
      const amber = fi && fi.querySelector(".auto-fix");
      return {
        two: !!fo && !!fi,
        folderUnderFolderField: !!fo && fo.previousElementSibling.textContent.includes("Click to insert"),
        folderText: fo ? fo.textContent : "",
        fileText: fi ? fi.textContent : "",
        amberText: amber ? amber.textContent : null,
        amberColour: amber ? getComputedStyle(amber).color : null,
      };
    })()
  `);
  check(previews.two, "there are two previews, one per pattern field");
  check(previews.folderUnderFolderField, "each sits under its own field");
  check(!/DCIM|100MEDIA/.test(previews.folderText) && !/DCIM|100MEDIA/.test(previews.fileText),
    "and neither shows the source's own subtree, which neither template produces",
    `${previews.folderText} | ${previews.fileText}`);
  check(!previews.folderText.includes("SHOT") && !previews.fileText.includes("/"),
    "the folder preview shows only the folder and the file preview only the file",
    `${previews.folderText} | ${previews.fileText}`);
  // §65.5/.9 — "SHOT" numbers nothing, so a counter is added for the user.
  check(previews.amberText === "_0001",
    "the auto-appended counter is shown", String(previews.amberText));
  check(previews.amberColour && previews.amberColour !== "rgb(255, 255, 255)",
    "highlighted in the app's own warning colour, because it is text the user did not write",
    previews.amberColour);

  // §65c — the editor half of the same refusal.
  console.log("4d. (\u00a765c) {counter} cannot be saved into a folder pattern");
  const rejected = await sev(`
    (async () => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const folder = inputs.find(x => x.dataset.tpl === "folderTemplate");
      folder.value = "TAKE_{counter}";
      folder.dispatchEvent(new Event("input", { bubbles: true }));
      const name = document.querySelector('#preset-pane input[data-role="preset-name"]');
      name.value = "Counter In Folder";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      const fo = document.getElementById("tpl-preview-folder");
      const live = { text: fo.textContent, bad: fo.classList.contains("bad") };

      // Cleared first: an earlier section's "Saved" is still on screen,
      // and polling for "any non-empty note" would read that one.
      document.getElementById("preset-saved").textContent = "";
      document.getElementById("preset-save").click();
      // Polled rather than slept: the note clears itself after 2.5s, so a
      // fixed wait races its own deadline.
      let note = "";
      for (let i = 0; i < 20; i++) {
        note = document.getElementById("preset-saved").textContent;
        if (note) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const store = await window.freeframe.listPresets();
      return { live, note, saved: store.presets.some(p => p.name === "Counter In Folder") };
    })()
  `);
  check(rejected && /numbers files/.test(rejected.live.text),
    "it is flagged as the pattern is typed, not held back until Save", rejected?.live?.text);
  check(rejected && rejected.live.bad, "shown as an error, not as a preview");
  check(rejected && /numbers files/.test(rejected.note) && /one folder per file/.test(rejected.note),
    "pressing Save reports the same reason", JSON.stringify(rejected?.note));
  check(rejected && rejected.saved === false,
    "and NOTHING was written — the refusal is not merely cosmetic");

  // The token this is not about must still save.
  const allowed = await sev(`
    (async () => {
      const inputs = [...document.querySelectorAll(".tpl-input")];
      const folder = inputs.find(x => x.dataset.tpl === "folderTemplate");
      folder.value = "Card_{sourcecounter}";
      folder.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));
      document.getElementById("preset-save").click();
      await new Promise(r => setTimeout(r, 800));
      const store = await window.freeframe.listPresets();
      const p = store.presets.find(p => p.name === "Counter In Folder");
      if (p) await window.freeframe.deletePreset(p.id);
      return { saved: Boolean(p), folder: p ? p.folderTemplate : null };
    })()
  `);
  check(allowed && allowed.saved && allowed.folder === "Card_{sourcecounter}",
    "{sourcecounter} in a folder pattern saves exactly as before", JSON.stringify(allowed));

  console.log("5. The toolbar picker is gone");
  check(!(await ev(`!!document.getElementById("algo-btn")`)),
    "no checksum control anywhere in the main window");
  check(!(await ev(`!!document.getElementById("algo-menu")`)), "and its menu went with it");

  try { settings.ws.close(); } catch {}
  await shutdown(child, ws);

  // ── Launch 2: the saved default is applied ──
  console.log("6. It survives a relaunch");
  ({ child, ws, ev } = await launch());

  const active = await ev(`window.freeframe.getSettings().then(s => s.defaultChecksumAlgo)`);
  check(active === persisted, "the setting is still there", active);
  check(await ev(`algorithm === ${JSON.stringify(persisted)}`),
    "and a job started now would use it — this is the only place it comes from");

  // ── Speed / ETA reaches both surfaces ──
  console.log("3. Speed and ETA");
  const footer = await ev(`
    (() => {
      const p = { phase: "bytes", percent: 40, file: "CLIP.MOV",
                  speed: 42 * 1024 * 1024, eta: 185, nodeIds: [] };
      window.dispatchEvent(new CustomEvent("noop"));
      onProgress(p);
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(/MB\/s/.test(footer), "the docked footer shows a speed", footer);
  check(/remaining/.test(footer), "and a remaining time", footer);
  check(/3m/.test(footer), "coarse, not to the second", footer);

  const blank = await ev(`
    (() => {
      onProgress({ phase: "bytes", percent: 41, file: "CLIP.MOV", nodeIds: [] });
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(blank === "",
    "and shows nothing at all before there is a rate, rather than a stale one");

  const verifying = await ev(`
    (() => {
      onProgress({ phase: "bytes", percent: 60, speed: 1e7, eta: 20, nodeIds: [] });
      onProgress({ phase: "verifying", file: "CLIP.MOV" });
      return document.getElementById("p-rate").textContent;
    })()
  `);
  check(verifying === "",
    "and clears it when the job stops transferring — verification is not a transfer");

  await shutdown(child, ws);

  // ── The panel renders it too ──
  console.log("4. The jobs panel");
  const panelSrc = await fsp.readFile(path.join(APP, "src", "renderer", "panel.js"), "utf8");
  check(/p\.speed/.test(panelSrc) && /fmtEta\(p\.eta\)/.test(panelSrc),
    "renderJobs reads speed and eta off the progress object");
  check(/j\.status === "running"/.test(panelSrc),
    "and only while the job is running");

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
})();
