const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { listVolumes } = require("./volumes");
const { runCopyJob } = require("./copy-engine");
const presets = require("./presets");
const settings = require("./settings");
const journal = require("./job-journal");
const dailyOverview = require("./daily-overview");
const webview = require("./webview");
const { buildRelMapper, unknownTokens, folderPatternError, rendersNewFileNames, omitTokens, tokensIn } = require("./naming");
const { normalizeFilters, wantsFlatten } = require("./filters");
const { JobQueue } = require("./job-queue");
const { listAlgorithms, isSupported, DEFAULT_ALGORITHM } = require("./hashers");
const freeframe = require("./freeframe");
const { listFilesRecursive } = require("./copy-engine");

const execFileAsync = promisify(execFile);

let mainWindow = null;
// The detached progress panel, when the user has popped it out (§18c).
let panelWindow = null;
// §61 — Settings is a real window now, not an in-page modal.
let settingsWindow = null;

// §18c replaced the single `activeJob` with a real queue. Jobs run
// concurrently when their chosen modes permit it; see job-queue.js for
// the rule. `activeJob` is gone -- anything that needs "is anything
// running" asks the queue.
let jobs = new JobQueue({
  run: (job) => job.payload.run(job),
  onChange: () => broadcastJobs(),
  onFinish: (job) => {
    writeJobLog(job).catch(() => {});
    // §72 — the same completion point, one write per finished job.
    recordDailyOverview(job).catch(() => {});
    // §87 — the journal existed to survive a job that never reached here.
    // It did, so the real log above is the permanent record and the
    // duplicate goes.
    //
    // ONLY for a job that actually completed. A cancelled or failed one
    // keeps its journal: "how far did we get" is the same question whether
    // the job was stopped deliberately or by a pulled cable, and a later
    // phase should not have to tell those apart. The in-memory handle is
    // released either way, or a long-lived app would hold every job it
    // ever ran.
    if (job.status === "done") journal.finishJournal(LOG_DIR(), job.id).catch(() => {});
    else journal.releaseJournal(job.id);
  },
});

// ── Transfer logs (§18c) ──────────────────────────────────────────────
//
// runCopyJob's summary already carries everything a log needs — per-file
// results, mismatches, errors, timing, the verification verdict — it was
// simply never written anywhere. Nothing in this app persisted a log
// before this.
//
// NOT ASC MHL. That is a separate, still-unbuilt XML checksum manifest
// meant to be re-verified by other tools (§1). This is a plain readable
// record of what one job did, for a human opening it afterwards.
const LOG_DIR = () => path.join(app.getPath("userData"), "logs");

