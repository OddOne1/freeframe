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

console.log("\n8. (§81) Date and Time are two views on ONE value");
{
  // The real helpers, extracted rather than restated — a second copy would
  // keep passing while the shipped ones drifted.
  const grab = (name) => {
    const i = src.indexOf(`    function ${name}(`);
    if (i < 0) throw new Error(`${name} not found`);
    return src.slice(i, src.indexOf("\n    }\n", i) + 6);
  };
  let ov = null;
  const api = new Function("getD", "setD",
    grab("dateInputValue") + grab("timeInputValue") + grab("dropOverrideIfLive") + `
    const effectiveNow = () => getD() || new Date();
    const settle = () => { let dateOverride = getD(); if (!dateOverride) return;
      const live = new Date();
      if (dateInputValue(dateOverride) === dateInputValue(live)
        && timeInputValue(dateOverride) === timeInputValue(live)) setD(null); };
    return {
      dateStr: () => getD() && dateInputValue(getD()),
      timeStr: () => getD() && timeInputValue(getD()),
      setDate(y,m,d){const b=effectiveNow();setD(new Date(y,m-1,d,b.getHours(),b.getMinutes()));},
      setTime(h,mi){const b=effectiveNow();setD(new Date(b.getFullYear(),b.getMonth(),b.getDate(),h,mi));},
      dateNow(){const l=new Date(),b=effectiveNow();
        setD(new Date(l.getFullYear(),l.getMonth(),l.getDate(),b.getHours(),b.getMinutes()));settle();},
      timeNow(){const l=new Date(),b=effectiveNow();
        setD(new Date(b.getFullYear(),b.getMonth(),b.getDate(),l.getHours(),l.getMinutes()));settle();},
      today: () => dateInputValue(new Date()),
    };`)(() => ov, (v) => { ov = v; });

  check(ov === null, "starts live — nothing overridden until something is set");
  api.setDate(2025, 1, 2);
  check(api.dateStr() === "2025-01-02", "setting the date pins it", api.dateStr());
  api.setTime(3, 4);
  check(api.dateStr() === "2025-01-02", "setting the TIME does not discard the date", api.dateStr());
  check(api.timeStr() === "03:04", "…and pins the time", api.timeStr());
  api.setDate(2026, 12, 31);
  check(api.timeStr() === "03:04", "setting the DATE does not discard the time", api.timeStr());
  api.dateNow();
  check(api.dateStr() === api.today(), "Date's Now returns to today");
  check(api.timeStr() === "03:04", "…and leaves the time override alone", api.timeStr());
  api.timeNow();
  check(ov === null,
    "once neither half differs from the clock, the override drops — a value pinned to \"now\" would freeze there");
}

console.log("\n9. (§81) A local date is not a UTC one");
{
  // `new Date("2026-08-28")` is UTC midnight, which formats as the 27th
  // anywhere west of Greenwich. Both directions are parsed/formatted from
  // local parts, and this pins that rather than the timezone this happens
  // to run in.
  const i = src.indexOf("    function dateInputValue(");
  const fn = new Function(src.slice(i, src.indexOf("\n    }\n", i) + 6) + "; return dateInputValue;")();
  check(fn(new Date(2026, 7, 28, 23, 30)) === "2026-08-28",
    "a late-evening local time still formats as its own day", fn(new Date(2026, 7, 28, 23, 30)));
  check(fn(new Date(2026, 0, 1, 0, 5)) === "2026-01-01",
    "…and just after local midnight too", fn(new Date(2026, 0, 1, 0, 5)));
}

