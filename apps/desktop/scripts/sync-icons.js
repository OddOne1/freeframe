#!/usr/bin/env node
// Generates src/renderer/icons.js from the `lucide` package.
//
// Why generated rather than hand-copied SVG: apps/web uses lucide-react
// ^0.511.0, and this app pins `lucide` at exactly 0.511.0 — the same
// release, so the icon family is provably identical rather than drifting
// from whatever version someone copied a path from months ago.
//
// Why generated rather than imported at runtime: the renderer runs with
// sandbox:true / nodeIntegration:false, so it cannot require() anything,
// and a sandboxed preload can only require a small allow-list that doesn't
// include third-party packages. A build-time codegen step is the honest
// way to get package data into this renderer without adding a bundler.
//
// Output is gitignored — edit the ICONS map here, not the generated file.

const fs = require("node:fs");
const path = require("node:path");
const lucide = require("lucide");
const lucideVersion = require("lucide/package.json").version;

// Name → lucide icon. Where apps/web already uses an icon for the
// equivalent concept, the same one is used here rather than picking a new
// one, so the two apps stay visually consistent:
//   RefreshCw, LayoutGrid, List, X, AlertTriangle, FolderOpen, HardDrive
// are all already in apps/web's vocabulary.
const ICONS = {
  refresh: "RefreshCw",
  grip: "GripVertical",
  close: "X",
  warning: "AlertTriangle",
  check: "Check",
  // View toggle — same pair apps/web's appearance-popover.tsx already uses.
  viewList: "List",
  viewGrid: "LayoutGrid",
  // Volume types. Distinct enough to read at a glance at 28px:
  //   removable → a card/stick you physically pull out
  //   internal  → this machine itself, not a generic disk. Two near-identical
  //               HardDrive glyphs for internal vs external would carry no
  //               information; the distinction that matters is "your Mac" vs
  //               "a drive on a cable".
  //   external  → the standard drive glyph
  //   network   → a box at the other end of a wire
  //   folder    → a chosen subfolder rather than a whole volume
  removable: "MemoryStick",
  internal: "Laptop",
  external: "HardDrive",
  network: "Server",
  folder: "FolderOpen",
  arrowRight: "ArrowRight",
};

/** lucide ships icons as [tag, attrs] child tuples; wrap them in the same
 *  <svg> shell lucide-react renders, so stroke weight and sizing match the
 *  web app exactly rather than approximately. */
function toSvg(children) {
  const body = children
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    body +
    "</svg>"
  );
}

const out = {};
const missing = [];
for (const [key, name] of Object.entries(ICONS)) {
  const icon = lucide[name];
  if (!icon) { missing.push(name); continue; }
  out[key] = toSvg(icon);
}
if (missing.length) {
  console.error(`[sync-icons] Not in lucide@${lucideVersion}: ${missing.join(", ")}`);
  process.exit(1);
}

const file =
  `// GENERATED FILE — DO NOT EDIT.\n` +
  `// Produced by scripts/sync-icons.js from lucide@${lucideVersion},\n` +
  `// the same release apps/web pins via lucide-react ^0.511.0.\n` +
  `window.FF_ICONS = ${JSON.stringify(out, null, 2)};\n`;

const OUT = path.join(__dirname, "..", "src", "renderer", "icons.js");
fs.writeFileSync(OUT, file);
console.log(`[sync-icons] ${path.relative(process.cwd(), OUT)} ← lucide@${lucideVersion} (${Object.keys(out).length} icons)`);
