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
let algorithm = null;            // live
let finalizedAlgorithm = null;   // finalized, when enabled
let finalizedEnabled = false;
let builtInAlgo = null;

/**
 * §86 — one <select> per tier, plus the explanations once underneath.
 *
 * The old picker put a paragraph beside every option, because "xxh3 vs c4"
 * is not a choice anyone makes from a name alone. With two tiers that would
 * have printed the same four paragraphs twice, so the explanations moved
 * out to a read-only block and these became plain dropdowns.
 */
function fillAlgoSelect(sel, selected) {
  sel.replaceChildren();
  for (const a of algorithms) {
    const opt = el("option", { text: a.recommended ? `${a.label} (default)` : a.label });
    // el() sets value via the property, and an <option> needs it set before
    // it is selected against.
    opt.value = a.id;
    sel.appendChild(opt);
  }
  sel.value = selected || "";
}

function renderAlgoList() {
  const live = $("settings-live-checksum");
  const fin = $("settings-finalized-checksum");
  const toggle = $("settings-finalized-enabled");
  if (!live || !fin || !toggle) return;

  fillAlgoSelect(live, algorithm);
  // Empty stored value means "follow live" (settings.js's finalizedAlgoFor),
  // so the dropdown shows what would actually run rather than nothing.
  fillAlgoSelect(fin, finalizedAlgorithm || algorithm);
  toggle.checked = finalizedEnabled;
  // Visible but inert while off: hiding it would make the toggle look like
  // it does nothing, and the algorithm is what the toggle is about.
  fin.disabled = !finalizedEnabled;

  const ref = $("algo-reference");
  if (ref) {
    ref.replaceChildren();
    for (const a of algorithms) {
      ref.appendChild(el("div", { class: "algo-ref-row" }, [
        el("div", { class: "algo-ref-name", text: a.recommended ? `${a.label} — default` : a.label }),
        el("div", { class: "algo-ref-blurb", text: a.blurb }),
      ]));
    }
    ref.appendChild(el("div", {
      class: "algo-guidance",
      text: "xxHash for speed (default) · MD5/SHA-1 to match an existing pipeline · "
          + "C4 when the checksum itself might need to prove something in a dispute.",
    }));
  }
}

/** Saved immediately rather than on a Done button: this window has no
 *  Cancel, so a deferred save would only invite closing it and losing the
 *  change. */
function wireChecksumControls() {
  const live = $("settings-live-checksum");
  const fin = $("settings-finalized-checksum");
  const toggle = $("settings-finalized-enabled");
  if (!live || !fin || !toggle) return;

  live.addEventListener("change", async () => {
    algorithm = live.value;
    renderAlgoList();
    await window.freeframe.setSettings({ liveChecksumAlgo: algorithm });
  });
  fin.addEventListener("change", async () => {
    finalizedAlgorithm = fin.value;
    await window.freeframe.setSettings({ finalizedChecksumAlgo: finalizedAlgorithm });
  });
  toggle.addEventListener("change", async () => {
    finalizedEnabled = toggle.checked;
    renderAlgoList();
    await window.freeframe.setSettings({ finalizedChecksumEnabled: finalizedEnabled });
  });
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
// One timer, cancelled and restarted per save. Without this an earlier
// save's pending clear wipes a LATER message — so a refusal shown within
// 2.5s of a successful save vanished almost immediately, which is exactly
// the moment someone is most likely to be iterating on a pattern.
let saveNoteTimer = null;
$("preset-save").addEventListener("click", async () => {
  const res = await window.PresetEditor.save();
  const note = $("preset-saved");
  note.textContent = res.ok ? "Saved" : res.error;
  note.style.color = res.ok ? "var(--status-success)" : "var(--status-error)";
  clearTimeout(saveNoteTimer);
  saveNoteTimer = setTimeout(() => { note.textContent = ""; }, 2500);
});

// ── Load ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = (await window.freeframe.getSettings()) || {};
  hiddenVolumeNames = s.hiddenVolumeNames || [];
  hiddenProjectIds = s.hiddenProjectIds || [];
  // A stored id that no longer exists must not leave the list with nothing
  // selected — fall back to whatever main calls the default.
  const known = algorithms.some((a) => a.id === s.liveChecksumAlgo);
  algorithm = known
    ? s.liveChecksumAlgo
    : builtInAlgo || (algorithms[0] || {}).id || null;
  // Same staleness guard for the finalized tier. Empty is legitimate here
  // and means "follow live", so it is left empty rather than pinned.
  finalizedAlgorithm = algorithms.some((a) => a.id === s.finalizedChecksumAlgo)
    ? s.finalizedChecksumAlgo
    : null;
  finalizedEnabled = s.finalizedChecksumEnabled === true;
  renderAlgoList();
  renderHideList();
  // §72 — the Daily overview's day boundary. Saved on change like the
  // algorithm above: this window has no Cancel, so a deferred save would
  // only invite closing it and losing the change.
  $("settings-day-boundary").value = s.dayBoundary || "00:00";
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

  // Listeners before the first render, so a change made immediately after
  // the pane appears is not dropped. Registering them once here rather than
  // inside renderAlgoList(), which re-runs on every broadcast and would
  // stack a new listener each time.
  wireChecksumControls();
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
  const known = algorithms.some((a) => a.id === s.liveChecksumAlgo);
  if (known) algorithm = s.liveChecksumAlgo;
  finalizedAlgorithm = algorithms.some((a) => a.id === s.finalizedChecksumAlgo)
    ? s.finalizedChecksumAlgo
    : null;
  finalizedEnabled = s.finalizedChecksumEnabled === true;
  renderAlgoList();
  renderHideList();
});

$("settings-open-logs").addEventListener("click", () => window.freeframe.openLogsFolder());

$("settings-day-boundary").addEventListener("change", async () => {
  const el = $("settings-day-boundary");
  const saved = await window.freeframe.setSettings({ dayBoundary: el.value });
  // Echoed back from main rather than trusted: an unparseable value falls
  // back to the default there, and the field must show what was stored.
  el.value = saved.dayBoundary;
});
