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
  const drives = volumes.map((v) => ({
    key: v.name, kind: "drive",
    // The label may be a §22e display-name override; the STORED key is
    // the real name, so renaming a drive here does not silently unhide it.
    label: displayNames[v.mountPoint] || v.name,
    hidden: hiddenVolumeNames.includes(v.name),
    orphan: false,
  }));
  const projs = projects.map((p) => ({
    key: p.id, kind: "project", label: p.name,
    hidden: hiddenProjectIds.includes(p.id), orphan: false,
  }));
  // Hidden entries that are not currently connected. They used to be a
  // whole second list; every hidden-but-connected item appeared in both,
  // and this was the only content unique to it. Tagged in place instead —
  // and filed under the group they belong to, not a third pile.
  drives.push(...hiddenVolumeNames
    .filter((n) => !volumes.some((v) => v.name === n))
    .map((n) => ({ key: n, kind: "drive", label: n, hidden: true, orphan: true })));
  projs.push(...hiddenProjectIds
    .filter((id) => !projects.some((p) => p.id === id))
    .map((id) => ({ key: id, kind: "project", label: id, hidden: true, orphan: true })));

  if (!drives.length && !projs.length) {
    host.appendChild(el("div", { class: "hide-empty", text: "Nothing to show yet." }));
    return;
  }

  // §62 — grouped rather than interleaved. A drive and a FreeFrame project
  // are different kinds of thing and the per-row "drive"/"project" tag was
  // carrying that distinction alone, in a list where the two alternated.
  const row = (it) => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !it.hidden;
    box.addEventListener("change", () => setHidden(it.kind, it.key, !box.checked));
    return el("label", { class: "hide-row" }, [
      box,
      el("span", { class: "hide-name", text: it.label, title: it.label }),
      it.orphan ? el("span", { class: "hide-orphan", text: "not connected" }) : null,
    ]);
  };

  for (const [title, items, empty] of [
    ["Drives", drives, "No drives connected."],
    ["Projects", projs, "No FreeFrame projects."],
  ]) {
    const group = el("div", { class: "hide-group" });
    group.appendChild(el("div", { class: "hide-group-title", text: title }));
    if (items.length) for (const it of items) group.appendChild(row(it));
    else group.appendChild(el("div", { class: "hide-empty", text: empty }));
    host.appendChild(group);
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

// ── Account tab (§64) ────────────────────────────────────────────────────
//
// The login form moved here from the main window's header. No auth plumbing
// changed: `freeframe.js` already holds one session that serves both
// Offload's project browsing and the embedded FreeFrame page's SSO. What
// moved is the UI, and main now broadcasts the result so the main window
// learns about a sign-in it did not run.

let ffStatus = { loggedIn: false };
let busyWithProjects = false;

function setLoginError(msg) {
  const box = $("ff-error");
  box.textContent = msg || "";
  box.classList.toggle("show", Boolean(msg));
}

function renderAccount() {
  const inn = ffStatus.loggedIn;
  $("account-signed-out").hidden = inn;
  $("account-signed-in").hidden = !inn;
  if (inn) {
    $("account-who").textContent =
      ffStatus.user?.name || ffStatus.user?.email || "Signed in";
    $("account-where").textContent = ffStatus.baseUrl || "";
    // Signing out mid-upload would invalidate the token an in-flight
    // FreeFrame job is using. Same rule the header button enforced.
    $("ff-logout").disabled = busyWithProjects;
    $("account-busy").hidden = !busyWithProjects;
  } else {
    $("ff-url").value = ffStatus.baseUrl || "https://frame.yon.studio/api";
  }
}

async function refreshBusy() {
  try {
    const jobs = (await window.freeframe.listJobs()) || [];
    busyWithProjects = jobs.some((j) =>
      (j.status === "running" || j.status === "queued")
      && [j.sourcePath, ...(j.destPaths || [])].some((p) => p && p.startsWith("freeframe://")));
  } catch { busyWithProjects = false; }
}

$("ff-submit").addEventListener("click", async () => {
  const email = $("ff-email").value.trim();
  const password = $("ff-pass").value;
  const baseUrl = $("ff-url").value.trim();
  if (!email || !password) { setLoginError("Email and password are required."); return; }
  const btn = $("ff-submit");
  btn.disabled = true; btn.textContent = "Signing in…";
  setLoginError("");
  try {
    const res = await window.freeframe.freeframeLogin(email, password, baseUrl);
    if (!res || !res.ok) { setLoginError((res && res.error) || "Sign-in failed."); return; }
    // Never leave the password sitting in a live DOM node.
    $("ff-pass").value = "";
    ffStatus = await window.freeframe.freeframeStatus();
    renderAccount();
    await loadProjectsForHideList();
  } finally {
    btn.disabled = false; btn.textContent = "Sign in";
  }
});
$("ff-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ff-submit").click(); });
$("ff-email").addEventListener("keydown", (e) => { if (e.key === "Enter") $("ff-pass").focus(); });

$("ff-logout").addEventListener("click", async () => {
  await refreshBusy();
  if (busyWithProjects) { renderAccount(); return; }
  ffStatus = await window.freeframe.freeframeLogout();
  projects = [];
  renderAccount();
  renderHideList();
});

async function loadProjectsForHideList() {
  try {
    if (ffStatus.loggedIn) {
      // Returns { ok, projects }, not a bare array.
      const res = await window.freeframe.freeframeProjects();
      projects = res && res.ok ? (res.projects || []) : [];
    } else {
      projects = [];
    }
  } catch { projects = []; }
  renderHideList();
}

// ── Presets tab wiring ───────────────────────────────────────────────────

$("preset-new").addEventListener("click", () => window.PresetEditor.startNew());
// §62 — Delete lives beside Save now, and only exists for a preset that
// has actually been saved: there is nothing to delete about a draft.
$("preset-delete").addEventListener("click", async () => {
  await window.PresetEditor.deleteCurrent();
});
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
    ffStatus = (await window.freeframe.freeframeStatus()) || { loggedIn: false };
  } catch { ffStatus = { loggedIn: false }; }
  await refreshBusy();
  renderAccount();

  await loadSettings();
  await loadProjectsForHideList();
  await window.PresetEditor.init({
    onSelectionChange: (savedPresetOpen) => { $("preset-delete").hidden = !savedPresetOpen; },
  });

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