function stampFor(ms) {
  const d = new Date(ms || Date.now());
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * §84 — the transfer log, human-readable part first.
 *
 * "Open Log" calls shell.openPath(): this file IS the viewer, opened in
 * whatever macOS hands a .json to. So the order of the keys is the order
 * someone reads, and hashes and IDs at the top meant the answer to "did my
 * card copy, and what are the files called now" was several screens down.
 *
 * `readable` is a view, not new truth — every value in it is derived from
 * `technical`, which keeps everything the file carried before, unchanged.
 * Nothing was removed.
 *
 * Version bumped to 2: the two top-level keys this file used to have
 * (`job`, `summary`) both moved under `technical`, so anything reading
 * them by path breaks. A reader that checks the version now finds out,
 * rather than silently seeing undefined.
 */
function buildJobLog(job) {
  const technical = {
    job: {
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      concurrencyMode: job.mode,
      source: job.sourceLabel,
      destinations: job.destPaths && job.destPaths.length ? job.destPaths : job.destLabels,
      createdAt: new Date(job.createdAt).toISOString(),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      durationMs: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null,
      error: job.error || null,
    },
    summary: job.summary || null,
  };

  const nodes = (job.summary && job.summary.nodes) || [];
  // Every file, per destination, source name beside the name it landed as.
  const files = [];
  for (const n of nodes) {
    for (const f of n.files || []) {
      const from = path.basename(f.file || "");
      // null when the write never happened — a file that errored before a
      // destination path existed. Reported as such rather than as a rename.
      const to = f.destPath ? path.basename(f.destPath) : null;
      files.push({
        destination: n.path,
        from,
        to,
        renamed: Boolean(to) && to !== from,
        verified: Boolean(f.ok),
        sourcePath: f.file,
        destPath: f.destPath || null,
      });
    }
  }

  const fin = (job.summary && job.summary.finalized) || null;
  const failed = files.filter((f) => !f.verified);
  // A card is only safe to wipe if EVERY destination verified. Stated as a
  // sentence as well as a boolean, because the sentence is the reason
  // anyone opens this file.
  //
  // `failed.length === 0` is belt AND braces on top of the node statuses,
  // deliberately: a node reporting "verified" while one of its own files
  // reports ok:false should never be reachable, but if it ever is, this
  // line is the one that says "your footage is safe, erase the card". It
  // must not be able to contradict the list printed directly beneath it.
  const allVerified = nodes.length > 0
    && job.status === "done"
    && nodes.every((n) => n.status === "verified")
    && failed.length === 0
    // §86 — a finalized pass that ran and found a mismatch is the STRONGER
    // signal, so it has to be able to veto. It reads the source again from
    // disk; the live check could not tell a corrupted read from a good one
    // because both ends came from the same read. Not running is not a veto.
    && !(fin && !fin.skipped && !fin.ok);

  return {
    freeframeTransferLog: 2,
    readable: {
      job: job.label || job.id,
      status: job.status,
      source: job.sourceLabel,
      destinations: technical.job.destinations,
      finished: technical.job.finishedAt,
      safeToWipeCard: allVerified,
      verdict: allVerified
        ? "Every file was copied and verified on every destination. The card can be wiped."
        : "NOT every file verified — do not wipe the card. See notVerified below.",
      fileCount: files.length,
      renamedCount: files.filter((f) => f.renamed).length,
      // §86 — its own labelled line, never folded into the live numbers.
      // "42/42 verified" means nothing unless you can tell which pass and
      // which algorithm produced it.
      finalizedChecksum: fin
        ? (fin.skipped
            ? `Not run — ${fin.reason}.`
            : `${fin.algorithmLabel}: ${fin.verified}/${fin.checked} verified`
              + (fin.mismatches.length ? `, ${fin.mismatches.length} MISMATCHED` : "")
              + (fin.errors.length ? `, ${fin.errors.length} error(s)` : "")
              + (fin.cancelled ? " (cancelled part-way)" : ""))
        : "Off",
      // Listed first and separately, so a problem is not something you have
      // to notice by scanning a long list of successes.
      notVerified: failed.map((f) => ({ destination: f.destination, from: f.from, to: f.to })),
      files: files.map((f) => ({
        from: f.from, to: f.to, renamed: f.renamed,
        verified: f.verified, destination: f.destination,
      })),
    },
    technical,
  };
}

/**
 * §72 — fold one finished job into the daily overview.
 *
 * Shares `onFinish` with the transfer log because they answer different
 * questions about the same event: the log is this job, the overview is
 * this card's day. Best-effort on purpose — a copy that verified must not
 * be reported as failed because an aggregate file would not write.
 *
 * A card is identified by the number the naming card claimed (§71) when
 * there was one, and by its source folder name otherwise. A plain copy
 * still appears; it just has no number.
 */
async function recordDailyOverview(job) {
  if (job.status !== "done" || !job.summary) return;
  const s = job.summary;
  // An upload has verified nothing (§18-era wording, kept honest here):
  // its "verified" count is the upload call returning, not a re-read.
  const verified = s.uploadOnly
    ? false
    : Boolean(s.allVerified) && !s.mismatches?.length && !s.errors?.length;
  const { dayBoundary } = await settings.readSettings();
  await dailyOverview.recordJob({
    // Keyed by the source, labelled by the number — see foldJob for why
    // those cannot be the same thing once §71 claims a number per job.
    key: job.sourcePath || job.sourceLabel || job.label || "Unknown",
    label: job.cardNumber != null ? String(job.cardNumber) : (path.basename(job.sourceLabel || "") || job.label || "Unknown"),
    isNamedCard: job.cardNumber != null,
    completedAt: job.finishedAt || Date.now(),
    files: s.totalFiles || 0,
    bytes: s.copiedBytes || 0,
    verifiedFiles: s.fileCopiesVerified || 0,
    totalFileCopies: s.totalFileCopies || 0,
    verified,
  }, dayBoundary);
  broadcast("daily-overview:changed");
}

/**
 * Write one job's log. The copy under userData always happens; copies
 * beside the footage are best-effort.
 *
 * The destination copies go in a "FreeFrame Logs" subfolder rather than
 * loose in the destination root: the root is frequently a card offload
 * that someone later uses as a SOURCE, and a stray .json at its top level
 * would then be copied onward as if it were footage.
 */
async function writeJobLog(job) {
  if (job.status === "queued" || job.status === "running") return;

  const body = JSON.stringify(buildJobLog(job), null, 2);
  const name = `${stampFor(job.finishedAt)}_${(job.label || "transfer").replace(/[^\w.-]+/g, "_")}.json`;

  await fsp.mkdir(LOG_DIR(), { recursive: true });
  const local = path.join(LOG_DIR(), `${job.id}.json`);
  await fsp.writeFile(local, body, "utf8");
  job.logPath = local;
  broadcastJobs();

  for (const dest of job.destPaths || []) {
    if (!dest || dest.startsWith("freeframe://")) continue;
    try {
      const dir = path.join(dest, "FreeFrame Logs");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, name), body, "utf8");
    } catch {
      // A full or read-only destination must not turn a completed copy
      // into a reported failure. The userData copy above already exists.
    }
  }
}

/** Every window that should see job state. The docked panel and the
 *  detached window render from the same broadcast, so they cannot
 *  disagree about what is running. */
