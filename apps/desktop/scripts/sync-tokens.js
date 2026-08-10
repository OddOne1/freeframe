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

// The wordmark, for the sign-in screen. Same reasoning as the tokens: this
// is apps/web's own asset rather than a redrawn approximation, so the
// desktop sign-in shows the actual FreeFrame logo and follows it if it ever
// changes. The .svg is the one to take — apps/web's login uses logo-full.png,
// but that's a 3500px raster for a mark rendered ~44px tall here.
const LOGO_SRC = path.join(__dirname, "..", "..", "web", "public", "logo.svg");
const LOGO_OUT = path.join(__dirname, "..", "src", "renderer", "logo.svg");
if (fs.existsSync(LOGO_SRC)) {
  fs.copyFileSync(LOGO_SRC, LOGO_OUT);
  console.log(`[sync-tokens] ${path.relative(process.cwd(), LOGO_OUT)} ← apps/web/public/logo.svg`);
} else {
  // Not fatal: the sign-in screen falls back to a text wordmark. A missing
  // logo shouldn't be able to fail a build.
  console.warn(`[sync-tokens] no logo at ${LOGO_SRC} — sign-in will use the text wordmark`);
}