console.log("\n10. (§84) The transfer log reads top-down");
{
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
  const i = mainSrc.indexOf("function buildJobLog(job) {");
  // Anchored on the KEY, not on its value. Anchoring on "freeframeTransferLog: 2"
  // made a version change break the extraction instead of failing the
  // assertion below — the script threw, no FAIL line was printed, and a
  // mutation sweep read that as "survived".
  const end = mainSrc.indexOf("\n}\n", mainSrc.indexOf("    freeframeTransferLog:", i)) + 3;
  const buildJobLog = new Function("path", mainSrc.slice(i, end) + "; return buildJobLog;")(path);

  const mk = (files, status = "done", nodeStatus = "verified") => buildJobLog({
    id: "j1", label: "LUMIX to ReShuffle", status, mode: "free",
    sourceLabel: "/Volumes/LUMIX", destPaths: ["/dst"],
    createdAt: 1, startedAt: 2, finishedAt: 3,
    summary: { nodes: [{ path: "/dst", status: nodeStatus, files }] },
  });

  const renamed = mk([
    { file: "DCIM/P1012257.MOV", destPath: "/dst/001_B-Roll/DCIM/001_B-Roll_0001.MOV", ok: true },
    { file: "DCIM/P1012258.MOV", destPath: "/dst/001_B-Roll/DCIM/001_B-Roll_0002.MOV", ok: true },
  ]);
  check(Object.keys(renamed).join(",") === "freeframeTransferLog,readable,technical",
    "readable comes before technical — this file IS the viewer",
    Object.keys(renamed).join(","));
  check(renamed.freeframeTransferLog === 2,
    "the version is bumped: `job`/`summary` moved, so a path-based reader breaks loudly");
  check(renamed.readable.files[0].from === "P1012257.MOV"
    && renamed.readable.files[0].to === "001_B-Roll_0001.MOV"
    && renamed.readable.files[0].renamed === true,
    "a renamed file shows both names and says so", JSON.stringify(renamed.readable.files[0]));
  check(renamed.readable.renamedCount === 2 && renamed.readable.fileCount === 2, "…and is counted");
  check(renamed.technical.job && renamed.technical.summary !== undefined,
    "everything that was in the file before is still there, just lower down");

  const plain = mk([{ file: "DCIM/A.MOV", destPath: "/dst/DCIM/A.MOV", ok: true }]);
  check(plain.readable.files[0].renamed === false
    && plain.readable.files[0].from === plain.readable.files[0].to,
    "a plain copy shows identical names and renamed:false — no special casing");

  check(renamed.readable.safeToWipeCard === true, "all verified: safe to wipe");
  const bad = mk([{ file: "DCIM/A.MOV", destPath: "/dst/DCIM/A.MOV", ok: false }]);
  check(bad.readable.safeToWipeCard === false, "one unverified file: NOT safe to wipe");
  check(bad.readable.notVerified.length === 1,
    "…and it is listed on its own, not left to be spotted in a long list");
  // The line that says "erase your footage" must never disagree with the
  // list printed under it, even from a node status that should be
  // impossible.
  const lying = mk([{ file: "DCIM/A.MOV", destPath: "/dst/DCIM/A.MOV", ok: false }], "done", "verified");
  check(lying.readable.safeToWipeCard === false,
    "a node claiming verified cannot override a file that failed");

  const noDest = mk([{ file: "DCIM/B.MOV", destPath: null, ok: false }]);
  check(noDest.readable.files[0].to === null && noDest.readable.files[0].renamed === false,
    "a file that never reached a destination is not reported as renamed",
    JSON.stringify(noDest.readable.files[0]));
}

