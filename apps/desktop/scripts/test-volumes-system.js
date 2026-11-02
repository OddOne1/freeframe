#!/usr/bin/env node
// §243 — macOS's own volumes are not offered as copy sources/destinations.
//
// The bug: the Offload screen's VOLUMES column listed a tile called
// "Recovery" (INTERNAL, 876.7 GB used, 117.9 GB free) next to "Macintosh HD"
// (INTERNAL, 876.7 GB used, 117.9 GB free) — byte-for-byte the same numbers,
// because /Volumes/Recovery is a hidden macOS volume sharing ONE APFS
// container with the boot volume, and statfs reports the container's pool
// for every volume in it. Offering it as a place to put footage is a trap.
//
// The fixtures in scripts/fixtures/volumes-243/ are REAL `diskutil info
// -plist` and `diskutil apfs list -plist` output captured from the owner's
// Mac on 2026-11-02 (macOS Darwin 27.0.0, Apple Silicon, FileVault on), with
// only the SMART block stripped. Nothing about them is invented. The few
// cases this machine cannot produce — a network mount, a card that reports
// RemovableMedia, a second user-created APFS volume, a USB stick someone
// named "Recovery" — are DERIVED from those captures and marked as such.
//
// Run: node scripts/test-volumes-system.js
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { pruneRecents } = require(path.join(__dirname, "..", "src", "main", "recents-prune.js"));
const {
  isSystemVolume,
  pathInsideSystemVolume,
  annotateSharedContainers,
  scanVolumes,
  listVolumes,
  SYSTEM_APFS_ROLES,
} = require(path.join(__dirname, "..", "src", "main", "volumes.js"));

const FIX = path.join(__dirname, "fixtures", "volumes-243");
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// ── The role map, built the way getApfsRoleMap() builds it ──
// (from the captured `diskutil apfs list -plist disk3`, plus derived
// entries for the volumes this Mac doesn't have.)
function roleMapFrom(containers) {
  const map = new Map();
  for (const container of containers) {
    const base = {
      container: container.ContainerReference || null,
      containerFree: container.CapacityFree ?? null,
      containerSize: container.CapacityCeiling ?? null,
    };
    for (const vol of container.Volumes || []) {
      const entry = { ...base, roles: vol.Roles || [] };
      if (vol.DeviceIdentifier) map.set(`dev:${vol.DeviceIdentifier}`, entry);
      if (vol.APFSVolumeUUID) map.set(`uuid:${vol.APFSVolumeUUID}`, entry);
    }
  }
  return map;
}

const captured = load("apfs-list-disk3.json").Containers;
const bootContainer = captured[0];

const recovery = load("recovery.json");
const macintoshHd = load("macintosh-hd.json");
const external = load("external-oddone01.json");
const card = load("lumix-card.json");

// DERIVED from the captured LUMIX card: the same exFAT card as macOS
// describes it when the reader reports removable media.
const removableCard = { ...card, VolumeName: "CANON_SD", RemovableMedia: true, Removable: true };

// DERIVED: an SMB share. diskutil populates almost nothing for one.
const networkShare = {
  VolumeName: "Archive",
  MountPoint: "/Volumes/Archive",
  DeviceIdentifier: "",
  BusProtocol: "Network",
  FilesystemType: "smbfs",
};

// DERIVED: a second APFS volume the user added to the boot container
// themselves (Disk Utility's "+"), which has no role at all.
const userApfsVolume = {
  ...recovery,
  VolumeName: "Scratch",
  MountPoint: "/Volumes/Scratch",
  DeviceIdentifier: "disk3s7",
  VolumeUUID: "11111111-2222-3333-4444-555555555555",
};
// DERIVED: a plain USB stick its owner named "Recovery". Not APFS, no
// role, external — a real drive with an unlucky name.
const usbStickNamedRecovery = {
  ...external,
  VolumeName: "Recovery",
  MountPoint: "/Volumes/Recovery",
  DeviceIdentifier: "disk31s1",
  VolumeUUID: "99999999-8888-7777-6666-555555555555",
};
// DERIVED: an APFS volume whose role this release has never heard of.
const futureRoleVolume = {
  ...recovery,
  VolumeName: "Something New",
  MountPoint: "/Volumes/Something New",
  DeviceIdentifier: "disk3s9",
  VolumeUUID: "abcdef01-0000-0000-0000-000000000000",
};

