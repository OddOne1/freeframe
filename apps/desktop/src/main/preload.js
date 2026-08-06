const { contextBridge, ipcRenderer } = require("electron");

// The only bridge between the sandboxed renderer and the main process.
// Deliberately narrow — expose specific async functions, never the raw
// ipcRenderer object, so the renderer (which will eventually render
// content describing user-supplied file/volume names) can't invoke
// arbitrary IPC channels.
contextBridge.exposeInMainWorld("freeframe", {
  listVolumes: () => ipcRenderer.invoke("volumes:list"),
});
