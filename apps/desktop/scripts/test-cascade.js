#!/usr/bin/env node
// Destination narrowing and the cascade tree (CLAUDE.md §69 / §73 / §89).
//
// This bug has now been fixed three times at three different entry points,
// which is the reason the rule lives inside addDest() and the reason this
// file exists: what is asserted here is the RULE, once, rather than each
// menu item's wiring.
//
// §89's shape, from a real screen recording: a drive already sitting in a
// cascade chain was invisible to the narrowing check, so picking a folder
// on it built a second, independent root destination beside the chain —
// "Copy & Verify (2, 1 cascaded)" became "(3, 1 cascaded)". Fixing only
// that half would have swapped a duplicated node for a silently-dropped
// cascade, so both halves are pinned here.
//
// narrowingTarget/addDest/removeDest are EXTRACTED from index.html and run
// for real. A reimplementation of their logic would keep passing while the
// shipped renderer regressed, which is exactly the failure mode.
//
// Run: node scripts/test-cascade.js
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "renderer", "index.html");
const src = fs.readFileSync(SRC, "utf8");

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/** Pull one top-level `function name(...) {...}` out of the renderer. */
function grab(name) {
  const start = src.indexOf(`    function ${name}(`);
  if (start < 0) throw new Error(`${name} not found — extraction needs updating`);
  const end = src.indexOf("\n    }\n", start);
  if (end < 0) throw new Error(`${name} has no recognisable end`);
  return src.slice(start, end + 6);
}

/**
 * A world with just enough around the three functions for them to run.
 * `deviceFor` is stubbed to a prefix map — the real one resolves a path to
 * its mount point the same way, and stubbing keeps the scenario independent
 * of what happens to be plugged in.
 */
function world(devices) {
  // `destNodes` is a plain `let` INSIDE the built scope, because removeDest
  // reassigns it (`destNodes = destNodes.filter(...)`). Read back through a
  // closure rather than by rewriting the extracted source: a blanket
  // find-and-replace over real code is how a harness quietly edits
  // something it did not mean to.
  const api = new Function(
    "devices",
    `
    let destNodes = [];
    let ids = 0;
    const isProject = (p) => typeof p === "string" && p.startsWith("freeframe://");
    const newId = () => "id" + (++ids);
    // Mirrors the REAL deviceFor, fallback included: it ends in
    // \`best || internal\`, so a path it cannot place — a freeframe:// URI
    // among them — resolves to the INTERNAL volume rather than to null.
    // A stub returning null there would hide the project hazard entirely,
    // which is the mistake §73's own test made before it was caught.
    const deviceFor = (p) => {
      if (typeof p !== "string") return null;
      for (const d of devices) if (p === d || p.startsWith(d + "/")) return d;
      return devices[0] || null;
    };
    let sourcePath = null;
    const pruneExtraFolder = () => {};
    const render = () => {};
    const openDualRoleModal = () => {};
    const showProjectConflict = () => {};
    ${grab("narrowingTarget")}
    ${grab("addDest")}
    ${grab("removeDest")}
    return { addDest, removeDest, narrowingTarget, nodes: () => destNodes };
    `,
  );
  return api(devices);
}

// Guard against extracting something that is not the real thing: if the
// grabs ever silently returned a fragment, every scenario below would run
// against a stub and pass for the wrong reason.
check(/narrowingTarget\(p, parentId === undefined \? null : parentId\)/.test(grab("addDest")),
  "the real addDest was extracted, sentinel resolution and all");
check(/deviceFor\(n\.path\) === dev/.test(grab("narrowingTarget")),
  "…and the real narrowingTarget");

const scenario = (devices) => world(devices);