const roleMap = roleMapFrom([
  bootContainer,
  {
    ContainerReference: "disk3",
    CapacityFree: bootContainer.CapacityFree,
    CapacityCeiling: bootContainer.CapacityCeiling,
    Volumes: [
      { DeviceIdentifier: "disk3s7", APFSVolumeUUID: userApfsVolume.VolumeUUID, Roles: [], Name: "Scratch" },
      { DeviceIdentifier: "disk3s9", APFSVolumeUUID: futureRoleVolume.VolumeUUID, Roles: ["Quantum"], Name: "Something New" },
    ],
  },
]);

console.log("\nthe captured plists say what the fix relies on");
check(
  recovery.MountPoint === "/Volumes/Recovery" && recovery.Internal === true,
  "Recovery really is mounted under /Volumes and calls itself internal",
);
check(
  recovery.SystemImage === false && recovery.OSInternalMedia === false,
  "and diskutil info alone does NOT mark it as a system volume",
  `SystemImage=${recovery.SystemImage} OSInternalMedia=${recovery.OSInternalMedia}`,
);
check(
  roleMap.get("dev:disk3s3").roles.join(",") === "Recovery",
  "`diskutil apfs list` is where the role lives",
);
check(
  roleMap.get("dev:disk3s1").roles.join(",") === "System",
  "and the boot volume's role is System, which is NOT on the denylist",
  `denylist: ${[...SYSTEM_APFS_ROLES].join(" ")}`,
);

console.log("\nA — what is hidden, and what must never be");
check(isSystemVolume(recovery, roleMap) === true, "Recovery is filtered out");
check(
  isSystemVolume(macintoshHd, roleMap) === false,
  "Macintosh HD stays — found through its booted snapshot disk3s1s1 → disk3s1",
  `DeviceIdentifier=${macintoshHd.DeviceIdentifier}`,
);
check(isSystemVolume(external, roleMap) === false, "the external drive stays");
check(isSystemVolume(card, roleMap) === false, "the camera card stays");
check(isSystemVolume(removableCard, roleMap) === false, "a card reporting RemovableMedia stays");
check(isSystemVolume(networkShare, roleMap) === false, "a network share stays");
check(isSystemVolume(userApfsVolume, roleMap) === false, "a user-created APFS volume (no role) stays");
check(
  isSystemVolume(futureRoleVolume, roleMap) === false,
  "an unknown future role does NOT hide a volume — fail-open",
);
check(
  isSystemVolume(usbStickNamedRecovery, roleMap) === false,
  "a USB stick someone NAMED \"Recovery\" stays — no name matching anywhere",
);
check(isSystemVolume({}, roleMap) === false, "a volume diskutil said nothing about stays");
check(
  isSystemVolume(recovery, null) === false && isSystemVolume(macintoshHd, null) === false,
  "diskutil apfs list failing hides NOTHING (fail-open), it does not hide everything",
);
check(
  isSystemVolume({ VolumeName: "Recovery HD", Content: "Apple_Boot" }, null) === true,
  "a pre-APFS Apple_Boot recovery partition is caught by content type, with no role to read",
);

console.log("\nthe other system volumes this Mac has");
for (const [dev, name] of [["disk3s2", "Preboot"], ["disk3s4", "Update"], ["disk3s6", "VM"]]) {
  const vol = { ...recovery, VolumeName: name, DeviceIdentifier: dev, VolumeUUID: `uuid-${dev}` };
  check(isSystemVolume(vol, roleMap) === true, `${name} would be filtered too if it were mounted under /Volumes`);
}
const dataVol = { ...recovery, VolumeName: "Data", DeviceIdentifier: "disk3s5", VolumeUUID: "uuid-disk3s5" };
check(
  isSystemVolume(dataVol, roleMap) === false,
  "the Data volume is NOT on the denylist — it is the boot disk's writable half, and it never mounts under /Volumes anyway",
);

console.log("\nB — free space that is one pool, not one each");
const shared = annotateSharedContainers([
  { name: "Macintosh HD", containerId: "disk3", freeBytes: 117841752064, sharesSpaceWith: ["stale"] },
  { name: "Scratch", containerId: "disk3", freeBytes: 117841752064, sharesSpaceWith: [] },
  { name: "ODDONE_01", containerId: null, freeBytes: 1506819178496, sharesSpaceWith: [] },
]);
check(shared[0].sharesSpaceWith.join(",") === "Scratch", "each volume names the others in its container");
check(shared[1].sharesSpaceWith.join(",") === "Macintosh HD", "and the statement is symmetric");
check(shared[2].sharesSpaceWith.length === 0, "a drive with its own container claims nothing");
const alone = annotateSharedContainers([
  { name: "Macintosh HD", containerId: "disk3", freeBytes: 1, sharesSpaceWith: ["Recovery"] },
]);
check(
  alone[0].sharesSpaceWith.length === 0,
  "once Recovery is filtered out, Macintosh HD is alone again and says nothing about sharing",
);

