# Claude Code prompt — desktop: Destination "Choose folder…" narrows same-device dest, doesn't duplicate

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §69 — read it first, including the frame-by-frame repro.

## Current state (confirmed, don't re-investigate)

- `index.html:3069-3089` — the `[data-choose]` click handler. For
  `which !== "source"` it always calls `addDest(folder, null)` — no
  check against existing destinations.
- `index.html:2313-2329` — the CORRECT precedent, already working: a
  tile's right-click "Choose a different folder/file…" does
  `addDest(f, null)` then `removeDest(path)` — swap, not duplicate.
- `deviceFor(path)` already exists (used at `:3084` in this same
  handler) — resolves a path to its underlying device/volume identity.
- `destNodes` (array) holds `{ id, path, parentId }`. Top-level
  destinations have `parentId === null`.

## Build

In the `data-choose="dest"` branch of the handler at `:3069-3089`,
before calling `addDest(folder, null)`: check whether any EXISTING
top-level destination node (`parentId === null`) resolves to the same
device as the newly picked `folder` (via `deviceFor()`, same helper
already in use two lines above). If one is found:
- Call `addDest(folder, null)` then `removeDest(existingNode.path)` —
  same add-then-remove-old pattern as the working context-menu path at
  `:2328-2329`, for consistency and to reuse its ordering guarantee
  (add first, so a failure between the two calls leaves the destination
  populated rather than empty).
- If no existing top-level destination shares that device, behavior is
  unchanged — `addDest(folder, null)` as today, a genuine new parallel
  destination.

Do not change anything about drag-and-drop adding a destination, or
about cascading (`parentId` set) — this is scoped to the header
"Choose folder…" button only.

## Verification

Reproduce the exact recorded sequence: drag a drive into Destination,
then use the Destination column's "Choose folder…" button to pick a
subfolder ON THAT SAME DRIVE — confirm the result is ONE destination
tile showing the subfolder, not two, and "Copy & Verify" does not show
"→ 2". Drag a drive into Destination, then use "Choose folder…" to pick
a folder on a DIFFERENT drive — confirm this still adds a second,
genuinely separate destination (the parallel-copy feature must still
work). Confirm the tile's own right-click "Choose a different
folder/file…" is unaffected (still works exactly as before).
