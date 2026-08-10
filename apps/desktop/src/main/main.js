const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { listVolumes } = require("./volumes");
const { runCopyJob } = require("./copy-engine");
const { listAlgorithms, isSupported, DEFAULT_ALGORITHM } = require("./hashers");
const freeframe = require("./freeframe");
const { listFilesRecursive } = require("./copy-engine");

const execFileAsync = promisify(execFile);

let mainWindow = null;

// One copy job at a time, deliberately. Concurrent jobs against the same
// source would fight over the same device queue and make the progress
// numbers meaningless; the roadmap's multi-hop DAG is a scheduler on top
// of this, not several uncoordinated runs.
let activeJob = null;

// ── Live volume detection ──
// Mounting or ejecting a disk fires several fs events in quick succession
// (the directory entry appearing, then metadata settling), so a raw watcher
// would push 3-5 refreshes for one physical action. Debounced to one.
const VOLUME_DEBOUNCE_MS = 300;
let volumeWatcher = null;
let volumeDebounce = null;

function startVolumeWatcher() {
  if (volumeWatcher) return;
  try {
    volumeWatcher = fs.watch("/Volumes", () => {
      clearTimeout(volumeDebounce);
      volumeDebounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("volumes:changed");
        }
      }, VOLUME_DEBOUNCE_MS);
    });
    // A watcher error (the directory going away, fd exhaustion) must not
    // take the app down — the manual Refresh button still works.
    volumeWatcher.on("error", () => {
      volumeWatcher = null;
    });
  } catch {
    volumeWatcher = null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    title: "FreeFrame Desktop (name TBD)",
    webPreferences: {
      // Security baseline for a notarized, non-sandboxed distribution:
      // no direct Node access from the renderer, a preload contextBridge
      // is the only path in. Not optional — this app talks to real drives
      // and, later, the local network, so the renderer must never get a
      // raw Node/fs handle.
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

// IPC: renderer asks for the current volume list, main process does the
// actual diskutil work and returns plain serializable data. Nothing here
// yet triggers macOS's removable-volume permission prompt on its own —
// that fires the first time this app actually reads file contents from a
// removable volume, not on directory listing/diskutil info.
ipcMain.handle("volumes:list", async () => {
  return listVolumes();
});

// Eject / disconnect. Finder makes the same distinction and users already
// have the vocabulary: physical media is "ejected", a network share is
// "disconnected", and the diskutil verbs differ accordingly.
//
// The internal refusal is enforced HERE, not just hidden in the UI.
// Unmounting the boot/data volume is never a sane action no matter what
// triggered the call, and a renderer bug (or a future caller) shouldn't be
// able to reach it.
ipcMain.handle("volumes:eject", async (_event, { mountPoint } = {}) => {
  if (typeof mountPoint !== "string" || !mountPoint.startsWith("/Volumes/")) {
    return { ok: false, error: "Refusing to eject a path outside /Volumes" };
  }

  // Ejecting a volume mid-copy would corrupt the transfer. The renderer
  // already hides the option, but this is the guard that actually holds.
  if (activeJob) {
    return { ok: false, error: "A copy is in progress — cancel it before ejecting." };
  }

  // The type is re-derived from the real volume list rather than taken from
  // the caller. Trusting the renderer's `type` meant a caller claiming
  // "removable" got `diskutil eject` genuinely run against the boot volume
  // — it failed only because macOS itself dissented, which is luck, not a
  // guard. Caught by the test that lies about the type on purpose.
  const known = (await listVolumes()).find((v) => v.mountPoint === mountPoint);
  if (!known) {
    return { ok: false, error: "That volume isn't mounted." };
  }
  if (known.type === "internal") {
    return { ok: false, error: "The internal system drive can't be ejected." };
  }

  const verb = known.type === "network" ? "unmount" : "eject";
  try {
    await execFileAsync("diskutil", [verb, mountPoint]);
    // No refresh pushed from here: the /Volumes watcher already fires when
    // the mount disappears, and duplicating it would double-refresh.
    return { ok: true, verb };
  } catch (err) {
    // diskutil's own stderr is the useful part -- "Unmount failed... because
    // it is in use" tells the user which app to quit. Swallowing it and
    // saying "eject failed" would waste their time.
    const detail = String(err.stderr || err.stdout || err.message || "").trim();
    return { ok: false, error: detail || `diskutil ${verb} failed` };
  }
});

// Checksum algorithms + their explainer text, for the picker.
ipcMain.handle("checksum:algorithms", async () => ({
  algorithms: listAlgorithms(),
  default: DEFAULT_ALGORITHM,
}));

// ── FreeFrame account ──
// The renderer never receives a token. It asks main to act, exactly like
// volumes and copying, so a compromised renderer can't exfiltrate the
// credential.
ipcMain.handle("freeframe:login", async (_e, { email, password, baseUrl } = {}) => {
  if (typeof email !== "string" || typeof password !== "string") {
    return { ok: false, error: "Email and password are required" };
  }
  try {
    return await freeframe.login({ email, password, baseUrl });
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle("freeframe:logout", async () => { await freeframe.clearSession(); return freeframe.status(); });
ipcMain.handle("freeframe:status", async () => freeframe.status());

ipcMain.handle("freeframe:projects", async () => {
  try { return { ok: true, projects: await freeframe.listProjects() }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

ipcMain.handle("freeframe:folder-tree", async (_e, { projectId } = {}) => {
  try { return { ok: true, tree: await freeframe.folderTree(projectId) }; }
  catch (err) { return { ok: false, error: String(err.message || err) }; }
});

// Item 3 — what a project actually contains, for the UI to show before a
// pull is started. The copy job builds its own manifest from the same
// endpoint; this is purely so "12 assets, 4.1 GB" can be shown up front
// rather than only discovered once the job is running.
ipcMain.handle("freeframe:list-assets", async (_e, { projectId, folderId, recursive } = {}) => {
  try {
    const files = await freeframeSourceFiles(projectId, folderId, recursive !== false);
    return {
      ok: true,
      files,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      skipped: files.__skipped || [],
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/**
 * Flatten a project (or one folder in it) into the {rel, size} manifest the
 * copy engine wants.
 *
 * The open question this item started with — "is there a flat 'list the
 * assets in this folder' endpoint?" — resolved to yes, with no backend
 * change needed: GET /projects/{id}/assets takes folder_id and recursive,
 * and returns each asset's filename, byte size and processing status in one
 * response (apps/api/routers/assets.py).
 */
async function freeframeSourceFiles(projectId, folderId, recursive) {
  if (!projectId) throw new Error("A project is required");
  const assets = await freeframe.listAssets(projectId, { folderId, recursive });

  const files = [];
  const skipped = [];
  const usedNames = new Set();

  for (const asset of assets || []) {
    const version = asset.latest_version;
    const media = version && version.files && version.files[0];

    // A version still transcoding has no downloadable original yet — the
    // stream endpoint returns 409 for it. Skipping it up front with a
    // reason beats a mid-job error per file.
    if (!media) { skipped.push({ name: asset.name, reason: "no file yet" }); continue; }
    if (version.processing_status && version.processing_status !== "ready") {
      skipped.push({ name: asset.name, reason: `still ${version.processing_status}` });
      continue;
    }

    // `?download=true` only resolves to the original upload for VIDEO.
    // get_stream_url's other branch (apps/api/routers/assets.py:376-380)
    // uses `s3_key_processed or s3_key_raw` even when download=true, so an
    // image or audio asset that has been processed serves the derivative —
    // a re-encoded JPEG, a compressed audio proxy — while
    // `file_size_bytes` still describes the original. Measured against the
    // live API: a 38.5 MB WAV came back as 1.2 MB, a 260 KB JPEG as 274 KB.
    //
    // Skipped with a reason rather than pulled. An offload tool that
    // quietly substitutes a proxy for the master, and reports success
    // because the proxy downloaded intact, is worse than one that says it
    // couldn't get the original. Lifting this needs a backend change — see
    // the note in README.md; nothing here can work around it, because the
    // original's bytes are simply not reachable through this endpoint.
    if (asset.asset_type !== "video" && media.s3_key_processed) {
      skipped.push({
        name: asset.name,
        reason: `only a processed derivative is downloadable for ${asset.asset_type} — the original isn't reachable via /stream?download=true`,
      });
      continue;
    }

    // Names come from other users' uploads, and land in path.join() against
    // a real destination root. A "../" in one would write outside the
    // destination entirely, so the name is reduced to its basename.
    let rel = path.basename(media.original_filename || asset.name || String(asset.id));
    if (!rel || rel === "." || rel === "..") rel = String(asset.id);

    // Two assets in one project may legitimately share a filename (a folder
    // structure is flattened by `recursive`). Silently letting the second
    // overwrite the first would lose footage and still report success.
    if (usedNames.has(rel)) {
      const ext = path.extname(rel);
      rel = `${path.basename(rel, ext)}-${String(asset.id).slice(0, 8)}${ext}`;
    }
    usedNames.add(rel);

    files.push({ rel, size: media.file_size_bytes || 0, assetId: asset.id });
  }

  files.__skipped = skipped;
  return files;
}

/**
 * The FreeFrame source provider handed to copy-engine.
 *
 * Built here rather than in copy-engine.js on purpose: it needs the API
 * client, which imports electron, and the engine is deliberately plain Node
 * so scripts/test-copy.js can drive it without booting a window.
 */
function freeframeSource(projectId, folderId) {
  let manifest = null;
  return {
    kind: "freeframe",
    label: `freeframe://${projectId}`,
    root: null,
    // Assets that exist but couldn't be pulled, with the reason. Read off
    // the provider after the job so the summary can say so — a job that
    // silently returns 3 of 5 files and calls itself verified is exactly
    // the outcome this app is supposed to make impossible.
    skipped: [],
    list: async function () {
      manifest = await freeframeSourceFiles(projectId, folderId, true);
      this.skipped = manifest.__skipped || [];
      return manifest.map((f) => ({ rel: f.rel, size: f.size }));
    },
    open: async (rel) => {
      const entry = (manifest || []).find((f) => f.rel === rel);
      if (!entry) throw new Error(`No asset for ${rel}`);
      return freeframe.openAssetStream(entry.assetId);
    },
  };
}

// Upload a whole source tree into a project as a destination.
//
// Deliberately NOT routed through runCopyJob: that engine is pure
// filesystem and electron-free by design, and a project isn't a path. It
// also can't be a cascade parent -- reading files back down from FreeFrame
// is explicitly out of scope for this pass, so nothing can copy *from* a
// project.
ipcMain.handle("freeframe:upload", async (event, { sourcePath, projectId, folderId } = {}) => {
  if (activeJob) throw new Error("A copy is already running");
  if (typeof sourcePath !== "string" || !projectId) throw new Error("Source and project are required");

  const webContents = event.sender;
  const send = (p) => { if (!webContents.isDestroyed()) webContents.send("copy:progress", p); };

  let cancelled = false;
  activeJob = { cancel: () => { cancelled = true; } };
  const startedAt = Date.now();

  try {
    const rel = await listFilesRecursive(sourcePath);
    let totalBytes = 0;
    const sizes = new Map();
    for (const r of rel) {
      const st = await fsp.stat(path.join(sourcePath, r));
      sizes.set(r, st.size);
      totalBytes += st.size;
    }

    send({ phase: "start", totalFiles: rel.length, totalBytes, legCount: 1, nodes: [] });

    const uploaded = [];
    const errors = [];
    let doneBytes = 0;

    for (const r of rel) {
      if (cancelled) break;
      send({ phase: "file-start", file: r, bytes: sizes.get(r) });
      try {
        const res = await freeframe.uploadFile({
          projectId,
          filePath: path.join(sourcePath, r),
          assetName: path.basename(r),
          folderId: folderId || null,
          onProgress: ({ uploaded: u }) => {
            const overall = doneBytes + u;
            send({
              phase: "bytes", file: r, copiedBytes: overall, totalBytes,
              percent: totalBytes > 0 ? Math.min(100, (overall / totalBytes) * 100) : 100,
            });
          },
        });
        uploaded.push(res);
        doneBytes += sizes.get(r) || 0;
        send({ phase: "file-done", file: r, ok: true, copiedBytes: doneBytes, totalBytes });
      } catch (err) {
        errors.push({ file: r, error: String(err.message || err) });
        send({ phase: "file-done", file: r, ok: false });
      }
    }

    const summary = {
      mode: "UPLOAD",
      algorithmLabel: "FreeFrame upload",
      sourcePath,
      nodes: [],
      destPaths: [`FreeFrame project ${projectId}`],
      cancelled,
      totalFiles: rel.length,
      filesCopied: uploaded.length,
      fileCopiesVerified: uploaded.length,
      totalFileCopies: rel.length,
      totalBytes,
      copiedBytes: doneBytes,
      legCount: 1,
      mismatches: [],
      errors,
      // Deliberately NOT claiming verification: the app has not re-read
      // these bytes back from FreeFrame and compared them. Post-upload
      // checksum verification is the roadmap's phase-1 requirement and is
      // NOT implemented here -- saying "verified" would be a lie about the
      // one thing this tool exists to prove.
      allVerified: false,
      uploadOnly: true,
      durationMs: Date.now() - startedAt,
      files: [],
    };
    send({ phase: "done", summary });
    return summary;
  } finally {
    activeJob = null;
  }
});

// Copy job. The renderer sends plain path strings; every filesystem
// operation happens here, in the main process, exactly like volumes:list.
//
// Progress is pushed on its own `copy:progress` channel rather than being
// returned by this handler, because `invoke` can only resolve once — the
// caller awaits the final summary while the UI updates from the stream.
ipcMain.handle("copy:start", async (event, payload) => {
  if (activeJob) {
    throw new Error("A copy is already running");
  }

  const sourcePath = typeof payload?.sourcePath === "string" ? payload.sourcePath : null;

  // The destination tree. Sanitized field-by-field rather than passed
  // through: the renderer is the untrusted side of this boundary by design
  // (it renders user-supplied volume names), and copy-engine.js takes raw
  // filesystem paths. Structural validity — cycles, missing parents,
  // nesting — is re-checked inside the engine, so a malformed tree can't
  // get through by going around this handler either.
  const nodes = Array.isArray(payload?.nodes)
    ? payload.nodes
        .filter((n) => n && typeof n.path === "string" && typeof n.id === "string")
        .map((n) => ({
          id: n.id,
          path: n.path,
          parentId: typeof n.parentId === "string" ? n.parentId : null,
        }))
    : [];

  if (!sourcePath) throw new Error("No source selected");
  if (nodes.length === 0) throw new Error("No destination selected");

  // Item 3 — a project as the source. The engine takes a source *provider*
  // rather than only a path, so this is a different kind of source, not a
  // download staged into a temp directory and copied from there.
  const projectSource = sourcePath.startsWith("freeframe://")
    ? freeframeSource(
        sourcePath.slice("freeframe://".length),
        typeof payload?.sourceFolderId === "string" ? payload.sourceFolderId : null
      )
    : null;
  if (projectSource && nodes.some((n) => n.path.startsWith("freeframe://"))) {
    throw new Error("A project can't be both the source and a destination of one job");
  }

  // Validated rather than passed through: an unknown name would otherwise
  // surface as a mid-copy throw after files had already been written.
  const algorithm = isSupported(payload?.algorithm) ? payload.algorithm : DEFAULT_ALGORITHM;

  const webContents = event.sender;
  let cancelled = false;
  activeJob = { cancel: () => { cancelled = true; } };

  try {
    const summary = await runCopyJob({
      sourcePath,
      source: projectSource,
      nodes,
      algorithm,
      isCancelled: () => cancelled,
      onProgress: (p) => {
        // The window can be closed mid-copy; sending to a destroyed
        // webContents throws and would abort an otherwise fine job.
        if (!webContents.isDestroyed()) webContents.send("copy:progress", p);
      },
    });
    // Assets deliberately left out of the job travel with the summary, so
    // "everything verified" can never be read as "everything came down".
    if (projectSource && projectSource.skipped.length) {
      summary.skippedAssets = projectSource.skipped;
    }
    return summary;
  } finally {
    activeJob = null;
  }
});

ipcMain.handle("copy:cancel", async () => {
  if (activeJob) activeJob.cancel();
  return { cancelling: Boolean(activeJob) };
});

// Lets a user pick any folder as a source or destination, not just a
// mounted volume root — offloading into a dated subfolder on a big drive is
// the normal case, not the exception. The native dialog is also the
// mechanism that triggers macOS's own file-access permission prompt for a
// location the app hasn't been granted yet.
// ── Item 6: recent folder per device ──
// A small JSON file in userData rather than in-memory: the point is that
// re-selecting yesterday's destination doesn't mean browsing to it again,
// and that only pays off across restarts. Keyed by mountPoint, which is
// stable for the life of a mount; a drive that comes back under a
// different /Volumes name simply has no memory yet, which is correct
// rather than wrong.
//
// Recents are kept **per device AND per role**: { mountPoint: { source: [],
// destination: [] } }. One shared value per device was actively wrong, not
// just limited — the last folder picked for either role overwrote the
// other's memory, so a drive whose source was "PROG" and destination was
// "Prints" offered "Prints" under both labels.
function recentsFile() {
  return path.join(app.getPath("userData"), "recent-folders.json");
}

const RECENT_ROLES = ["source", "destination"];
const RECENTS_PER_ROLE = 5;

/**
 * Coerce whatever is on disk into the current shape.
 *
 * The legacy `{ mountPoint: "/some/folder" }` form is **dropped**, not
 * migrated. That value was "the last folder used for either role" — which
 * role is unrecoverable, and copying it into both slots would reproduce on
 * first launch exactly the duplicated "Source: Prints / Destination:
 * Prints" listing this change exists to fix. One-time loss of a
 * convenience, in exchange for never showing a folder under a role it was
 * never used for.
 */
function normalizeRecents(raw) {
  const out = {};
  for (const [device, value] of Object.entries(raw || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = {};
    for (const role of RECENT_ROLES) {
      const v = value[role];
      // A single string is the intermediate two-slot shape; both it and a
      // list normalize to a list.
      const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
      const clean = list.filter((f) => typeof f === "string" && f).slice(0, RECENTS_PER_ROLE);
      if (clean.length) entry[role] = clean;
    }
    if (entry.source || entry.destination) out[device] = entry;
  }
  return out;
}

async function readRecents() {
  try {
    return normalizeRecents(JSON.parse(await fsp.readFile(recentsFile(), "utf8")));
  } catch {
    return {};
  }
}

async function writeRecents(recents) {
  try {
    await fsp.mkdir(path.dirname(recentsFile()), { recursive: true });
    await fsp.writeFile(recentsFile(), JSON.stringify(recents, null, 2));
  } catch {
    // Losing the convenience of a remembered folder must never break the
    // actual assignment the user just made.
  }
  return recents;
}

ipcMain.handle("recent-folders:get", async () => readRecents());

ipcMain.handle("recent-folders:remember", async (_event, { device, role, folder } = {}) => {
  const recents = await readRecents();
  // The role is required. Guessing one would put a folder under a heading
  // it was never used for, which is the bug being fixed.
  if (!RECENT_ROLES.includes(role)) return recents;
  if (typeof device !== "string" || typeof folder !== "string" || !device || !folder) return recents;

  const entry = recents[device] || (recents[device] = {});
  // Re-picking a folder promotes it rather than duplicating it.
  entry[role] = [folder, ...(entry[role] || []).filter((f) => f !== folder)].slice(0, RECENTS_PER_ROLE);
  return writeRecents(recents);
});

// Clears one role's list on one device — the scope of the submenu the
// "Clear Recents" item sits in. Deliberately not global: nothing in that
// submenu suggests it would wipe the other role, or other drives.
ipcMain.handle("recent-folders:clear", async (_event, { device, role } = {}) => {
  const recents = await readRecents();
  if (!RECENT_ROLES.includes(role) || typeof device !== "string") return recents;
  if (recents[device]) {
    delete recents[device][role];
    if (!recents[device].source && !recents[device].destination) delete recents[device];
  }
  return writeRecents(recents);
});

// ── Item 8: cosmetic display-name override ──
// Renames how a card is LABELLED in this app only. It never touches the
// real volume or folder name on disk — that would be a destructive
// filesystem operation dressed up as a UI convenience. The full
// operator/talent/camera metadata-preset system that drives folder naming
// at copy time is a separate, much larger roadmap item (§10) and is
// deliberately not this.
//
// Persisted the same way recent folders are, keyed by mountPoint.
function namesFile() {
  return path.join(app.getPath("userData"), "display-names.json");
}

async function readNames() {
  try {
    return JSON.parse(await fsp.readFile(namesFile(), "utf8"));
  } catch {
    return {};
  }
}

ipcMain.handle("display-names:get", async () => readNames());

ipcMain.handle("display-names:set", async (_event, { mountPoint, name } = {}) => {
  if (typeof mountPoint !== "string" || !mountPoint) return {};
  const names = await readNames();
  const trimmed = typeof name === "string" ? name.trim().slice(0, 120) : "";
  // Empty clears the override and falls back to the real name, so there's
  // always a way back without hunting for a settings file.
  if (trimmed) names[mountPoint] = trimmed;
  else delete names[mountPoint];
  try {
    await fsp.mkdir(path.dirname(namesFile()), { recursive: true });
    await fsp.writeFile(namesFile(), JSON.stringify(names, null, 2));
  } catch {
    /* a cosmetic label failing to persist must not break the assignment */
  }
  return names;
});

ipcMain.handle("dialog:choose-folder", async (_event, { title, defaultPath } = {}) => {
  const options = {
    title: title || "Choose folder",
    properties: ["openDirectory", "createDirectory"],
  };
  // Roots the dialog inside a specific device. Without this, picking
  // "DAY_01" while offloading three cards at once gives no way to tell
  // which drive that folder is actually on.
  if (typeof defaultPath === "string" && defaultPath) {
    // Only if it still exists — a stale path makes the native dialog open
    // somewhere arbitrary rather than erroring, which is worse than just
    // falling back to the default location.
    try {
      const st = await fsp.stat(defaultPath);
      if (st.isDirectory()) options.defaultPath = defaultPath;
    } catch { /* fall through to the system default */ }
  }
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(async () => {
  createWindow();
  startVolumeWatcher();
  // Restores a previous session from the OS keychain, if there is one.
  await freeframe.loadSession().catch(() => {});

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  clearTimeout(volumeDebounce);
  volumeWatcher?.close();
  volumeWatcher = null;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
