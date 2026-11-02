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

/** Converts a plist (as `diskutil -plist` prints it) to JSON via `plutil`
 * (also built into macOS) instead of pulling in a plist parser dependency
 * just for these two call sites.
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
async function plistToJson(plistXml) {
  const tempFile = path.join(os.tmpdir(), `freeframe-diskutil-${crypto.randomUUID()}.plist`);
  await fs.writeFile(tempFile, plistXml, "utf8");
  try {
    const { stdout: json } = await execFileAsync("plutil", ["-convert", "json", "-o", "-", tempFile]);
    return JSON.parse(json);
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

/** What `diskutil` knows about one mount point. */
async function getDiskutilInfo(mountPoint) {
  const { stdout: plistXml } = await execFileAsync("diskutil", ["info", "-plist", mountPoint]);
  return plistToJson(plistXml);
}

// ── §243 — telling macOS's own volumes apart from the user's ──
//
// `diskutil info -plist /Volumes/Recovery` does NOT state the volume's
// APFS role; it says `Internal: true`, `SystemImage: false`,
// `OSInternalMedia: false` and the generic APFS content GUID, i.e. it
// looks exactly like a normal internal volume. Verified on macOS 27
// (Darwin 27.0.0, Apple Silicon) on 2026-11-02 — the whole plist is in
// the §243 report.
//
// `diskutil apfs list -plist` DOES state it, once, for every APFS volume
// in every container:
//
//     disk3s1  Macintosh HD  Roles: ["System"]
//     disk3s2  Preboot       Roles: ["Preboot"]
//     disk3s3  Recovery      Roles: ["Recovery"]
//     disk3s5  Data          Roles: ["Data"]
//     disk3s6  VM            Roles: ["VM"]
//
// That is the signal used here: APFS roles are a property of the volume
// written into the container's metadata, not a macOS-version-specific
// heuristic, and `Roles` has been in diskutil's plist output since APFS
// shipped. One extra `diskutil` call serves the whole scan (~0.4 s cold
// on this machine, measured), not one per volume.

/** APFS roles that mean "this volume is part of how the Mac boots", never
 *  a place footage lives. Every one of these was observed on the owner's
 *  Mac: Recovery/Preboot/Update/VM in the boot container (disk3),
 *  iSCPreboot/xART/Hardware in the iSC container (disk1).
 *
 *  `System` and `Data` are deliberately ABSENT. `System` is the boot
 *  volume itself — "Macintosh HD", which the owner uses as a folder
 *  anchor and which must stay listed — and `Data` is its writable half,
 *  mounted at /System/Volumes/Data and therefore never under /Volumes
 *  anyway. `Backup` is absent too: a Time Machine destination is a drive
 *  someone deliberately chose, not plumbing.
 *
 *  Compared case-insensitively because diskutil prints the xART role as
 *  "xART" in text and "XART" in the plist depending on the release. */
const SYSTEM_APFS_ROLES = new Set(
  ["preboot", "recovery", "vm", "update", "xart", "hardware", "iscpreboot", "prelogin"],
);

/** Partition/content types that are system plumbing on their own, used
 *  when a volume has no APFS role to read — a pre-APFS `Apple_Boot`
 *  recovery partition, the EFI system partition, the Apple Silicon
 *  iSC/Recovery containers seen in `diskutil list` on this Mac
 *  (`Apple_APFS_ISC` on disk0s1, `Apple_APFS_Recovery` on disk0s3).
 *
 *  The plain APFS content GUID (41504653-…) is NOT here: it is what every
 *  APFS volume reports, the user's included. */
const SYSTEM_CONTENT_TYPES = new Set(
  ["apple_boot", "apple_recovery", "apple_apfs_recovery", "apple_apfs_isc", "apple_kernelcoredump", "efi"],
);

/** One `diskutil apfs list -plist` call → a lookup of what each APFS
 *  volume's role and container are.
 *
 *  Keyed twice on purpose. A volume is normally found by device
 *  identifier, but the booted system volume is mounted from a *snapshot*
 *  of itself: `diskutil info /` reports `disk3s1s1`, while the container
 *  lists the volume as `disk3s1`. The UUID doesn't bridge that either
 *  (the snapshot has its own), so the device-id lookup falls back to
 *  stripping the snapshot suffix.
 *
 *  @returns {Map<string, {roles: string[], container: string|null,
 *                         containerFree: number|null,
 *                         containerSize: number|null}>|null}
 *           null when diskutil can't be asked at all — the caller must
 *           then fail OPEN and list everything, which is today's
 *           behaviour and never hides a real drive. */
