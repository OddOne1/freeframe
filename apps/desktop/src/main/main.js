const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const { listVolumes } = require("./volumes");
const { runCopyJob } = require("./copy-engine");

let mainWindow = null;

// One copy job at a time, deliberately. Concurrent jobs against the same
// source would fight over the same device queue and make the progress
// numbers meaningless; the roadmap's multi-hop DAG is a scheduler on top
// of this, not several uncoordinated runs.
let activeJob = null;

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
  const destPaths = Array.isArray(payload?.destPaths)
    ? payload.destPaths.filter((p) => typeof p === "string")
    : [];

  // Validated here rather than trusted from the renderer. The renderer is
  // the untrusted side of this boundary by design — it renders
  // user-supplied volume names, so it's the part most likely to be turned
  // against us, and copy-engine.js takes raw paths.
  if (!sourcePath) throw new Error("No source selected");
  if (destPaths.length === 0) throw new Error("No destination selected");

  const webContents = event.sender;
  let cancelled = false;
  activeJob = { cancel: () => { cancelled = true; } };

  try {
    return await runCopyJob({
      sourcePath,
      destPaths,
      isCancelled: () => cancelled,
      onProgress: (p) => {
        // The window can be closed mid-copy; sending to a destroyed
        // webContents throws and would abort an otherwise fine job.
        if (!webContents.isDestroyed()) webContents.send("copy:progress", p);
      },
    });
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
ipcMain.handle("dialog:choose-folder", async (_event, { title } = {}) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: title || "Choose folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
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
