const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { listVolumes } = require("./volumes");

let mainWindow = null;

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

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
