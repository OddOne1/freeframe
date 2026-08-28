#!/usr/bin/env node
// Progress ticks (CLAUDE.md §85) — pure, so tested without Electron.
//
// The bug this pins was not a wrong value anywhere: every number on screen
// was correct. `onProgress`'s "bytes" branch called the full render(), which
// does zoneVolumes.replaceChildren() and rebuilds every tile, kebab and
// eject button — many times a second, for the whole length of a copy. A
// click spans mousedown → render → click, so the button a gesture started
// on no longer existed when `click` fired: the context menu did nothing,
// drag lost the element under the pointer, and the column flashed.
//
// So what is asserted here is a NEGATIVE — that a byte tick does not
// rebuild — which no assertion on the rendered output could ever catch.
//
// onProgress is extracted from index.html and run for real rather than
// reimplemented: a copy of its logic would keep passing while the shipped
// branch regressed, which is the whole failure mode.
//
// Run: node scripts/test-progress.js
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "renderer", "index.html");
const src = fs.readFileSync(SRC, "utf8");

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

// ── Extract the real function ────────────────────────────────────────────
const start = src.indexOf("    function onProgress(p) {");
if (start < 0) throw new Error("onProgress not found — extraction needs updating");
const body = src.slice(start, src.indexOf("\n    }\n", start) + 6);

/**
 * The selector the branch is expected to use, checked against the markup
 * makeTile actually produces rather than assumed.
 *
 * Without this the fake DOM below would answer ANY selector carrying the
 * right id, so changing `.node-bar > div` to something that matches nothing
 * in the real app would still pass. That is the one mistake a stand-in DOM
 * invites.
 */
const EXPECTED = (id) => `[data-dest-id="${id}"] .node-bar > div`;

console.log("0. The selector matches the markup makeTile emits");
check(/dataset: node\s*\n\s*\? \{ destId: node\.id/.test(src),
  "the tile carries data-dest-id when it has a node");
check(/el\("div", \{ class: "node-bar" \}, \[\s*\n\s*el\("div", \{ class:/.test(src),
  "…and the bar is a div directly inside .node-bar");
check(src.includes('`[data-dest-id="${id}"] .node-bar > div`'),
  "…which is exactly what the bytes branch queries");

// ── A DOM that answers ONLY the expected selector ────────────────────────
let bars, asked;
/**
 * `domIds` may repeat an id, which gives that id two bar elements — the
 * case that separates querySelectorAll+loop from querySelector. One node
 * rendering in two places is not reachable today (one tile per destNode),
 * so the loop is defence rather than a live requirement; it is exercised
 * anyway, because "only the first one moved" is exactly the shape that
 * reads as a stalled destination and would be blamed on the copy engine.
 */
function harness(domIds) {
  bars = new Map();
  for (const id of domIds) {
    if (!bars.has(id)) bars.set(id, []);
    bars.get(id).push({ style: { width: "0%" } });
  }
  asked = [];
  let renders = 0;
  const nodeStatus = new Map();
  const document = {
    querySelectorAll(sel) {
      asked.push(sel);
      for (const [id, els] of bars) if (sel === EXPECTED(id)) return els;
      return [];
    },
  };
  const make = new Function(
    "nodeStatus", "render", "document", "sourceReleased",
    `${body}\n; return { onProgress, released: () => sourceReleased };`,
  );
  const api = make(nodeStatus, () => { renders++; }, document, false);
  return { ...api, nodeStatus, renders: () => renders };
}

console.log("\n1. A byte tick moves the bar and does NOT rebuild");
{
  const t = harness(["n1"]);
  t.onProgress({ phase: "bytes", nodeIds: ["n1"], percent: 42 });
  check(t.renders() === 0, "no full render on a byte tick");
  check(bars.get("n1")[0].style.width === "42%", "the bar moved", bars.get("n1")[0].style.width);
  check(t.nodeStatus.get("n1").percent === 42, "and nodeStatus still tracks it");
}

console.log("\n2. Sustained ticks stay at zero rebuilds — the reported bug");
{
  const t = harness(["n1"]);
  for (let i = 1; i <= 200; i++) t.onProgress({ phase: "bytes", nodeIds: ["n1"], percent: i / 2 });
  check(t.renders() === 0, "200 ticks caused 0 rebuilds", String(t.renders()));
  check(bars.get("n1")[0].style.width === "100%", "and the bar ended where it should");
}

console.log("\n3. Every node in a leg moves, not just the first");
{
  const t = harness(["a", "b"]);
  t.onProgress({ phase: "bytes", nodeIds: ["a", "b"], percent: 30 });
  check(bars.get("a")[0].style.width === "30%" && bars.get("b")[0].style.width === "30%",
    "both destination bars updated");
  check(t.renders() === 0, "still no render");
}

console.log("\n3b. One id with two bars moves BOTH");
{
  const t = harness(["dup", "dup"]);
  t.onProgress({ phase: "bytes", nodeIds: ["dup"], percent: 77 });
  const widths = bars.get("dup").map((e) => e.style.width);
  check(widths.every((w) => w === "77%"),
    "every matched bar moved, not just the first", JSON.stringify(widths));
}

console.log("\n4. A bar that isn't there falls back to ONE render");
{
  const t = harness(["a"]);                       // "b" has no tile
  t.onProgress({ phase: "bytes", nodeIds: ["a", "b"], percent: 55 });
  check(t.renders() === 1, "fell back once, not once per missing id", String(t.renders()));
  check(bars.get("a")[0].style.width === "55%", "the bar that DID exist still moved");
  check(t.nodeStatus.get("b").percent === 55, "and the missing one's state was still recorded");
}

console.log("\n5. Real state transitions still rebuild");
{
  const t = harness(["n1"]);
  t.onProgress({ phase: "node-status", node: { id: "n1", status: "verified", filesVerified: 3 } });
  check(t.renders() === 1, "node-status renders — status changes the rest of the tile");
  check(t.nodeStatus.get("n1").percent === 100, "…and verified pins the bar to 100");
  t.onProgress({ phase: "source-released" });
  check(t.renders() === 2, "source-released renders — the card becomes ejectable");
}

console.log("\n6. A tick with no percent does not write \"undefined%\"");
{
  const t = harness(["n1"]);
  t.onProgress({ phase: "bytes", nodeIds: ["n1"] });
  check(bars.get("n1")[0].style.width === "0%", "falls back to 0%", bars.get("n1")[0].style.width);
}

console.log("\n7. Remove stays unguarded (§85, wrongly gated twice before)");
{
  // A running job is independent of what Source/Destination shows: Remove is
  // the menu equivalent of dragging the card out, and gating it would break
  // how sequential jobs are queued. Asserted at the source because the guard
  // that keeps reappearing is a third argument to add().
  const m = /add\("Remove", \(\) => \{[\s\S]*?\n\s*\}\);/.exec(src);
  check(Boolean(m), "the Remove entry is still there");
  check(m && !/\}\s*,\s*[^)]/.test(m[0]),
    "…and takes no disabled argument", m ? m[0].split("\n").pop() : "");
  check(/const inUseBySource = isBusy\(path\);/.test(src),
    "while Eject stays gated — a different concern");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
