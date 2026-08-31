const { contextBridge, ipcRenderer, webUtils } = require("electron");

// The only bridge between the sandboxed renderer and the main process.
// Deliberately narrow — expose specific async functions, never the raw
// ipcRenderer object, so the renderer (which will eventually render
// content describing user-supplied file/volume names) can't invoke
// arbitrary IPC channels.
contextBridge.exposeInMainWorld("freeframe", {
  listVolumes: () => ipcRenderer.invoke("volumes:list"),

  // `nodes` is the destination tree: [{ id, path, parentId }], where
  // parentId null means "copies from the original source" and a parentId
  // means "cascades from that destination". Resolves with the final
  // summary; per-node progress arrives separately via onCopyProgress
  // below, since invoke() can only resolve once.
  //
  // `sourcePath` may be a `freeframe://<projectId>` URI rather than a local
  // path, in which case `sourceFolderId` scopes it to one folder inside
  // that project (null = the whole project).
  // `sourceFiles` is the alternative to `sourcePath`: individually-chosen
  // files with no directory to walk.
  // `resumeJobId` (§105B) continues an interrupted copy: files still
  // present at the size that job's journal recorded are not copied again.
  startCopy: (sourcePath, nodes, algorithm, sourceFolderId, sourceFiles, naming, concurrencyMode, allowFragileRename, resumeJobId) =>
    ipcRenderer.invoke("copy:start", {
      sourcePath, nodes, algorithm, sourceFolderId, sourceFiles,
      resumeJobId: typeof resumeJobId === "string" && resumeJobId ? resumeJobId : null,
      // "free" | "source" | "destination" (§18c). Anything else is
      // treated as the most restrictive option by the scheduler.
      concurrencyMode,
      // { folderTemplate, fileTemplate, fields, values, filters } or null.
      // Main re-validates required fields, unknown tokens and the filter
      // spec regardless of what the renderer allowed through.
      naming,
      // §23d. One job's explicit acknowledgement that renaming RAW /
      // professional formats may break camera-native metadata linking.
      // Never persisted — the next job asks again.
      allowFragileRename: allowFragileRename === true,
    }),

  /** App settings (§58) — local JSON in userData, same as presets. */
  getSettings: () => ipcRenderer.invoke("settings:get"),
  /** Partial: only the fields sent are changed. */
  setSettings: (patch) => ipcRenderer.invoke("settings:set", { patch }),
  openLogsFolder: () => ipcRenderer.invoke("settings:open-logs"),
  /** §61 — Settings is its own window now. Singleton: a second call
   *  focuses the existing one. */
  openSettingsWindow: (tab) => ipcRenderer.invoke("settings:open", { tab }),
  /** Which tab the Settings window should show, when it was opened from a
   *  control that names one. */
  onSettingsTab: (cb) => ipcRenderer.on("settings:tab", (_e, tab) => cb(tab)),
  /** Broadcast whenever any window writes settings, so the main window's
   *  Volumes column follows an edit made in the Settings window. */
  onSettingsChanged: (cb) => ipcRenderer.on("settings:changed", (_e, s) => cb(s)),

  /** Embedded FreeFrame web view (§60b). Show/hide only — the renderer
   *  never gets a handle on the view itself. */
  showWebView: (top) => ipcRenderer.invoke("webview:show", { top }),
  hideWebView: () => ipcRenderer.invoke("webview:hide"),
  setWebViewInset: (top) => ipcRenderer.invoke("webview:inset", { top }),
  reloadWebView: () => ipcRenderer.invoke("webview:reload"),
  appInfo: () => ipcRenderer.invoke("app:info"),

  /** Naming presets (§10 / §18b) — local JSON in userData, no login. */
  listPresets: () => ipcRenderer.invoke("presets:list"),
  savePreset: (preset) => ipcRenderer.invoke("presets:save", { preset }),
  /** §65c — whether a folder pattern is allowed, decided by the same
   *  function the engine checks with at job start. */
  validateFolderPattern: (folderTemplate) =>
    ipcRenderer.invoke("presets:validate-folder", { folderTemplate }),
  /** §71 — would this job rename files? Decided by the same function the
   *  engine checks with, so the counter and the rename can never disagree. */
  renamesFiles: (fileTemplate, disabled) =>
    ipcRenderer.invoke("presets:renames-files", { fileTemplate, disabled }),

  /** §72 — the daily overview. Read/reset/export only; the aggregation
   *  itself happens in main at the job-completion point. */
  dailyOverview: () => ipcRenderer.invoke("daily:get"),
  resetDailyOverview: () => ipcRenderer.invoke("daily:reset"),
  exportDailyOverview: () => ipcRenderer.invoke("daily:export"),
  onDailyOverviewChanged: (cb) => ipcRenderer.on("daily-overview:changed", () => cb()),
  deletePreset: (id) => ipcRenderer.invoke("presets:delete", { id }),
  /** Same reason as onSettingsChanged: the editor lives in the Settings
   *  window, the active-preset label and Fields panel live in the main one. */
  onPresetsChanged: (cb) => ipcRenderer.on("presets:changed", () => cb()),
  /** `disabled` (§22g) is the list of field keys switched off for this
   *  transfer, so the preview shows the name the job will actually make. */
  previewNaming: (folderTemplate, fileTemplate, values, sourceLabel, disabled, opts) =>
    ipcRenderer.invoke("presets:preview", {
      folderTemplate, fileTemplate, values, sourceLabel, disabled,
      // §77/§78 — an object rather than two more positional arguments: a
      // seven-argument call is where the wrong value silently lands in the
      // wrong slot. Both are optional; main defaults each on its own.
      autoSuffix: opts?.autoSuffix,
      dateOverride: opts?.dateOverride,
    }),

  /** §22h — {sourcecounter}. bump() claims the current number and advances
   *  the stored one; set() is the editable field in the presets window. */
  bumpSourceCounter: () => ipcRenderer.invoke("presets:bump-source-counter"),
  setSourceCounter: (value) => ipcRenderer.invoke("presets:set-source-counter", { value }),

  /** No id cancels every running and queued job — what the single-job
   *  Cancel button used to mean. An id cancels just that one. */
  cancelCopy: (id) => ipcRenderer.invoke("copy:cancel", { id }),
  /** §95 — in-session pause. Stops after the current file; the job stays
   *  alive and Resume continues from the next one. */
  pauseCopy: (id) => ipcRenderer.invoke("copy:pause", { id }),
  resumeCopy: (id) => ipcRenderer.invoke("copy:resume", { id }),

  /** The job queue (§18c). State lives in main and is broadcast, so the
   *  docked panel and the detached window can never disagree. */
  listJobs: () => ipcRenderer.invoke("jobs:list"),
  /** History only — a queued or running job is refused (§59). */
  removeJob: (id) => ipcRenderer.invoke("jobs:remove", { id }),
  clearFinishedJobs: () => ipcRenderer.invoke("jobs:clear"),
  // By job id, not by path — main resolves the path from its own record,
  // so this can only ever open a log this app wrote.
  openJobLog: (id) => ipcRenderer.invoke("jobs:open-log", { id }),
  onJobsChanged: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("jobs:changed", listener);
    return () => ipcRenderer.removeListener("jobs:changed", listener);
  },
  detachPanel: () => ipcRenderer.invoke("panel:detach"),
  dockPanel: () => ipcRenderer.invoke("panel:dock"),
  onPanelDockChanged: (callback) => {
    const listener = (_event, detached) => callback(detached);
    ipcRenderer.on("panel:docked-changed", listener);
    return () => ipcRenderer.removeListener("panel:docked-changed", listener);
  },

  /** Eject physical media / disconnect a network share. Resolves
   *  { ok, error? } rather than throwing — a busy volume is an expected
   *  outcome the UI should show, not an exception. */
  // No `type` argument: the main process re-derives it from the live
  // volume list, because a renderer-supplied type is not something an
  // irreversible action should trust.
  ejectVolume: (mountPoint) => ipcRenderer.invoke("volumes:eject", { mountPoint }),

  /** Available checksum algorithms + their explainer text. */
  getAlgorithms: () => ipcRenderer.invoke("checksum:algorithms"),

  // defaultPath roots the native dialog inside one device (item 3) —
  // omitted for the general header buttons, supplied for the per-device
  // context-menu entries.
  chooseFolder: (title, defaultPath) =>
    ipcRenderer.invoke("dialog:choose-folder", { title, defaultPath }),

  /** Same panel, but individual files are selectable too. Resolves
   *  { kind: "dir" | "files", paths } — the caller has to branch, so the
   *  kind is returned rather than inferred from the shape. */
  chooseSource: (title, defaultPath) =>
    ipcRenderer.invoke("dialog:choose-folder", { title, defaultPath, allowFiles: true }),

  /** Classify a bag of paths from an OS drop into one source shape. */
  classifyPaths: (paths) => ipcRenderer.invoke("dialog:classify-paths", { paths }),

  /**
   * Real filesystem path for a File from an OS drag-and-drop.
   *
   * Must live in the preload: `webUtils` comes from electron, which the
   * sandboxed renderer cannot require. The renderer hands over the File it
   * got from the drop event and receives a plain string — it never gains
   * access to webUtils itself.
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },

  /** FreeFrame account. No token ever crosses this bridge — the renderer
   *  asks main to act on its behalf, same as volumes and copying. */
  freeframeLogin: (email, password, baseUrl) =>
    ipcRenderer.invoke("freeframe:login", { email, password, baseUrl }),
  freeframeLogout: () => ipcRenderer.invoke("freeframe:logout"),
  /** §64 — login lives in the Settings window now, so every window learns
   *  about a sign-in or sign-out from main rather than from the form. */
  onAccountChanged: (cb) => ipcRenderer.on("account:changed", (_e, st) => cb(st)),
  freeframeStatus: () => ipcRenderer.invoke("freeframe:status"),
  freeframeProjects: () => ipcRenderer.invoke("freeframe:projects"),
  freeframeFolderTree: (projectId) => ipcRenderer.invoke("freeframe:folder-tree", { projectId }),
  /** What a project (or one folder in it) holds, for showing a count and a
   *  size before a pull is started. */
  freeframeListAssets: (projectId, folderId, recursive) =>
    ipcRenderer.invoke("freeframe:list-assets", { projectId, folderId, recursive }),
  freeframeUpload: (sourcePath, projectId, folderId, sourceFiles, concurrencyMode, resumeJobId) =>
    ipcRenderer.invoke("freeframe:upload", { sourcePath, projectId, folderId, sourceFiles, concurrencyMode, resumeJobId }),
  /** §97A — upload jobs whose journal says they died mid-flight. §87
   *  Phase 2 will decide how these are surfaced; this is the reader. */
  interruptedUploads: () => ipcRenderer.invoke("freeframe:interrupted-uploads"),
  /** §87 Phase 2 — the user said no. Deletes that journal so it stops
   *  being offered. */
  // §105A — park one without deleting it. `discardInterruptedUpload`
  // deletes; this only stops the blocking modal offering it again.
  hideInterrupted: (jobId, hidden = true) =>
    ipcRenderer.invoke("freeframe:hide-interrupted", { jobId, hidden }),
  discardInterruptedUpload: (jobId) =>
    ipcRenderer.invoke("freeframe:discard-interrupted-upload", { jobId }),

  /** Cosmetic in-app display name per volume/folder. Never renames
   *  anything on disk. */
  getDisplayNames: () => ipcRenderer.invoke("display-names:get"),
  setDisplayName: (mountPoint, name) =>
    ipcRenderer.invoke("display-names:set", { mountPoint, name }),

  /** Recently-chosen folders, per device AND per role — `role` is
   *  "source" or "destination". A single per-device value meant the last
   *  folder used for either role was offered under both. */
  getRecentFolders: () => ipcRenderer.invoke("recent-folders:get"),
  rememberFolder: (device, role, folder) =>
    ipcRenderer.invoke("recent-folders:remember", { device, role, folder }),
  clearRecentFolders: (device, role) =>
    ipcRenderer.invoke("recent-folders:clear", { device, role }),

  /** Fires when /Volumes changes — a drive plugged in or ejected.
   *  Returns an unsubscribe function. Carries no payload: the renderer
   *  re-runs listVolumes() rather than trusting a diff computed elsewhere. */
  onVolumesChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("volumes:changed", listener);
    return () => ipcRenderer.removeListener("volumes:changed", listener);
  },

  /**
   * Subscribe to copy progress. Returns an unsubscribe function.
   *
   * The listener is wrapped so only the payload crosses the bridge — the
   * raw IpcRendererEvent carries a `sender` handle, and handing that to
   * renderer code would punch a hole straight through contextIsolation by
   * giving it a way to message arbitrary channels.
   */
  onCopyProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("copy:progress", listener);
    return () => ipcRenderer.removeListener("copy:progress", listener);
  },
});