console.log("\nC — paths into a system volume are refused");
const mounts = ["/Volumes/Recovery", "/Volumes/Preboot"];
check(pathInsideSystemVolume("/Volumes/Recovery", mounts) === "/Volumes/Recovery", "the mount point itself");
check(
  pathInsideSystemVolume("/Volumes/Recovery/staging/DAY_01", mounts) === "/Volumes/Recovery",
  "a folder deep inside it",
);
check(pathInsideSystemVolume("/Volumes/Preboot", mounts) === "/Volumes/Preboot", "any of the system mounts, not just the first");
check(pathInsideSystemVolume("/Volumes/ODDONE_01/DAY_01", mounts) === null, "a normal external path is accepted");
check(pathInsideSystemVolume("/Users/someone/Movies", mounts) === null, "a home folder is accepted");
check(pathInsideSystemVolume("/Volumes/Macintosh HD/Users/someone", mounts) === null, "the boot volume is accepted");
check(
  pathInsideSystemVolume("/Volumes/Recovery Disk/DAY_01", mounts) === null,
  "a drive whose name merely STARTS with a system mount's name is accepted",
);
check(pathInsideSystemVolume("", mounts) === null && pathInsideSystemVolume(null, mounts) === null, "nothing is not a system path");
check(pathInsideSystemVolume("/Volumes/Recovery", []) === null, "with no system volumes known, nothing is refused");

console.log("\nC — remembered folders inside a system volume are forgotten");
// The real predicate resolves symlinks and is async; this is the same
// decision made synchronously against a fixed list of mounts.
const mounted = ["/Volumes/Recovery", "/Volumes/Preboot"];
const isSystemPath = async (p) => pathInsideSystemVolume(p, mounted);
const ROLES = ["source", "destination"];

(async () => {
  const before = {
    "/Volumes/Macintosh HD": {
      source: ["/Volumes/Recovery/staging", "/Users/me/Movies"],
      destination: ["/Volumes/Recovery", "/Users/me/Archive"],
    },
    // Recents were keyed by mount point, so a pre-release session could
    // have filed folders under the system volume itself.
    "/Volumes/Recovery": { source: ["/Volumes/Recovery/staging"], destination: ["/Volumes/Recovery"] },
    "/Volumes/ODDONE_01": { destination: ["/Volumes/ODDONE_01/DAY_01"] },
    // A project selection is not a path and must survive untouched.
    "freeframe://p1": { destination: [{ id: "f1", name: "Dailies" }] },
  };
  const { recents: after, pruned } = await pruneRecents(before, ROLES, isSystemPath);

  // Two under "Macintosh HD" (one per role) plus the two filed under the
  // Recovery device itself.
  check(pruned === 4, "every entry inside a system volume is counted as pruned", `pruned=${pruned}`);
  check(
    JSON.stringify(after["/Volumes/Macintosh HD"]) ===
      JSON.stringify({ source: ["/Users/me/Movies"], destination: ["/Users/me/Archive"] }),
    "the real folders on a real drive survive, the Recovery ones do not",
    JSON.stringify(after["/Volumes/Macintosh HD"]),
  );
  check(!("/Volumes/Recovery" in after), "a device that IS a system volume loses its whole history");

  // …and for the right reason. Above, every folder filed under the Recovery
  // device also *lived* inside it, so the device would disappear anyway as
  // its entries were pruned one by one. Here the remembered folders are
  // perfectly good paths on the boot disk — only the device key is a system
  // volume — so nothing but the device rule can drop them. (Found by
  // mutation C.)
  const keyedUnderSystem = await pruneRecents(
    { "/Volumes/Recovery": { source: ["/Users/me/Movies"], destination: ["/Users/me/Archive"] } },
    ROLES,
    isSystemPath,
  );
  check(
    Object.keys(keyedUnderSystem.recents).length === 0 && keyedUnderSystem.pruned === 2,
    "a history filed UNDER a system volume goes too, even where the folders themselves are fine",
    JSON.stringify(keyedUnderSystem),
  );
  check(
    JSON.stringify(after["/Volumes/ODDONE_01"]) === JSON.stringify({ destination: ["/Volumes/ODDONE_01/DAY_01"] }),
    "an untouched drive is returned unchanged",
  );
  check(
    JSON.stringify(after["freeframe://p1"]) === JSON.stringify({ destination: [{ id: "f1", name: "Dailies" }] }),
    "a FreeFrame project selection is left alone — it is not a filesystem path",
  );

  // Surviving the walk is not enough: a project selection must never be
  // HANDED to the path predicate in the first place. Both the real
  // predicate and the one above happen to ignore non-strings, so without
  // this the string check could be deleted and every assertion would still
  // pass. (Found by mutation B.)
  const asked = [];
  await pruneRecents(before, ROLES, async (p) => {
    asked.push(p);
    return pathInsideSystemVolume(p, mounted);
  });
  check(
    asked.every((p) => typeof p === "string"),
    "the path predicate is only ever asked about strings",
    `asked about: ${asked.map((p) => typeof p).join(", ")}`,
  );

  const clean = { "/Volumes/ODDONE_01": { source: ["/Volumes/ODDONE_01/DAY_01"] } };
  const untouched = await pruneRecents(clean, ROLES, isSystemPath);
  check(untouched.pruned === 0, "nothing to prune reports nothing, so the caller skips the write");

  const allGone = await pruneRecents(
    { "/Volumes/Macintosh HD": { source: ["/Volumes/Recovery/a"] } },
    ROLES,
    isSystemPath,
  );
  check(
    !("/Volumes/Macintosh HD" in allGone.recents),
    "a device left with nothing is dropped, not kept as an empty object",
  );

  const noMounts = await pruneRecents(before, ROLES, async () => false);
  check(
    JSON.stringify(noMounts.recents) === JSON.stringify(before) && noMounts.pruned === 0,
    "with no system volume mounted, nothing is forgotten — fail-open here too",
  );

  await live();
})();