function broadcastJobs() {
  const snapshot = jobs ? jobs.snapshot() : [];
  for (const w of [mainWindow, panelWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send("jobs:changed", snapshot);
  }
}

/**
 * Which physical volume a path belongs to.
 *
 * The concurrency modes talk about sharing a *drive*, not a path, so
 * "/Volumes/CARD/DCIM" and "/Volumes/CARD" must resolve to the same key.
 * A FreeFrame project is its own key -- it isn't a mount, but two jobs
 * touching one project genuinely do share a target.
 *
 * `volumes` is passed in so one listVolumes() call serves a whole
 * enqueue; it shells out to diskutil and is far too slow to call per
 * path.
 */
function volumeKeyOf(p, volumes) {
  if (typeof p !== "string" || !p) return null;
  if (p.startsWith("freeframe://")) return p;
  let best = null;
  for (const v of volumes) {
    if (p === v.mountPoint || p.startsWith(v.mountPoint + path.sep)) {
      if (!best || v.mountPoint.length > best.length) best = v.mountPoint;
    }
  }
  // Not under /Volumes at all (a temp dir, the home folder) -- the boot
  // volume. Using "/" keeps those jobs sharing one key, which is true.
  return best || path.parse(p).root || p;
}

// ── Live volume detection ──
// Mounting or ejecting a disk fires several fs events in quick succession
// (the directory entry appearing, then metadata settling), so a raw watcher
// would push 3-5 refreshes for one physical action. Debounced to one.
const VOLUME_DEBOUNCE_MS = 300;
let volumeWatcher = null;
let volumeDebounce = null;

// Last known volume list, kept so that submitting a job doesn't have to
// wait on diskutil.
//
// This is not an optimisation. listVolumes() shells out to `diskutil`
// once per mounted volume, and a network share can make that take over a
// second. Deriving a job's concurrency keys from a fresh call meant the
// job did not exist -- not queued, not in the panel, not cancellable --
// for that whole window. Pressing Start and seeing nothing happen is
// exactly the failure the job panel was added to remove.
//
// Volume identity is also the slowest-changing thing in this app: it
// only changes when a drive is plugged in or ejected, which is precisely
// what the watcher below already notices.
let cachedVolumes = [];

async function volumesForKeys() {
  // Cold start only: the renderer populates this via volumes:list on
  // load, so in practice this await never happens for a real job.
  if (!cachedVolumes.length) {
    cachedVolumes = await listVolumes().catch(() => []);
  }
  return cachedVolumes;
}

function startVolumeWatcher() {
  if (volumeWatcher) return;
  try {
    volumeWatcher = fs.watch("/Volumes", () => {
      clearTimeout(volumeDebounce);
      volumeDebounce = setTimeout(() => {
        // Refresh the cache here rather than waiting for the renderer to
        // ask: a job submitted right after a drive is plugged in should
        // key off the drive that is actually there now.
        listVolumes().then((v) => { cachedVolumes = v; }).catch(() => {});
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
    // §25a — the floor matches the launch size. Below this the header
    // pills and column-head buttons had nowhere to go, so the window could
    // be dragged into a state nothing was laid out for.
    minWidth: 960,
    minHeight: 640,
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
  const v = await listVolumes();
  cachedVolumes = v;
  return v;
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

  // Ejecting mid-copy would corrupt the transfer. With a queue this can be
  // asked precisely -- is any live job touching THIS volume -- so a job
  // copying an unrelated card no longer blocks ejecting this one. That was
  // the old behaviour and it was needlessly broad: with several jobs in
  // flight it would have made eject useless.
  //
  // QUEUED jobs count, not just running ones. A queued job has already been
  // told which volumes it will read and write; ejecting one out from under
  // it means it starts later and immediately fails on a path that no longer
  // exists. From the user's side that is the same accident the guard exists
  // to prevent, and it is no less likely now that jobs can wait.
  const busy = [...jobs.running, ...jobs.queued].find(
    (j) => j.sourceKey === mountPoint || (j.destKeys || []).includes(mountPoint),
  );
  if (busy) {
    const verbing = busy.status === "queued" ? "is queued to copy" : "is still copying";
    return {
      ok: false,
      error: `A copy is in progress: "${busy.label}" ${verbing} to or from this volume — cancel it before ejecting.`,
    };
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

// ── Naming presets (§10 / §18b) ──
// Local only: one JSON file in userData, no login, no server. Everything
// here is preferences-shaped, so a failure returns a value rather than
// throwing — a broken preferences file must never block a copy.
// §58 — app settings. Read on startup by the renderer to pre-select the
// per-job checksum picker; the per-job override is untouched.
ipcMain.handle("settings:get", async () => settings.readSettings());
ipcMain.handle("settings:set", async (_e, { patch } = {}) => {
  const next = await settings.writeSettings(patch || {});
  // The hide list is edited in the Settings window and applied by the main
  // window's Volumes column — two windows now, so this cannot stay a local
  // re-render.
  broadcast("settings:changed", next);
  return next;
});
ipcMain.handle("settings:open-logs", async () => {
  // The same directory job logs are written to (LOG_DIR), created first so
  // opening it before any job has run shows an empty folder rather than
  // failing silently.
  const dir = LOG_DIR();
  await fsp.mkdir(dir, { recursive: true });
  const error = await shell.openPath(dir);
  return { ok: !error, error: error || null, path: dir };
});

// ── Settings window (§61) ────────────────────────────────────────────────
//
// Settings used to be a modal inside index.html. It is a real BrowserWindow
// now, following the detached job panel's precedent exactly: its own HTML
// file, the same preload, singleton (focus rather than duplicate).
//
// Moving it out of the main window means a change made in one window has to
// reach the other, which a modal never had to do. Both stores broadcast to
// every window rather than the settings window telling the main window what
// to do — same shape as `jobs:changed`, and it keeps the settings window
// from needing any knowledge of what the main window does with the news.
function broadcast(channel, payload) {
  for (const w of [mainWindow, panelWindow, settingsWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

ipcMain.handle("settings:open", async (_e, { tab } = {}) => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    // Focusing an already-open window is not enough when the caller asked
    // for a specific section — "Manage presets…" has to land on the
    // presets tab whether or not the window was already up.
    if (tab) settingsWindow.webContents.send("settings:tab", tab);
    return { ok: true };
  }
  settingsWindow = new BrowserWindow({
    width: 780, height: 620,
    minWidth: 620, minHeight: 460,
    title: "Settings",
    // Deliberately NOT `parent: mainWindow`: the point of a real window is
    // that it sits beside the main one and can be moved independently. A
    // parented window is always on top of it, which is a modal with extra
    // steps.
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  settingsWindow.loadFile(path.join(__dirname, "..", "renderer", "settings.html"));
  if (tab) {
    settingsWindow.webContents.once("did-finish-load", () => {
      settingsWindow.webContents.send("settings:tab", tab);
    });
  }
  settingsWindow.on("closed", () => { settingsWindow = null; });
  return { ok: true };
});

// ── Embedded FreeFrame web view (§60b) ───────────────────────────────────

ipcMain.handle("webview:show", async (_e, { top } = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "No window" };
  // The session is read fresh on every show, not cached at startup: the
  // access token is short-lived and deliberately never persisted, so a
  // cold launch has nothing to inject until webSession() mints one.
  const session = await freeframe.webSession();
  return webview.show(mainWindow, session, top);
});

ipcMain.handle("webview:hide", async () => webview.hide());
ipcMain.handle("webview:inset", async (_e, { top } = {}) => webview.setInset(top));
// §64 — Refresh on the FreeFrame page reloads the embedded app rather than
// re-listing drives the page is not showing.
ipcMain.handle("webview:reload", async () => webview.reload());
ipcMain.handle("app:info", async () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  logsPath: LOG_DIR(),
}));

ipcMain.handle("presets:list", async () => presets.list());
/**
 * §65c — is this folder pattern allowed? Exposed rather than reimplemented
 * in the renderer: the editor and the engine must refuse the same patterns
 * for the same reason, and two copies of one rule is the drift this project
 * keeps paying for (§30, §32, §61).
 */
ipcMain.handle("presets:validate-folder", async (_e, { folderTemplate } = {}) =>
  ({ error: folderPatternError(folderTemplate) }));

// ── Daily overview (§72) ─────────────────────────────────────────────────

/** Today's LOGICAL day, per the configured boundary. Computed in main so
 *  the panel, the reset and the export can never disagree about which day
 *  they are talking about. */
async function currentDayKey() {
  const { dayBoundary } = await settings.readSettings();
  return { dayKey: dailyOverview.dayKeyFor(Date.now(), dayBoundary), dayBoundary };
}

ipcMain.handle("daily:get", async () => {
  const { dayKey, dayBoundary } = await currentDayKey();
  return { dayBoundary, day: await dailyOverview.forDay(dayKey) };
});

ipcMain.handle("daily:reset", async () => {
  const { dayKey, dayBoundary } = await currentDayKey();
  const day = await dailyOverview.resetDay(dayKey);
  broadcast("daily-overview:changed");
  return { dayBoundary, day };
});

/** CSV into the same folder "Open Logs Folder" already opens (§72) —
 *  a second export location would be one more place to go looking. */
ipcMain.handle("daily:export", async () => {
  const { dayKey } = await currentDayKey();
  const day = await dailyOverview.forDay(dayKey);
  const dir = LOG_DIR();
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `daily-overview-${dayKey}.csv`);
  try {
    await fsp.writeFile(file, dailyOverview.toCsv(day), "utf8");
    return { ok: true, path: file, cards: day.cards.length };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/** §71 — whether a job with this file pattern would rename anything. Same
 *  function copy:start uses for the §23d guard. */
ipcMain.handle("presets:renames-files", async (_e, { fileTemplate, disabled } = {}) =>
  ({ renames: rendersNewFileNames(fileTemplate, Array.isArray(disabled) ? disabled : []) }));

ipcMain.handle("presets:save", async (_e, { preset } = {}) => {
  const out = await presets.save(preset || {});
  broadcast("presets:changed");
  return out;
});
ipcMain.handle("presets:delete", async (_e, { id } = {}) => {
  const out = await presets.remove(id);
  broadcast("presets:changed");
  return out;
});

// §22h — the source counter. Claimed when a source is assigned, so the
// number identifies the card rather than the job: cancelling or re-running
// must not advance it, and adding a second card must.
ipcMain.handle("presets:bump-source-counter", async () => presets.bumpSourceCounter());
ipcMain.handle("presets:set-source-counter", async (_e, { value } = {}) => {
  const out = await presets.setSourceCounter(value);
  broadcast("presets:changed");
  return out;
});

/**
 * Preview what a template will produce, for the editor's live example.
 *
 * Rendered by the same code the copy will use rather than a
 * lookalike — a preview that agrees with a separate implementation is
 * worse than no preview, because it builds confidence in the wrong thing.
 */
/** §81 — the built-ins that make a Date row worth showing, and the ones
 *  that make a Time row worth showing. Case matters: {MM} is the month,
 *  {mm} is minutes (§65). */
const DATE_TOKENS = new Set(["date", "YYYY", "YY", "MM", "DD"]);
const TIME_TOKENS = new Set(["hh", "mm"]);

/**
 * §78 — the date a job renders its date tokens from.
 *
 * The renderer is the untrusted side of this boundary (see the note at the
 * real job's own call), and this ends up in folder names on someone's
 * drive. Anything unparseable falls back to the live clock rather than
 * throwing: a job refusing to start because a date field held junk would be
 * a worse failure than simply using today, which is what every job did
 * before this existed.
 */
function resolveNow(raw) {
  if (raw == null || raw === "") return new Date();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

ipcMain.handle("presets:preview", async (_e, { folderTemplate, fileTemplate, values, sourceLabel, disabled, autoSuffix, dateOverride } = {}) => {
  try {
    // §22g — the preview has to show what a disabled field actually does
    // to the name, or the panel would promise something the job won't do.
    const off = Array.isArray(disabled) ? disabled : [];
    const folderTpl = omitTokens(folderTemplate, off);
    const fileTpl = omitTokens(fileTemplate, off);
    // §77/§78 — the preview runs the same mapper the job will, with the
    // same suffix rule and the same clock. A preview that agrees with a
    // different configuration than the job is the failure this handler's
    // own header warns about, just one level further in.
    const suffix = presets.normalizeAutoSuffix(autoSuffix);
    const mapper = buildRelMapper({
      folderTemplate: folderTpl,
      fileTemplate: fileTpl,
      values: values || {},
      sourceLabel: sourceLabel || "/Volumes/A001",
      autoSuffixSource: suffix.source,
      autoSuffixPosition: suffix.position,
      now: resolveNow(dateOverride),
    });
    const sample = "DCIM/100MEDIA/CLIP0001.MOV";
    const result = mapper ? mapper(sample) : sample;

    // §65.8 — two scoped previews instead of one full path. The old preview
    // showed `DCIM/100MEDIA/` in the middle, which is the source's own
    // subtree: preserved by design, not produced by either template, and
    // confirmed confusing to read as though the pattern had made it.
    //
    // Rendered by walking the same mapper's own output rather than
    // re-implementing the templates here, so the preview cannot disagree
    // with what the copy will do.
    // Derived by stripping the preserved subtree off the mapper's own
    // output, NOT by re-rendering the template here — a preview computed by
    // a second implementation is worse than none, because it builds
    // confidence in the wrong thing.
    const fileOut = path.basename(result);
    const keptDir = path.dirname(sample);            // "DCIM/100MEDIA"
    let folderOut = path.dirname(result);
    if (folderOut === ".") folderOut = "";
    if (keptDir !== "." && folderOut.endsWith(keptDir)) {
      folderOut = folderOut.slice(0, folderOut.length - keptDir.length).replace(/\/+$/, "");
    }
    return {
      ok: true,
      sample,
      result,
      folder: folderOut,
      file: fileOut,
      // Whether the file name carries a suffix the user did not write
      // (§65.5/.9), so the preview can mark it rather than let it surprise.
      autoCounter: Boolean(mapper && mapper.autoCounter),
      // §81 — which kinds of token the patterns actually use, so the
      // renderer can hide the Date and Time rows for a preset that renders
      // neither. Answered here because tokensIn() lives here; a regex in
      // the renderer would be a second implementation of the tokenizer,
      // and the two would drift the first time the syntax changed.
      //
      // Read off the STRIPPED templates, which is what actually renders.
      usesDate: [folderTpl, fileTpl].some((t) => tokensIn(t).some((k) => DATE_TOKENS.has(k))),
      usesTime: [folderTpl, fileTpl].some((t) => tokensIn(t).some((k) => TIME_TOKENS.has(k))),
      // §77 — WHAT that suffix is and WHERE it sits, reported rather than
      // left for the renderer to find with a regex. It used to look for
      // four digits at the end, which stops matching the moment the suffix
      // is a filename or moves to the front: the amber marking would
      // silently disappear and auto-inserted text would blend in as though
      // the user had written it.
      autoSuffix: mapper && mapper.autoCounter
        ? { source: suffix.source, position: suffix.position,
            value: suffix.source === "filename"
              ? path.basename(sample, path.extname(sample))
              : "0001" }
        : null,
    };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
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
    const res = await freeframe.login({ email, password, baseUrl });
    // §64 — login moved into the Settings window, so the main window can no
    // longer learn about it by having run the form itself.
    if (res && res.ok) broadcast("account:changed", freeframe.status());
    return res;
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

// Logging out of the desktop app also destroys the embedded web view —
// see webview.js's destroy() for why this direction is synced and the
// other deliberately is not.
ipcMain.handle("freeframe:logout", async () => {
  webview.destroy();
  await freeframe.clearSession();
  const st = freeframe.status();
  broadcast("account:changed", st);
  return st;
});
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
ipcMain.handle("freeframe:upload", async (event, { sourcePath, sourceFiles, projectId, folderId, concurrencyMode } = {}) => {
  const pickedFiles = Array.isArray(sourceFiles) ? sourceFiles.filter((p) => typeof p === "string" && p) : [];
  if ((typeof sourcePath !== "string" && !pickedFiles.length) || !projectId) {
    throw new Error("Source and project are required");
  }

  // Uploads share the queue with local copies (§18c: "one unified list"
  // covering every job type), so a card offloading to a RAID and one
  // uploading to a project are scheduled against each other by the same
  // rule rather than each pretending it's the only thing happening.
  const volumes = await volumesForKeys();
  const { settled } = jobs.add({
    id: crypto.randomUUID(),
    kind: "upload",
    mode: concurrencyMode,
    label: path.basename(sourcePath || pickedFiles[0] || "Upload") || "Upload",
    sourceLabel: sourcePath || `${pickedFiles.length} files`,
    destLabels: [`FreeFrame project`],
    sourceKey: volumeKeyOf(sourcePath || pickedFiles[0], volumes),
    destKeys: [`freeframe://${projectId}`],
    payload: { run: (self) => runUpload(self) },
  });

  const result = await settled;
  if (result && result.failed) throw new Error(result.error);
  return result;

  async function runUpload(self) {
  let cancelled = false;
  self._cancel = () => { cancelled = true; };
  const send = (p) => {
    // The enriched object, so the docked footer gets the same speed/ETA the
    // jobs panel does rather than a second, differently-computed one (§58).
    const enriched = jobs.updateProgress(self.id, p) || p;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("copy:progress", enriched);
  };
  const startedAt = Date.now();

  try {
    // Either a directory to walk, or a set of individually-chosen files.
    // `fullPath` is what maps a display name back to bytes on disk in
    // both cases, so the loop below doesn't care which it was.
    const fullPath = new Map();
    let rel;
    if (pickedFiles.length) {
      rel = pickedFiles.map((f) => path.basename(f));
      pickedFiles.forEach((f, i) => fullPath.set(rel[i], f));
    } else {
      rel = await listFilesRecursive(sourcePath);
      for (const r of rel) fullPath.set(r, path.join(sourcePath, r));
    }

    let totalBytes = 0;
    const sizes = new Map();
    for (const r of rel) {
      const st = await fsp.stat(fullPath.get(r));
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
          filePath: fullPath.get(r),
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
      sourcePath: sourcePath || (pickedFiles.length === 1 ? pickedFiles[0] : `${pickedFiles.length} selected files`),
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
    self._cancel = null;
  }
  }
});

// Copy job. The renderer sends plain path strings; every filesystem
// operation happens here, in the main process, exactly like volumes:list.
//
// Progress is pushed on its own `copy:progress` channel rather than being
// returned by this handler, because `invoke` can only resolve once — the
// caller awaits the final summary while the UI updates from the stream.
ipcMain.handle("copy:start", async (event, payload) => {

  const sourcePath = typeof payload?.sourcePath === "string" ? payload.sourcePath : null;
  // Item 5 — a source can be individually-chosen files rather than a
  // directory to walk. Sanitized the same way `nodes` is: this is the
  // untrusted side of the boundary and these become real read paths.
  const sourceFiles = Array.isArray(payload?.sourceFiles)
    ? payload.sourceFiles.filter((p) => typeof p === "string" && p)
    : null;

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

  if (!sourcePath && !(sourceFiles && sourceFiles.length)) throw new Error("No source selected");
  if (nodes.length === 0) throw new Error("No destination selected");

  // Item 3 — a project as the source. The engine takes a source *provider*
  // rather than only a path, so this is a different kind of source, not a
  // download staged into a temp directory and copied from there.
  const projectSource = sourcePath && sourcePath.startsWith("freeframe://")
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

  // §86 — read at job start and captured for this job, the same way the
  // live algorithm is. Changing the setting mid-copy must not retune a
  // job already running.
  const jobSettings = await settings.readSettings();
  const finalizedAlgorithm = jobSettings.finalizedChecksumEnabled
    ? (isSupported(settings.finalizedAlgoFor(jobSettings))
        ? settings.finalizedAlgoFor(jobSettings)
        : DEFAULT_ALGORITHM)
    : null;

  // ── Naming template (§10 / §18b) ──
  //
  // Validated HERE, before a single byte moves. The renderer blocks the
  // Start button on the same rules, but that's a courtesy: the failure
  // this prevents is writing a folder literally named "{operator}" onto
  // someone's drive, which only looks wrong hours later — by which point
  // the card may already be back in the camera.
  const naming = payload?.naming && typeof payload.naming === "object" ? payload.naming : null;
  let mapRel = null;
  let filters = null;
  let renamesFiles = false;
  // An explicit, per-job acknowledgement (§23d) — never persisted, so the
  // next job asks again rather than a one-off decision quietly becoming a
  // permanent setting.
  const allowFragileRename = payload?.allowFragileRename === true;
  if (naming) {
    const values = naming.values && typeof naming.values === "object" ? naming.values : {};
    const fields = Array.isArray(naming.fields) ? naming.fields : [];

    // §22g — fields switched off for THIS transfer. Their tokens are
    // stripped from the templates rather than substituted with empty
    // strings, which would leave the separator behind and produce a folder
    // called "20260816_". Re-derived here rather than trusted as a
    // pre-stripped template, so the renderer cannot smuggle in a pattern
    // the validation below never saw.
    const disabled = Array.isArray(naming.disabledFields)
      ? naming.disabledFields.filter((k) => typeof k === "string" && k)
      : [];
    const folderTemplate = omitTokens(naming.folderTemplate, disabled);
    const fileTemplate = omitTokens(naming.fileTemplate, disabled);

    const off = new Set(disabled);
    const missing = fields
      .filter((f) => f && f.required && !off.has(f.key) && !String(values[f.key] ?? "").trim())
      .map((f) => f.label || f.key);
    if (missing.length) {
      throw new Error(
        `Fill in ${missing.join(", ")} before starting — ${missing.length === 1 ? "it is" : "they are"} used in the folder name.`,
      );
    }

    // §65c — a folder pattern that would create one folder per file is
    // refused here as well as in the editor. This is the defensive half:
    // a preset hand-edited on disk, or imported, never passed through the
    // editor's own check.
    const folderErr = folderPatternError(folderTemplate);
    if (folderErr) throw new Error(folderErr);

    // A token nothing can fill would otherwise render literally.
    for (const [label, tpl] of [["Folder name", folderTemplate], ["File name", fileTemplate]]) {
      const unknown = unknownTokens(tpl || "", Object.keys(values));
      if (unknown.length) {
        throw new Error(
          `${label} pattern uses ${unknown.map((t) => `{${t}}`).join(", ")}, which ${unknown.length === 1 ? "is not a" : "are not"} known field${unknown.length === 1 ? "" : "s"}.`,
        );
      }
    }

    // Re-normalized here rather than trusted: the renderer is the untrusted
    // side of this boundary, and these decide which files get copied.
    filters = normalizeFilters(naming.filters);
    // §71 — the same predicate the renderer asks before consuming a
    // {sourcecounter} value, so a job can never rename without advancing
    // the counter or advance it without renaming.
    renamesFiles = rendersNewFileNames(naming.fileTemplate, disabled);

    const jobSuffix = presets.normalizeAutoSuffix(naming.autoSuffix);
    mapRel = buildRelMapper({
      folderTemplate,
      fileTemplate,
      values,
      sourceLabel: sourcePath || (sourceFiles && sourceFiles[0]) || "",
      flatten: wantsFlatten(filters),
      // Clamped rather than trusted: the renderer holds the number claimed
      // when this source was assigned, and it ends up in a folder name.
      sourceCounter: presets.normalizeCounter(naming.sourceCounter),
      // §77 — re-normalized here for the same reason every other field on
      // this payload is: the renderer sent it, and it decides what every
      // file in this job is called.
      autoSuffixSource: jobSuffix.source,
      autoSuffixPosition: jobSuffix.position,
      // §78 — a manually-set date, or the live clock.
      now: resolveNow(naming.dateOverride),
    });
    // §65 — nothing is remembered from a job's values any more. The
    // Suggesting field type that consumed this history is gone.
  }

  // ── Queue it (§18c) ──
  //
  // Still resolves with the final summary, exactly as before queueing
  // existed: a caller awaits its own job and never has to know there is
  // a scheduler underneath. That contract is load-bearing -- the whole
  // existing e2e suite awaits startCopy().
  const volumes = await volumesForKeys();
  const destPathsForKeys = nodes.map((n) => n.path);

  const { job, settled } = jobs.add({
    id: crypto.randomUUID(),
    kind: projectSource ? "download" : "copy",
    mode: payload?.concurrencyMode,
    label: path.basename(sourcePath || (sourceFiles && sourceFiles[0]) || "Copy") || "Copy",
    sourceLabel: sourcePath || (sourceFiles ? `${sourceFiles.length} files` : ""),
    sourcePath: sourcePath || null,
    destLabels: destPathsForKeys.map((p) => path.basename(p) || p),
    destPaths: destPathsForKeys,
    sourceKey: volumeKeyOf(sourcePath || (sourceFiles && sourceFiles[0]), volumes),
    destKeys: Array.from(new Set(destPathsForKeys.map((p) => volumeKeyOf(p, volumes)).filter(Boolean))),
    // §72 — only when this job actually renamed, which is the same
    // condition §71 uses to claim the number in the first place. Without
    // that gate a plain copy would be filed under whatever stale counter
    // value happened to be in the payload.
    cardNumber: renamesFiles && naming ? presets.normalizeCounter(naming.sourceCounter) : null,
    payload: { run: async (self) => {
      let cancelled = false;
      self._cancel = () => { cancelled = true; };
      // §87 — opened here rather than at queue time: a job sitting in the
      // queue has copied nothing, and a journal for it would claim an
      // interrupted transfer that never started. Awaited so the file
      // exists before the first file-done can try to append to it.
      //
      // The naming state comes from the raw payload, not from the derived
      // mapRel: what a resume needs is the INPUT that produced the names
      // already on disk, so it can produce the same ones for the rest.
      await journal.startJournal(LOG_DIR(), self, {
        algorithm,
        finalizedAlgorithm,
        naming,
        sourceFiles,
      }).catch(() => {});
      const summary = await runCopyJob({
        sourcePath,
        sourceFiles,
        source: projectSource,
        nodes,
        algorithm,
        mapRel,
        filters,
        renamesFiles,
        allowFragileRename,
        finalizedAlgorithm,
        isCancelled: () => cancelled,
        onProgress: (p) => {
          // §87 — one append per finished file, so the file on disk is
          // never more than one file behind reality. Deliberately not
          // awaited: the copy must not wait on a log write, and a journal
          // that cannot be written is a lost resume, not a failed job.
          if (p.phase === "file-done") {
            journal.appendFileResult(self.id, p).catch(() => {});
          }
          // Enriched with speed/ETA (§58) before it goes anywhere, so both
          // listeners see one set of numbers rather than two.
          const enriched = jobs.updateProgress(self.id, p) || p;
          // The legacy single-job channel stays for now: the footer and
          // several existing tests still listen on it. The panel uses
          // jobs:changed instead.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("copy:progress", enriched);
          }
        },
      });
      if (projectSource && projectSource.skipped.length) {
        summary.skippedAssets = projectSource.skipped;
      }
      return summary;
    } },
  });

  const result = await settled;

  // The rename-fragility refusal (§23d) is RETURNED, not thrown. A thrown
  // Error crosses the IPC boundary as a message string with its `code`
  // stripped, and the renderer has to tell this apart from a disk failure:
  // this one is a question the user can answer ("proceed anyway?"), and
  // every other failure is not.
  if (result && result.failed && result.errorCode === "RENAME_FRAGILE") {
    return { blocked: "RENAME_FRAGILE", message: result.error, fragile: result.errorDetail || [] };
  }

  // A queued-then-cancelled job never ran; a failed one carries its
  // error. Both need to reach the awaiting caller as they did before.
  if (result && result.failed) throw new Error(result.error);
  return result;
});

ipcMain.handle("copy:cancel", async (_e, { id } = {}) => {
  // No id cancels everything, preserving what the old single-job Cancel
  // button meant when there was only ever one job to cancel.
  if (id) return { cancelling: jobs.cancel(id) };
  const n = jobs.running.length + jobs.queued.length;
  jobs.cancelAll();
  return { cancelling: n > 0 };
});

ipcMain.handle("jobs:list", async () => jobs.snapshot());
// §59 — history housekeeping. Both refuse anything still queued or
// running; the queue enforces that, not this handler, so the rule lives in
// one place and the detached window cannot route around it.
ipcMain.handle("jobs:remove", async (_e, { id } = {}) => jobs.removeFinished(id));
ipcMain.handle("jobs:clear", async () => jobs.clearFinished());

// Takes a job id, never a path. The renderer asking main to open an
// arbitrary filesystem path it supplied would be a real hole; looking the
// path up from our own job record means only files this app wrote are
// reachable through it.
ipcMain.handle("jobs:open-log", async (_e, { id } = {}) => {
  const job = jobs.jobs.find((j) => j.id === id);
  if (!job || !job.logPath) return { ok: false, error: "No log for that job." };
  const err = await shell.openPath(job.logPath);
  return err ? { ok: false, error: err } : { ok: true, path: job.logPath };
});

// ── Detachable panel (§18c) ──
// The panel is a tab in the main window by default. Detaching moves it to
// its own BrowserWindow; both render from the same `jobs:changed`
// broadcast, so nothing has to be handed over or kept in sync.
function notifyDock() {
  const detached = Boolean(panelWindow && !panelWindow.isDestroyed());
  for (const w of [mainWindow, panelWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send("panel:docked-changed", detached);
  }
}

ipcMain.handle("panel:detach", async () => {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.focus();
    return { detached: true };
  }
  panelWindow = new BrowserWindow({
    width: 720, height: 420, title: "Transfers",
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  panelWindow.loadFile(path.join(__dirname, "..", "renderer", "panel.html"));
  // Closing the detached window re-docks rather than losing the panel --
  // the spec's requirement, and the state was never in the window anyway.
  panelWindow.on("closed", () => {
    panelWindow = null;
    notifyDock();
  });
  panelWindow.webContents.on("did-finish-load", () => {
    broadcastJobs();
    notifyDock();
  });
  notifyDock();
  return { detached: true };
});

ipcMain.handle("panel:dock", async () => {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close();
  return { detached: false };
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
/**
 * A recent entry is either a filesystem path (a drive) or a FreeFrame
 * folder selection (§24a).
 *
 * The project case cannot be a bare string: what has to be remembered is
 * `{id, name, path}`, and the id is the only part the API accepts. Storing
 * just the path would mean re-resolving it against a folder tree that may
 * have been renamed since.
 */
function isRecentEntry(v) {
  if (typeof v === "string") return Boolean(v);
  return Boolean(v && typeof v === "object" && typeof v.id === "string" && v.id);
}

/** Identity for de-duplication: a path, or a folder id. */
function recentKey(v) {
  return typeof v === "string" ? v : v.id;
}

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
      const clean = list.filter(isRecentEntry).slice(0, RECENTS_PER_ROLE);
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
  if (typeof device !== "string" || !device || !isRecentEntry(folder)) return recents;

  const entry = recents[device] || (recents[device] = {});
  // Re-picking a folder promotes it rather than duplicating it. Compared by
  // id for a project selection, since its display name can change without
  // it being a different folder.
  const key = recentKey(folder);
  entry[role] = [folder, ...(entry[role] || []).filter((f) => recentKey(f) !== key)]
    .slice(0, RECENTS_PER_ROLE);
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

// `allowFiles` adds individual files to what the panel will accept. It's
// off by default because a *destination* must be a directory — but a
// source can legitimately be one clip, which the directory-only panel
// rendered dimmed and unselectable, with no explanation.
ipcMain.handle("dialog:choose-folder", async (_event, { title, defaultPath, allowFiles } = {}) => {
  const options = {
    title: title || "Choose folder",
    properties: allowFiles
      ? ["openDirectory", "openFile", "multiSelections", "createDirectory"]
      : ["openDirectory", "createDirectory"],
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
  // Single path for the folder-only case, so every existing caller is
  // unchanged. When files were allowed, the caller gets the full
  // selection plus what it actually is, since it has to branch on that.
  if (!allowFiles) return result.filePaths[0];
  const stats = await Promise.all(result.filePaths.map((p) => fsp.stat(p).catch(() => null)));
  const dirs = result.filePaths.filter((_, i) => stats[i] && stats[i].isDirectory());
  const files = result.filePaths.filter((_, i) => stats[i] && stats[i].isFile());
  // A directory wins if one was picked: mixing "walk this tree" with
  // "these exact files" in one source has no single sensible meaning.
  if (dirs.length) return { kind: "dir", paths: [dirs[0]] };
  if (files.length) return { kind: "files", paths: files };
  return null;
});

/** Split a mixed list of dropped/selected paths into one source shape. */
async function classifyPaths(paths) {
  const stats = await Promise.all(paths.map((p) => fsp.stat(p).catch(() => null)));
  const dirs = paths.filter((_, i) => stats[i] && stats[i].isDirectory());
  const files = paths.filter((_, i) => stats[i] && stats[i].isFile());
  if (dirs.length) return { kind: "dir", paths: [dirs[0]], ignored: paths.length - 1 };
  if (files.length) return { kind: "files", paths: files, ignored: paths.length - files.length };
  return null;
}

// Used by the OS drag-and-drop path, which gets a bag of paths from the
// drop event and needs the same classification the picker does.
ipcMain.handle("dialog:classify-paths", async (_event, { paths } = {}) =>
  Array.isArray(paths) && paths.length ? classifyPaths(paths.filter((p) => typeof p === "string")) : null
);

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
