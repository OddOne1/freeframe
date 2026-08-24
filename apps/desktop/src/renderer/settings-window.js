// Settings window (§61).
//
// Was an in-page modal in index.html. It is a real BrowserWindow now, so
// this file holds no shared state with the main window: it reads from main
// and writes back through the same IPC the modal used, and main broadcasts
// the result to every window. Nothing here reaches into the main window.
//
// The naming-preset editor lives in preset-editor.js, loaded alongside this
// file — extracted rather than copied, since two copies of one editor is the
// drift this project keeps paying for.
"use strict";

const $ = (id) => document.getElementById(id);

function el(tag, opts = {}, children = []) {
  const n = document.createElement(tag);
  if (opts.class) n.className = opts.class;
  if (opts.text != null) n.textContent = opts.text;
  if (opts.title) n.title = opts.title;
  if (opts.onClick) n.addEventListener("click", opts.onClick);
  for (const c of children) if (c) n.appendChild(c);
  return n;
}
function icon(name) {
  const span = el("span", { class: "icon" });
  span.innerHTML = (window.FF_ICONS && window.FF_ICONS[name]) || "";
  return span;
}

// ── Tabs ─────────────────────────────────────────────────────────────────

for (const btn of document.querySelectorAll("nav button")) {
  btn.addEventListener("click", () => {
    for (const b of document.querySelectorAll("nav button")) {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    for (const p of document.querySelectorAll(".tab-panel")) {
      p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`);
    }
  });
}

function showTab(name) {
  const btn = document.querySelector(`nav button[data-tab="${name}"]`);
  if (btn) btn.click();
}
window.freeframe.onSettingsTab(showTab);

// ── General: checksum algorithm ──────────────────────────────────────────
//
// This is now the ONLY place the algorithm is chosen. The toolbar picker it
// replaces was per-job; that override is gone, and a job reads this value
// at start time.

let algorithms = [];
let algorithm = null;
let builtInAlgo = null;

function renderAlgoList() {
  const host = $("algo-list");
  host.replaceChildren();
  for (const a of algorithms) {
    const top = el("div", { class: "algo-top" }, [
      el("span", { class: "algo-name", text: a.label }),
      a.recommended ? el("span", { class: "algo-tag", text: "Default" }) : null,
    ]);
    if (a.id === algorithm) {
      const chk = el("span", { class: "algo-check" });
      chk.appendChild(icon("check"));
      top.appendChild(chk);
    }
    host.appendChild(el("button", {
      class: a.id === algorithm ? "algo-opt selected" : "algo-opt",
      // Saved immediately rather than on a Done button: this window has no
      // Cancel, so a deferred save would only invite closing it and losing
      // the change.
      onClick: async () => {
        algorithm = a.id;
        renderAlgoList();
        await window.freeframe.setSettings({ defaultChecksumAlgo: a.id });
      },
    }, [top, el("div", { class: "algo-blurb", text: a.blurb })]));
  }
  host.appendChild(el("div", {
    class: "algo-guidance",
    text: "xxHash for speed (default) · MD5/SHA-1 to match an existing pipeline · "
        + "C4 when the checksum itself might need to prove something in a dispute.",
  }));
}

// ── Volumes: one list, orphans tagged in place ───────────────────────────

let hiddenVolumeNames = [];
let hiddenProjectIds = [];
let volumes = [];
let projects = [];
let displayNames = {};

function renderHideList() {
  const host = $("settings-visible");
  host.replaceChildren();

  // Built from everything hideable, hidden or not, so an item does not
  // vanish from Settings the moment it is hidden and take its own undo
  // with it.
  const items = [
    ...volumes.map((v) => ({
      key: v.name, kind: "drive",
      // The label may be a §22e display-name override; the STORED key is
      // the real name, so renaming a drive here does not silently unhide it.
      label: displayNames[v.mountPoint] || v.name,
      hidden: hiddenVolumeNames.includes(v.name),
      orphan: false,
    })),
    ...projects.map((p) => ({
      key: p.id, kind: "project", label: p.name,
      hidden: hiddenProjectIds.includes(p.id), orphan: false,
    })),
    // Hidden entries that are not currently connected. They used to be a
    // whole second list; every hidden-but-connected item appeared in both,
    // and this was the only content unique to it. One list, tagged.
    ...hiddenVolumeNames
      .filter((n) => !volumes.some((v) => v.name === n))
      .map((n) => ({ key: n, kind: "drive", label: n, hidden: true, orphan: true })),
    ...hiddenProjectIds
      .filter((id) => !projects.some((p) => p.id === id))
      .map((id) => ({ key: id, kind: "project", label: id, hidden: true, orphan: true })),
  ];

  if (!items.length) {
    host.appendChild(el("div", { class: "hide-empty", text: "Nothing to show yet." }));
    return;
  }

  for (const it of items) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !it.hidden;
    box.addEventListener("change", () => setHidden(it.kind, it.key, !box.checked));
    const row = el("label", { class: "hide-row" }, [
      box,
      el("span", { class: "hide-name", text: it.label, title: it.label }),
      it.orphan ? el("span", { class: "hide-orphan", text: "not connected" }) : null,
      el("span", { class: "hide-kind", text: it.kind }),
    ]);
    host.appendChild(row);
  }
}

async function setHidden(kind, key, hide) {
  const list = kind === "project" ? hiddenProjectIds : hiddenVolumeNames;
  const next = hide
    ? Array.from(new Set([...list, key]))
    : list.filter((x) => x !== key);
  if (kind === "project") hiddenProjectIds = next;
  else hiddenVolumeNames = next;
  renderHideList();
  await window.freeframe.setSettings(
    kind === "project" ? { hiddenProjectIds: next } : { hiddenVolumeNames: next },
  );
}

// ── Presets tab wiring ───────────────────────────────────────────────────

$("preset-new").addEventListener("click", () => window.PresetEditor.startNew());
$("preset-save").addEventListener("click", async () => {
  const res = await window.PresetEditor.save();
  const note = $("preset-saved");
  note.textContent = res.ok ? "Saved" : res.error;
  note.style.color = res.ok ? "var(--status-success)" : "var(--status-error)";
  setTimeout(() => { note.textContent = ""; }, 2500);
});

// ── Load ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = (await window.freeframe.getSettings()) || {};
  hiddenVolumeNames = s.hiddenVolumeNames || [];
  hiddenProjectIds = s.hiddenProjectIds || [];
  // A stored id that no longer exists must not leave the list with nothing
  // selected — fall back to whatever main calls the default.
  const known = algorithms.some((a) => a.id === s.defaultChecksumAlgo);
  algorithm = known
    ? s.defaultChecksumAlgo
    : builtInAlgo || (algorithms[0] || {}).id || null;
  renderAlgoList();
  renderHideList();
}

(async () => {
  // getAlgorithms returns { algorithms, default } — not a bare array.
  const algoInfo = (await window.freeframe.getAlgorithms()) || {};
  algorithms = algoInfo.algorithms || [];
  builtInAlgo = algoInfo.default || null;
  volumes = (await window.freeframe.listVolumes()) || [];
  displayNames = (await window.freeframe.getDisplayNames()) || {};
  try {
    const status = await window.freeframe.freeframeStatus();
    if (status && status.loggedIn) {
      // Returns { ok, projects }, not a bare array.
      const res = await window.freeframe.freeframeProjects();
      projects = res && res.ok ? (res.projects || []) : [];
    }
  } catch { /* logged out, or offline — drives alone are still hideable */ }

  await loadSettings();
  await window.PresetEditor.init();

  const info = await window.freeframe.appInfo();
  $("settings-logs-path").textContent = info.logsPath;
  $("settings-about").textContent = `FreeFrame Desktop ${info.version} · Electron ${info.electron}`;

})();

// Registered at module level, NOT inside the load above: anything in that
// sequence that rejects would otherwise take the live updates with it, and
// a window that silently stops following the app is worse than one that
// fails to finish loading visibly.
//
// The preset store can change from elsewhere too — deleting the active
// preset from the main window's selector, for instance. reloadPresets()
// keeps the open draft unless the store no longer has it, so this cannot
// clobber an edit in progress.
window.freeframe.onPresetsChanged(() => { void window.PresetEditor.reload(); });
// A drive plugged in while this window is open belongs in the list.
window.freeframe.onVolumesChanged((v) => { volumes = v; renderHideList(); });
// Settings can be written from either window, so this one follows the
// broadcast rather than assuming it is the only writer.
window.freeframe.onSettingsChanged((s) => {
  hiddenVolumeNames = s.hiddenVolumeNames || [];
  hiddenProjectIds = s.hiddenProjectIds || [];
  const known = algorithms.some((a) => a.id === s.defaultChecksumAlgo);
  if (known) algorithm = s.defaultChecksumAlgo;
  renderAlgoList();
  renderHideList();
});

$("settings-open-logs").addEventListener("click", () => window.freeframe.openLogsFolder());
