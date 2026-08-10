const { contextBridge, ipcRenderer } = require("electron");

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
  startCopy: (sourcePath, nodes, algorithm) =>
    ipcRenderer.invoke("copy:start", { sourcePath, nodes, algorithm }),

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

  /** Item 6 — last folder chosen per device, persisted in userData. */
  getRecentFolders: () => ipcRenderer.invoke("recent-folders:get"),
  rememberFolder: (device, folder) =>
    ipcRenderer.invoke("recent-folders:remember", { device, folder }),

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