console.log("\n1. (§89) A cascade child on the device is found, not ignored");
{
  const w = scenario(["/Volumes/SHUTTLE", "/Volumes/ODDONE"]);
  w.addDest("/Volumes/SHUTTLE/ReShuffle", null);
  const parent = w.nodes()[0];
  w.addDest("/Volumes/ODDONE", parent.id);          // cascade child
  check(w.nodes().length === 2, "two nodes: one root, one cascaded", String(w.nodes().length));
  const child = w.nodes()[1];
  check(child.parentId === parent.id, "…and the child really is cascaded");

  // The recorded action: pick a different folder on the cascaded drive.
  w.addDest("/Volumes/ODDONE/Desktop");
  check(w.nodes().length === 2,
    "picking a folder on it NARROWS — no third destination appears",
    w.nodes().map((n) => n.path).join(" , "));
  const now = w.nodes().find((n) => n.path === "/Volumes/ODDONE/Desktop");
  check(Boolean(now), "the new folder is the one on that device");
  check(now && now.parentId === parent.id,
    "…and it is STILL cascaded from the same parent — the chain survives",
    now && String(now.parentId));
}

console.log("\n2. §73's original case is unaffected");
{
  const w = scenario(["/Volumes/MAIN", "/Volumes/OTHER"]);
  w.addDest("/Volumes/MAIN", null);
  w.addDest("/Volumes/MAIN/Desktop");
  check(w.nodes().length === 1 && w.nodes()[0].path === "/Volumes/MAIN/Desktop",
    "a ROOT destination still narrows in place", w.nodes().map((n) => n.path).join(" , "));
  check(w.nodes()[0].parentId === null, "…and stays root");

  w.addDest("/Volumes/OTHER/Dailies");
  check(w.nodes().length === 2, "a different drive is still a second parallel destination");
}

console.log("\n3. An explicit parent still wins over narrowing");
{
  const w = scenario(["/Volumes/A", "/Volumes/B"]);
  w.addDest("/Volumes/A", null);
  const a = w.nodes()[0];
  // cascadeFrom's shape: a named parent, on a device that already holds a
  // destination. It must chain, not narrow that destination away.
  w.addDest("/Volumes/A/Leg", a.id);
  check(w.nodes().length === 2, "a named parent adds a leg rather than narrowing",
    String(w.nodes().length));
  check(w.nodes()[1].parentId === a.id, "…under exactly the parent asked for");
}

console.log("\n4. null still means root, explicitly");
{
  const w = scenario(["/Volumes/A", "/Volumes/B"]);
  w.addDest("/Volumes/B/ReShuffle", null);
  const root = w.nodes()[0];
  w.addDest("/Volumes/A", root.id);
  check(w.nodes()[1].parentId === root.id, "set up: A is cascaded from B");
  // The one call site the spec keeps as explicit root.
  w.addDest("/Volumes/A/Other", null);
  const moved = w.nodes().find((n) => n.path === "/Volumes/A/Other");
  check(w.nodes().length === 2, "it still narrows — null does not disable that");
  check(moved && moved.parentId === null,
    "…but forces the replacement to root, dropping the cascade",
    moved && String(moved.parentId));
}

console.log("\n5. Projects are still excluded in both directions");
{
  const w = scenario(["/Volumes/MAIN"]);
  w.addDest("/Volumes/MAIN/Keep", null);
  w.addDest("freeframe://p1");
  check(w.nodes().length === 2, "a project does not narrow a real destination away",
    w.nodes().map((n) => n.path).join(" , "));
  const w2 = scenario(["/Volumes/MAIN"]);
  w2.addDest("freeframe://p1");
  w2.addDest("/Volumes/MAIN/Keep");
  check(w2.nodes().length === 2, "…and a real destination does not evict a project");
}

console.log("\n6. Re-picking the path already set changes nothing");
{
  const w = scenario(["/Volumes/MAIN"]);
  w.addDest("/Volumes/MAIN/Desktop", null);
  w.addDest("/Volumes/MAIN/Desktop");
  check(w.nodes().length === 1,
    "addDest's own exact-match guard returns before narrowing could empty the column",
    String(w.nodes().length));
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
