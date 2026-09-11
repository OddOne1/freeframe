# Claude Code prompt — desktop: Copy & Verify shows parallel vs. cascade counts as separate icon groups

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §92 — read it first. Renderer-only. Do not run `npm test`
or any e2e script — this is a visual change with no pure-logic
component worth a new test script; verify by code inspection and note
that in the build report.

## Current state (confirmed, don't re-investigate)

- `index.html:2927-2935` computes the button label:
  ```js
  const cascades = destNodes.filter((n) => n.parentId !== null).length;
  $("start").textContent = cascades
    ? `Copy & Verify (${destNodes.length}, ${cascades} cascaded)`
    : destNodes.length > 1
      ? `Copy & Verify → ${destNodes.length}`
      : "Copy & Verify";
  ```
  `destNodes.length` mixes root and cascade nodes into one count, which
  is what read as "2 copies" for what was actually one direct copy plus
  one cascade hop.
- The button itself is built once and moved between zones
  (`:3166-3170`, `const btn = el("button", { class: "primary", text:
  "Copy & Verify" }); btn.id = "start";`) — it currently only ever gets
  `.textContent` set, never child elements, so this build changes it to
  carry real child nodes (icon + count spans) instead of a text string.
- `.arrow` spans already exist elsewhere for a plain "→" between two
  entries (`:2911`, cascade-chain breadcrumb rendering) — check that
  styling before inventing new CSS.
- Icons load through `icons.js` (lucide) — check what's already
  imported/available before adding a new icon; a corner/hook arrow
  (something like `CornerDownRight` or `Redo2` in lucide's set) is
  probably already close to what's needed without hand-drawing an SVG.

## Build

1. Split the single `cascades` count into two:
   `parallel = destNodes.filter((n) => n.parentId === null).length`
   (root destinations) and `cascades` (unchanged — `n.parentId !==
   null`).
2. Replace the button's `.textContent` assignment with building real
   child content: "Copy & Verify" label text, then a straight-arrow
   icon + `parallel` count (only rendered when `parallel > 1` — a
   single direct destination shouldn't show a redundant "→1"), then,
   only when `cascades > 0`, a distinct corner/hook icon + `cascades`
   count. Use `replaceChildren()` on the button rather than rebuilding
   it from scratch each render, matching this app's existing
   incremental-update conventions elsewhere.
3. Keep the three existing states' spirit: a plain single destination
   with no cascade shows just "Copy & Verify" with no icons at all (not
   "→1"); one destination that IS cascaded shows the corner icon with
   its own count and no arrow-count clutter; several parallel
   destinations show the arrow group; both together show both groups
   side by side.
4. Make sure the button stays keyboard/screen-reader sensible — an
   icon-plus-number pair needs an accessible label (e.g. `aria-label`
   summarizing "2 direct, 1 cascaded" on the relevant span, or on the
   button as a whole) since the visual icons alone don't carry that
   information to assistive tech the way the old text did.

## Verification

Confirm by reading the four cases against real `destNodes` shapes (a
Node/JS console check or code trace is fine, no Electron needed): one
plain destination → "Copy & Verify" alone. Two parallel destinations,
no cascade → arrow icon + "2", no corner icon. One destination cascaded
from another (the exact video scenario from §89) → corner icon + "1",
no arrow-count. Two parallel plus one cascaded off one of them → both
icon groups shown together with their own correct counts. Open the app
and visually confirm the button doesn't look cramped or misaligned with
icons added, and that the accessible label reads sensibly with a screen
reader or the accessibility inspector.
