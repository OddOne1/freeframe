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
  startCopy: (sourcePath, nodes) =>
    ipcRenderer.invoke("copy:start", { sourcePath, nodes }),

  cancelCopy: () => ipcRenderer.invoke("copy:cancel"),

  chooseFolder: (title) => ipcRenderer.invoke("dialog:choose-folder", { title }),

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
