# Claude Code prompt — desktop: "Destination Folder" on a cascade node must narrow it, not duplicate it

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §89 — read it first. Do not run `npm test` or any e2e
script — this is renderer-only (`index.html`), and there is no scoped
pure-node test file for it yet; write one if practical (see Build step
4), otherwise verify by code inspection and say so plainly in the build
report.

## Current state (confirmed, don't re-investigate)

- `narrowingTarget(p, parentId)` (`index.html:1731-1746`) only matches
  destinations with `n.parentId === null` — cascade children are
  invisible to it.
- `addDest(p, parentId = null)` (`:1748-1783`) pushes a new node with
  whatever `parentId` the CALLER passed, not the narrowed node's own
  `parentId` (`:1772-1776`).
- Reproduced on video two ways: right-clicking a volume that's already a
  cascade child, and right-clicking the cascade node's own tile — both
  via "Destination Folder ▸" → a recent folder — both create an
  independent new ROOT destination instead of narrowing the existing
  cascade node's folder, leaving the old cascade node untouched and the
  `Copy & Verify` count inflated (confirmed `(2, 1 cascaded)` →
  `(3, 1 cascaded)` from one such action).

## Build

1. `narrowingTarget()` (`:1731-1746`): remove the `n.parentId === null`
   condition from the match. Match any existing destination node on the
   same device (`deviceFor(n.path) === dev`), excluding the exact path
   itself and projects, regardless of where it sits in the cascade tree.
2. Distinguish "caller explicitly wants root" from "caller wants
   whatever's already on this device, wherever it sits" at `addDest`'s
   call sites. `parentId = null` currently means both. Introduce a
   distinct default (e.g. `parentId = undefined`) meaning "inherit from
   whatever gets narrowed, or root if nothing does." Inside `addDest`:
   ```
   const narrowed = narrowingTarget(p, parentId === undefined ? null : parentId);
   const resolvedParentId = parentId === undefined
     ? (narrowed ? narrowed.parentId : null)
     : parentId;
   destNodes.push({ id: newId(), path: p, parentId: resolvedParentId });
   ```
   (Adjust `narrowingTarget`'s own `parentId !== null` early-return at
   `:1732` accordingly now that callers may pass `undefined` — decide
   whether that check should key off the NEW inherit-sentinel or stay
   keyed off an explicit non-null parentId; get this right, it's the
   guard against narrowing kicking in when a caller explicitly asked
   for a specific cascade parent.)
3. Update call sites. For each, decide deliberately whether it means
   "root, explicitly" or "inherit":
   - `:2441`, the volume tile's "Destination Folder ▸" submenu
     (`(f) => addDest(f, null)`) — this is "apply to whatever's already
     assigned on this device" in spirit (it's offered on a tile that
     may already be assigned). Change to the inherit form.
   - `:2475-2493`, "Choose a different folder/file…" on an existing
     dest tile (`role === "dest"`) — same reasoning, this IS narrowing
     the tile you right-clicked. Change to inherit. Note this path also
     calls `removeDest(path)` right after `addDest` — re-check that
     removing the OLD node after the new one now correctly inherits its
     `parentId` doesn't orphan anything `removeDest`'s child-promotion
     logic (`:1812-1822`) would otherwise need to handle (it shouldn't,
     since the new node already occupies the inherited parent slot, but
     confirm rather than assume).
   - `:2457`, "Also use as Destination…" (`addDest(path, null)`, on a
     tile currently held as SOURCE) — this is a genuinely new
     destination being introduced from a role change, not narrowing an
     existing destination on that device (there shouldn't be one, since
     the tile was held as source). Leave as explicit root
     (`addDest(path, null)` with `null` now meaning "explicitly root" —
     confirm this still reads correctly against the new semantics, or
     pass `null` explicitly on purpose here).
   - `:4071`, the OS drag-and-drop handler's `addDest(folder, null)` —
     dropping a fresh folder from Finder onto the Destinations zone.
     Ambiguous: if the dropped folder is on a device with an existing
     destination, should it narrow that one or add beside it? Match
     whatever `narrowingTarget`'s general rule now says (device-level
     narrowing) — do NOT special-case this one differently from the
     menu paths, consistency here is what stops the same bug from
     resurfacing through a fourth entry point later, per the standing
     §73/§89 pattern of this bug recurring through different call sites.
   - Any other `addDest(..., null)` call site `grep` turns up beyond
     these four — classify and decide the same way, and list every one
     you found in the build report even if you conclude "explicit root
     is correct here, unchanged."
4. If practical, add a pure-logic test (new `scripts/test-cascade.js` or
   folded into an existing pure-node script if one already exercises
   `destNodes`/`addDest`-shaped logic extracted from `index.html` the
   way `test-progress.js` does for `onProgress`) asserting: narrowing a
   folder on a device that already holds a CASCADE child updates that
   child's path in place rather than adding a new root node, and the
   cascade child's `parentId` is unchanged after narrowing.

## Verification

Reproduce the exact video scenario: cascade a drive from an existing
destination ("Cascade from…"), then right-click the cascade child tile
→ "Destination Folder ▸" → pick a different folder. Confirm the SAME
tile updates in place (still shown nested under its cascade parent, new
folder path) and `Copy & Verify`'s count does NOT increase. Repeat via
the volume tile's own "Destination Folder ▸" (before it's assigned to
anything) — confirm a genuinely new destination still gets added
correctly when there's nothing to narrow. Confirm narrowing a device
that holds a ROOT (non-cascaded) destination still works exactly as
before (§73's original case, unaffected by this change). Confirm "Also
use as Destination…" from a held-source tile still creates a proper new
root destination, not an accidental narrow of something unrelated.
