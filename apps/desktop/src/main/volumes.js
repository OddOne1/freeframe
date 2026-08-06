// Mounted-volume enumeration, macOS.
//
// Zero extra npm dependencies on purpose: `diskutil` and `plutil` ship on
// every Mac, so this shells out to real system tools rather than parsing
// raw XML plists in JS or adding a plist-parsing package. Windows will
// need its own implementation later (WMI/PowerShell `Get-Volume`) behind
// the same listVolumes() shape — this file is the macOS-specific half.

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const execFileAsync = promisify(execFile);

/**
 * @typedef {Object} VolumeInfo
 * @property {string} name           - Volume display name.
 * @property {string} mountPoint     - Absolute path, e.g. "/Volumes/UNTITLED".
 * @property {string} deviceId       - e.g. "disk4s1", "" for network volumes.
 * @property {"removable"|"internal"|"external"|"network"} type
 * @property {number|null} totalBytes
 * @property {number|null} freeBytes
 * @property {string|null} fileSystem
 */

/** Runs `diskutil info -plist <mountPoint>` and converts the result to JSON
 * via `plutil` (also built into macOS) instead of pulling in a plist
 * parser dependency just for this one call site.
 *
 * BUG FIXED 2026-08-01: this originally piped diskutil's XML into plutil
 * via execFile's `{ input: ... }` option — that option only exists on the
 * *Sync* child_process variants (execFileSync/execSync/spawnSync). The
 * async `execFile` silently ignores unknown options rather than throwing,
 * so plutil was spawned reading from an empty stdin that never closed and
 * hung forever waiting for input that was never sent. Because that hang
 * is a stall, not a rejection, listVolumes()'s per-volume try/catch never
 * fired either — Promise.all just never settled, the IPC call never
 * returned, and the renderer's "Loading…" state had nothing to catch or
 * time out on. Fixed by writing the plist to a real temp file and having
 * plutil read that path instead of stdin — same zero-extra-dependency
 * approach, just without the broken pipe. */
async function getDiskutilInfo(mountPoint) {
  const { stdout: plistXml } = await execFileAsync("diskutil", ["info", "-plist", mountPoint]);

  const tempFile = path.join(os.tmpdir(), `freeframe-diskutil-${crypto.randomUUID()}.plist`);
  await fs.writeFile(tempFile, plistXml, "utf8");
  try {
    const { stdout: json } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", tempFile]);
    return JSON.parse(json);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

/** @returns {"removable"|"internal"|"external"|"network"} */
function classify(info) {
  const bus = info.BusProtocol || "";
  if (bus === "Network" || info.NetworkVolume === true) return "network";
  if (info.RemovableMedia === true) return "removable";
  if (info.Internal === true) return "internal";
  return "external";
}

/** Lists everything currently mounted under /Volumes, with type
 * classification (removable card/drive, internal, external, network) so
 * the UI can badge them the way ingesto's "center column" does. Volumes
 * `diskutil` can't describe (rare — some network mounts) are still
 * returned with best-effort info rather than dropped silently. */
async function listVolumes() {
  const volumesDir = "/Volumes";
  const entries = await fs.readdir(volumesDir, { withFileTypes: true });
  const mountPoints = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(volumesDir, e.name));

  const results = await Promise.all(
    mountPoints.map(async (mountPoint) => {
      try {
        const info = await getDiskutilInfo(mountPoint);
        return {
          name: info.VolumeName || path.basename(mountPoint),
          mountPoint,
          deviceId: info.DeviceIdentifier || "",
          type: classify(info),
          totalBytes: typeof info.TotalSize === "number" ? info.TotalSize : null,
          freeBytes: typeof info.FreeSpace === "number" ? info.FreeSpace : typeof info.VolumeFreeSpace === "number" ? info.VolumeFreeSpace : null,
          fileSystem: info.FilesystemType || info.FilesystemName || null,
        };
      } catch (err) {
        // A handful of virtual/network mount types make diskutil unhappy.
        // Still surface the volume rather than hiding it — unclassifiable
        // beats invisible, matches classify()'s "external" fallback logic.
        return {
          name: path.basename(mountPoint),
          mountPoint,
          deviceId: "",
          type: "external",
          totalBytes: null,
          freeBytes: null,
          fileSystem: null,
        };
      }
    })
  );

  return results;
}

module.exports = { listVolumes };