// ── Against the real machine this was found on ──
// Skipped with a note rather than failed where the drives aren't attached,
// so the suite still means something on another Mac.
async function live() {
  console.log("\nthis Mac, right now");
  const all = await scanVolumes();
  const offered = await listVolumes();
  const names = (list) => list.map((v) => v.name).sort().join(", ");
  console.log(`  mounted under /Volumes: ${names(all)}`);
  console.log(`  offered by the app:     ${names(offered)}`);

  const sawRecovery = all.some((v) => v.mountPoint === "/Volumes/Recovery");
  if (!sawRecovery) {
    console.log("  SKIP  /Volumes/Recovery is not mounted here — the live assertion needs the Mac this was found on");
  } else {
    check(
      !offered.some((v) => v.mountPoint === "/Volumes/Recovery"),
      "the real Recovery volume is gone from the offered list",
    );
    check(
      all.find((v) => v.mountPoint === "/Volumes/Recovery").isSystem === true,
      "and it is gone because it was positively identified, not dropped",
    );
  }
  const boot = offered.find((v) => v.mountPoint === "/Volumes/Macintosh HD");
  if (!boot) {
    console.log("  SKIP  no /Volumes/Macintosh HD here");
  } else {
    check(boot.type === "internal", "the real boot volume is still offered, still INTERNAL");
    check(
      boot.freeBytes > 0 && boot.totalBytes > 0,
      "with real numbers",
      `${boot.freeBytes} free of ${boot.totalBytes}`,
    );
    check(boot.sharesSpaceWith.length === 0, "and claims no sharing now that it is alone in its container");
  }
  const ext = offered.filter((v) => v.type === "external" || v.type === "removable");
  if (!ext.length) {
    console.log("  SKIP  no external drive or card attached");
  } else {
    check(true, `external/removable volumes still offered: ${names(ext)}`);
  }
  // A real SMB share turned up on the owner's Mac mid-review, which is the
  // one case the derived fixture above could only approximate: diskutil
  // describes a network mount so poorly that scanVolumes() takes its
  // best-effort branch. It must still be offered.
  const net = offered.filter((v) => v.type === "network");
  if (!net.length) {
    console.log("  SKIP  no network mount attached");
  } else {
    check(
      net.every((v) => v.freeBytes > 0),
      `a real network share is still offered, with real numbers: ${net.map((v) => `${v.name} ${v.freeBytes}`).join(", ")}`,
    );
  }
  check(
    offered.every((v) => v.isSystem === false),
    "nothing offered is flagged as a system volume",
  );

  console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  process.exit(fail === 0 ? 0 : 1);
}
