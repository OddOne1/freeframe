#!/usr/bin/env node
// File sizes match the user's OWN operating system (§190) — pure, so tested
// directly.
//
// Found against real data rather than theory: a 135,458,109-byte file that
// macOS Finder calls "135,5 MB" was showing as "129.2 MB". The byte count
// was never wrong — every copy of the formatting divided by 1024 and then
// labelled the result "MB", which by SI definition means 1000-based.
//
// "Just switch to decimal" is also wrong, because file managers disagree:
// Windows Explorer really does use 1024 while still printing "MB", so a
// Windows user's own Explorer agrees with the OLD number. Whichever single
// convention is hardcoded, somebody sees a size that contradicts their file
// manager — which is exactly the reason to distrust a storage system.
//
// This app had the bug TWICE on its own (panel.js's fmtBytes and an inline
// formatBytes in index.html); both now go through src/renderer/byte-units.js.
//
// Run: node scripts/test-format-bytes.js
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");

const RENDERER = path.join(__dirname, "..", "src", "renderer");
const { formatBytes, formatBytesIn, byteUnitModeFor } = require(
  path.join(RENDERER, "byte-units.js"),
);

let fail = 0;
function check(ok, label, detail = "") {
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  — " + detail : ""}`);
}

/** The file from the investigation. */
const REAL_FILE = 135458109;

console.log("\nthe file that started this");
check(
  formatBytesIn(REAL_FILE, "decimal") === "135.5 MB",
  "reads as Finder reads it, in decimal",
  formatBytesIn(REAL_FILE, "decimal"),
);
check(
  formatBytesIn(REAL_FILE, "binary") === "129.2 MB",
  "reads as Windows Explorer reads it, in binary",
  formatBytesIn(REAL_FILE, "binary"),
);
check(
  formatBytesIn(REAL_FILE, "decimal") !== formatBytesIn(REAL_FILE, "binary"),
  "and those really are two different numbers for one byte count",
);

console.log("\nplatform -> convention");
check(byteUnitModeFor("win32") === "binary", "win32 gets binary, matching Explorer");
for (const p of ["darwin", "linux", "freebsd", "android", ""]) {
  check(
    byteUnitModeFor(p) === "decimal",
    `${p || "(unknown)"} gets decimal, matching Finder/GNOME`,
  );
}

console.log("\nthe maths, both ways");
const cases = [
  [0, "decimal", "0 B"],
  [0, "binary", "0 B"],
  [500, "decimal", "500 B"],
  [1000, "decimal", "1.0 KB"],
  [1024, "binary", "1.0 KB"],
  [1500000, "decimal", "1.5 MB"],
  [1.5 * 1024 * 1024, "binary", "1.5 MB"],
  [1500000000, "decimal", "1.5 GB"],
  [1610612736, "binary", "1.5 GB"],
];
for (const [bytes, mode, expected] of cases) {
  const got = formatBytesIn(bytes, mode);
  check(got === expected, `${bytes} in ${mode} -> ${expected}`, got);
}
check(formatBytesIn(null, "decimal") === "—", "a missing size reads as an em dash");
check(formatBytesIn(undefined, "binary") === "—", "undefined too");
check(formatBytesIn(0, "decimal") === "0 B", "but zero is a real answer, not missing");
check(
  formatBytesIn(1e30, "decimal").endsWith(" TB"),
  "does not run off the end of the unit list",
);

console.log("\nreading the platform through the preload bridge");
// The renderer has no `process` of its own — contextIsolation is on and
// nodeIntegration off — so the platform arrives on window.freeframe.
const savedFF = global.window && global.window.freeframe;
global.window = global.window || {};
global.window.freeframe = { platform: "win32" };
check(formatBytes(REAL_FILE) === "129.2 MB", "a Windows renderer gets binary");
global.window.freeframe = { platform: "darwin" };
check(formatBytes(REAL_FILE) === "135.5 MB", "a Mac renderer gets decimal");
global.window.freeframe = undefined;
check(
  formatBytes(REAL_FILE) === formatBytesIn(REAL_FILE, byteUnitModeFor(process.platform)),
  "with no bridge it falls back to this process's own platform",
);
if (savedFF) global.window.freeframe = savedFF;

console.log("\nthe duplicates are actually gone");
// The point of the change: one implementation, not four. A reintroduced
// `while (n >= 1024)` loop in either renderer file is the bug coming back.
for (const f of ["panel.js", "index.html"]) {
  const src = fs.readFileSync(path.join(RENDERER, f), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    !/while\s*\(\s*n\s*>=\s*1024/.test(code),
    `${f} has no byte maths of its own any more`,
  );
  check(
    /ByteUnits\./.test(code),
    `${f} goes through the shared module`,
  );
}
// Both documents that load panel.js must also load what it now depends on.
for (const doc of ["index.html", "panel.html"]) {
  const src = fs.readFileSync(path.join(RENDERER, doc), "utf8");
  check(
    src.includes('src="byte-units.js"'),
    `${doc} loads byte-units.js`,
  );
}
// And the bridge has to actually carry the platform across.
const preload = fs.readFileSync(
  path.join(__dirname, "..", "src", "main", "preload.js"),
  "utf8",
);
check(
  /platform:\s*process\.platform/.test(preload),
  "preload exposes process.platform to the renderer",
);

console.log(fail === 0 ? "\nOK" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
