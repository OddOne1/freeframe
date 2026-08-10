#!/usr/bin/env node
// Copies the canonical design tokens into the renderer.
//
// This renderer loads index.html as a plain file with no bundler, so it
// can't `@import` a package the way apps/web does. Rather than add a
// bundler for one CSS file, the tokens are copied in before dev/build/test
// and loaded with a plain <link>.
//
// The output is generated and gitignored — edit
// packages/design-tokens/tokens.css, never src/renderer/tokens.css.

const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "..", "..", "packages", "design-tokens", "tokens.css");
const OUT = path.join(__dirname, "..", "src", "renderer", "tokens.css");

if (!fs.existsSync(SRC)) {
  console.error(`[sync-tokens] Canonical tokens not found at ${SRC}`);
  process.exit(1);
}

const banner =
  "/* GENERATED FILE — DO NOT EDIT.\n" +
  "   Copied from packages/design-tokens/tokens.css by scripts/sync-tokens.js.\n" +
  "   Edit the canonical file; this one is overwritten on every dev/build. */\n\n";

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, banner + fs.readFileSync(SRC, "utf8"));
console.log(`[sync-tokens] ${path.relative(process.cwd(), OUT)} ← packages/design-tokens/tokens.css`);