console.log("\n11. (§81) Which token kinds a pattern uses is decided in main");
{
  // The renderer asks rather than tokenizing again, so the classification
  // itself has to be pinned where it lives.
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main", "main.js"), "utf8");
  const { tokensIn } = require(path.join(__dirname, "..", "src", "main", "naming.js"));
  // Read out of the source by bracket position rather than by regex —
  // the escaping needed to match `new Set(` inside a generated file is
  // exactly where this went wrong once already.
  const grabSet = (name) => {
    const i = mainSrc.indexOf(`const ${name} = new Set(`);
    if (i < 0) throw new Error(`${name} not found`);
    const open = mainSrc.indexOf("[", i);
    const close = mainSrc.indexOf("]", open);
    return new Set(JSON.parse(mainSrc.slice(open, close + 1)));
  };
  const DATE = grabSet("DATE_TOKENS"), TIME = grabSet("TIME_TOKENS");
  const uses = (t) => ({
    date: tokensIn(t).some((k) => DATE.has(k)),
    time: tokensIn(t).some((k) => TIME.has(k)),
  });

  check(!uses("{operator}_{sourcecounter}").date && !uses("{operator}_{sourcecounter}").time,
    "a pattern with no date or time token claims neither row");
  check(uses("{YYYY}{MM}{DD}").date && !uses("{YYYY}{MM}{DD}").time,
    "a date pattern claims Date only");
  check(!uses("{hh}{mm}").date && uses("{hh}{mm}").time,
    "a time pattern claims Time only");
  check(uses("{date}_{hh}").date && uses("{date}_{hh}").time, "both claims both");
  // The one that a careless Set would get wrong.
  check(uses("{MM}").date && !uses("{MM}").time,
    "{MM} is the MONTH — a date token, not a time one");
  check(!uses("{mm}").date && uses("{mm}").time,
    "{mm} is MINUTES — a time token, not a date one");

  // The classification above is only worth anything if the handler
  // actually applies it. Asserted at the source, because the flags come
  // back over IPC and this suite starts no Electron: the check right above
  // re-applies tokensIn itself, so a handler hardcoding `usesDate: true`
  // would sail past it.
  for (const [key, set] of [["usesDate", "DATE_TOKENS"], ["usesTime", "TIME_TOKENS"]]) {
    const line = mainSrc.split("\n").find((l) => l.trim().startsWith(`${key}:`));
    check(Boolean(line) && line.includes("tokensIn(") && line.includes(`${set}.has(`),
      `${key} is derived from the templates, not asserted`, (line || "(absent)").trim());
    check(Boolean(line) && line.includes("folderTpl") && line.includes("fileTpl"),
      `…from BOTH templates — a date token in either one earns the row`);
  }
}

console.log("\n11b. (§81) …and the renderer hides the rows on those flags");
{
  // Three separate things, each of which alone would leave a row that is
  // always shown or never shown.
  check(/patternUses = \{ date: Boolean\(res && res\.usesDate\), time: Boolean\(res && res\.usesTime\) \}/.test(src),
    "the flags are read off the preview the panel already requests");
  check(/d\.classList\.toggle\("hidden", !patternUses\.date\)/.test(src)
    && /t\.classList\.toggle\("hidden", !patternUses\.time\)/.test(src),
    "…and drive each row's visibility");
  // .fv-counter is display:flex, and the only other .hidden in the file is
  // scoped to #fields-panel — so without its own rule the toggle is inert
  // and both rows show regardless.
  check(/\.fv-counter\.hidden \{ display: none; \}/.test(src),
    "…against a CSS rule that actually hides them");
}

console.log("\n12. (§84) copy-engine keeps the destination path per file");
{
  // Asserted at the source: n.files is built deep inside runCopyJob's
  // closure, and the fixture in section 10 supplies destPath itself — so
  // nothing there would notice the engine dropping it again.
  const eng = fs.readFileSync(path.join(__dirname, "..", "src", "main", "copy-engine.js"), "utf8");
  const m = /n\.files = fileResults\.map\(\(f\) => \{[\s\S]*?\}\);/.exec(eng);
  check(Boolean(m), "the per-file trim is still there");
  check(m && /destPath: d\?\.path/.test(m[0]),
    "…and carries the destination path, not just the source one",
    m ? (m[0].match(/destPath:[^,]*/) || ["(absent)"])[0] : "");
  check(m && /const d = f\.destinations\.find\(\(x\) => x\.destRoot === n\.path\)/.test(m[0]),
    "…looked up for THIS node, matching summarizeRoot's own pattern");
}

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