async function getApfsRoleMap() {
  try {
    const { stdout } = await execFileAsync("diskutil", ["apfs", "list", "-plist"]);
    const data = await plistToJson(stdout);
    const map = new Map();
    for (const container of data.Containers || []) {
      const entryBase = {
        container: container.ContainerReference || null,
        containerFree: typeof container.CapacityFree === "number" ? container.CapacityFree : null,
        containerSize: typeof container.CapacityCeiling === "number" ? container.CapacityCeiling : null,
      };
      for (const vol of container.Volumes || []) {
        const entry = { ...entryBase, roles: Array.isArray(vol.Roles) ? vol.Roles : [] };
        if (vol.DeviceIdentifier) map.set(`dev:${vol.DeviceIdentifier}`, entry);
        if (vol.APFSVolumeUUID) map.set(`uuid:${vol.APFSVolumeUUID}`, entry);
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** The role map entry for one volume, or null if it has none (a non-APFS
 *  volume — exFAT card, NTFS drive, SMB share — or an APFS volume
 *  diskutil didn't list). */
function apfsEntryFor(info, roleMap) {
  if (!roleMap) return null;
  const uuid = info.APFSVolumeUUID || info.VolumeUUID;
  if (uuid && roleMap.has(`uuid:${uuid}`)) return roleMap.get(`uuid:${uuid}`);
  const id = info.DeviceIdentifier || "";
  if (id && roleMap.has(`dev:${id}`)) return roleMap.get(`dev:${id}`);
  // A booted snapshot: disk3s1s1 is a snapshot of volume disk3s1.
  const snapshotOf = /^(disk\d+s\d+)s\d+$/.exec(id);
  if (snapshotOf && roleMap.has(`dev:${snapshotOf[1]}`)) return roleMap.get(`dev:${snapshotOf[1]}`);
  return null;
}

/** Is this volume macOS's own, rather than somewhere a user keeps files?
 *
 * FAIL-OPEN by design, and the direction matters more than the rule: a
 * volume this can't positively identify stays listed. A card that doesn't
 * appear is a drive the owner can't offload; a system volume that does
 * appear is a tile nobody clicks. Only the roles and content types above
 * — positively identified, read from the system itself — hide anything,
 * so a future macOS role this release has never heard of can't make a
 * real drive vanish.
 *
 * There is deliberately NO name matching. "Recovery" is a name anyone can
 * give an APFS volume or a USB stick, and hiding a drive because of what
 * it is called would be the same class of bug one layer down.
 */
function isSystemVolume(info, roleMap) {
  const entry = apfsEntryFor(info, roleMap);
  if (entry) {
    for (const role of entry.roles) {
      if (SYSTEM_APFS_ROLES.has(String(role).toLowerCase())) return true;
    }
  }
  const content = String(info.Content || "").toLowerCase();
  if (SYSTEM_CONTENT_TYPES.has(content)) return true;
  return false;
}

/** Real free/total bytes for a mount point.
 *
 * `statfs` is the source of truth, not `diskutil info`, for two reasons
 * confirmed empirically on this machine (2026-08-10):
 *
 *  - **Network mounts**: diskutil populates no size fields at all for an
 *    SMB mount — it reported `total=null free=null` for a 52 TB share that
 *    `df` reads fine. diskutil is built around physical device info; a
 *    network share has no device to describe.
 *  - **APFS internal**: diskutil reported `free=0` for the boot volume,
 *    because free space belongs to the APFS *container* shared by the
 *    read-only System and writable Data volumes, not to the single volume
 *    being asked about. `df` and Finder both report ~163 GB.
 *
 * statfs is a plain POSIX call against whatever is actually mounted at the
 * path, so it sidesteps both. Verified to match `df` byte-for-byte on the
 * internal drive and the network share.
 *
 * bavail (not bfree) is deliberate: bfree counts blocks reserved for root,
 * which a user can't actually write into — reporting it would overstate
 * how much footage fits.
 */
async function getSpace(mountPoint) {
  try {
    const st = await fs.statfs(mountPoint);
    const bsize = Number(st.bsize);
    return {
      totalBytes: Number(st.blocks) * bsize,
      freeBytes: Number(st.bavail) * bsize,
    };
  } catch {
    return null;
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

/** Everything currently mounted under /Volumes, macOS's own volumes
 * INCLUDED and flagged `isSystem`. `listVolumes()` is the filtered view
 * this app shows; this one exists so the main process can also know which
 * mount points to refuse as a copy source or destination (§243 C) without
 * scanning twice.
 *
 * Type classification (removable card/drive, internal, external, network)
 * lets the UI badge them the way ingesto's "center column" does. Volumes
 * `diskutil` can't describe (rare — some network mounts) are still
 * returned with best-effort info rather than dropped silently, and are
 * never flagged `isSystem`: unknown means listed. */
async function scanVolumes() {
  const volumesDir = "/Volumes";
  const entries = await fs.readdir(volumesDir, { withFileTypes: true });
  const mountPoints = entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => path.join(volumesDir, e.name));

  // One call for the whole scan, not one per volume. Null (diskutil
  // unavailable or unhappy) means nothing gets hidden.
  const roleMap = await getApfsRoleMap();

  const results = await Promise.all(
    mountPoints.map(async (mountPoint) => {
      // Asked for unconditionally: it's the authoritative answer even when
      // diskutil succeeds, and it's the only answer when diskutil doesn't.
      const space = await getSpace(mountPoint);

      try {
        const info = await getDiskutilInfo(mountPoint);
        // diskutil's own numbers survive only as a fallback for the rare
        // case where statfs itself fails (an unreachable network mount that
        // is still listed under /Volumes, typically).
        const fallbackTotal = typeof info.TotalSize === "number" ? info.TotalSize : null;
        const fallbackFree =
          typeof info.FreeSpace === "number"
            ? info.FreeSpace
            : typeof info.VolumeFreeSpace === "number"
              ? info.VolumeFreeSpace
              : null;
        const apfs = apfsEntryFor(info, roleMap);
        return {
          name: info.VolumeName || path.basename(mountPoint),
          mountPoint,
          deviceId: info.DeviceIdentifier || "",
          type: classify(info),
          totalBytes: space ? space.totalBytes : fallbackTotal,
          freeBytes: space ? space.freeBytes : fallbackFree,
          fileSystem: info.FilesystemType || info.FilesystemName || null,
          // §243 A — macOS's own volumes (Recovery, Preboot, VM, Update…).
          isSystem: isSystemVolume(info, roleMap),
          // §243 B — which APFS container the volume lives in. Volumes
          // sharing one container share its free space; null for anything
          // that isn't APFS, which is every card and most externals.
          containerId: apfs ? apfs.container : null,
          sharesSpaceWith: [],
        };
      } catch (err) {
        // A handful of virtual/network mount types make diskutil unhappy.
        // Still surface the volume rather than hiding it — unclassifiable
        // beats invisible. statfs usually still works here, which is the
        // whole point: an SMB share diskutil can't describe at all still
        // gets real numbers.
        return {
          name: path.basename(mountPoint),
          mountPoint,
          deviceId: "",
          // diskutil couldn't describe it, and on this machine that has so
          // far only happened for network mounts — a better guess than
          // "external", which put a 52 TB SMB share behind a USB-drive icon.
          type: "network",
          totalBytes: space ? space.totalBytes : null,
          freeBytes: space ? space.freeBytes : null,
          fileSystem: null,
          // Unknown is not system: a volume diskutil can't describe keeps
          // today's behaviour and stays listed (§243 A, fail-open).
          isSystem: false,
          containerId: null,
          sharesSpaceWith: [],
        };
      }
    })
  );

  // Deliberately NOT annotated here: sharing is a statement about what
  // the user is shown, so it is computed in listVolumes() after the
  // system volumes are gone.
  return results;
}

/** §243 C — is this (already symlink-resolved) path inside one of the
 *  given system mount points?
 *
 *  Pure and exported so the refusal can be tested without Electron. The
 *  prefix comparison includes the separator deliberately: "/Volumes/Recovery
 *  Disk" from a user's own drive must not match "/Volumes/Recovery".
 *
 *  @returns {string|null} the mount point it is inside, or null. */
function pathInsideSystemVolume(resolvedPath, systemMounts) {
  if (typeof resolvedPath !== "string" || !resolvedPath) return null;
  for (const m of systemMounts || []) {
    if (resolvedPath === m || resolvedPath.startsWith(m + path.sep)) return m;
  }
  return null;
}

/** §243 B — one APFS container's free space counted once.
 *
 * Several APFS volumes in ONE container draw on ONE pool: `statfs` on
 * each of them honestly reports the container's free space, so two tiles
 * showing "117.9 GB free" are not two lots of 117.9 GB. Rather than
 * invent a split that APFS itself doesn't have, each such volume is told
 * which listed volumes it shares with, and the tile says so.
 *
 * Only volumes that are actually LISTED count as sharing: after Recovery
 * and friends are filtered out, the boot volume is usually alone in its
 * container and nothing is claimed. */
function annotateSharedContainers(volumes) {
  const byContainer = new Map();
  for (const v of volumes) {
    v.sharesSpaceWith = [];
    if (!v.containerId) continue;
    const group = byContainer.get(v.containerId) || [];
    group.push(v);
    byContainer.set(v.containerId, group);
  }
  for (const group of byContainer.values()) {
    if (group.length < 2) continue;
    for (const v of group) {
      v.sharesSpaceWith = group.filter((o) => o !== v).map((o) => o.name);
    }
  }
  return volumes;
}

/** The volumes this app offers: everything mounted under /Volumes except
 * macOS's own. Unchanged in shape for every existing caller. */
async function listVolumes() {
  const all = await scanVolumes();
  return annotateSharedContainers(all.filter((v) => !v.isSystem));
}

module.exports = {
  listVolumes,
  scanVolumes,
  // Exported for the §243 unit tests, which drive them with real
  // `diskutil` plists captured from the owner's Mac.
  isSystemVolume,
  pathInsideSystemVolume,
  annotateSharedContainers,
  getApfsRoleMap,
  SYSTEM_APFS_ROLES,
  SYSTEM_CONTENT_TYPES,
};
