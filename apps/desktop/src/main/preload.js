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
  startCopy: (sourcePath, nodes, algorithm, sourceFolderId, sourceFiles, naming) =>
    ipcRenderer.invoke("copy:start", {
      sourcePath, nodes, algorithm, sourceFolderId, sourceFiles,
      // { folderTemplate, fileTemplate, fields, values } or null. Main
      // re-validates required fields and unknown tokens regardless of what
      // the renderer allowed through.
      naming,
    }),

  /** Naming presets (§10 / §18b) — local JSON in userData, no login. */
  listPresets: () => ipcRenderer.invoke("presets:list"),
  savePreset: (preset) => ipcRenderer.invoke("presets:save", { preset }),
  deletePreset: (id) => ipcRenderer.invoke("presets:delete", { id }),
  previewNaming: (folderTemplate, fileTemplate, values, sourceLabel) =>
    ipcRenderer.invoke("presets:preview", { folderTemplate, fileTemplate, values, sourceLabel }),

  cancelCopy: () => ipcRenderer.invoke("copy:cancel"),

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
  freeframeStatus: () => ipcRenderer.invoke("freeframe:status"),
  freeframeProjects: () => ipcRenderer.invoke("freeframe:projects"),
  freeframeFolderTree: (projectId) => ipcRenderer.invoke("freeframe:folder-tree", { projectId }),
  /** What a project (or one folder in it) holds, for showing a count and a
   *  size before a pull is started. */
  freeframeListAssets: (projectId, folderId, recursive) =>
    ipcRenderer.invoke("freeframe:list-assets", { projectId, folderId, recursive }),
  freeframeUpload: (sourcePath, projectId, folderId, sourceFiles) =>
    ipcRenderer.invoke("freeframe:upload", { sourcePath, projectId, folderId, sourceFiles }),

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
