# Claude Code prompt — web: shift/cmd-click on the selection checkbox (§101)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §101 — read it first, and skim §99's section above it for
the original `handleCardClick` design this extends. This is
`apps/web`. Per the standing policy in CLAUDE.md's hard rules, run the
full relevant test suite at the end (`npx vitest run` for this app;
there's no Electron/e2e suite in `apps/web`, that's desktop-only) —
don't skip straight to reporting clean.

## Current state (confirmed, don't re-investigate)

- `handleCardClick` (`asset-grid.tsx:282-…`) has the shift-range and
  cmd/ctrl-toggle logic, wired to the card body's `onClick` (`:543`
  grid, `:719` list). This works correctly today — don't touch its
  behavior for the card-body case.
- Grid view's checkbox: `AssetCard`'s `onSelect` prop
  (`asset-grid.tsx:555`) is currently `onSelect={() =>
  toggleAssetSelect(asset.id)}` — ignores the event entirely.
  `AssetCard` itself (`asset-card.tsx:150`) does call
  `onSelect(e)` with the real event, AFTER `e.stopPropagation()` — so
  the event exists and is available, it's just not being read.
- List view's checkbox: a separate inline `<button>`
  (`asset-grid.tsx:740`), `onClick={(e) => { e.stopPropagation();
  toggleAssetSelect(asset.id) }}` — same gap, independent
  implementation from the grid view, needs its own fix.
- `filtered` (`:236`ish, same array §99 already uses) is still the
  correct source of order for range computation — no change there.

## Build

1. Extract the shift/cmd-handling portion of `handleCardClick` into a
   shared function, e.g.:
   ```ts
   const applyModifierSelection = (asset: Asset, e: React.MouseEvent): boolean => {
     if (e.shiftKey) {
       // ...the existing shift-range logic, moved here verbatim...
       return true
     }
     if (e.metaKey || e.ctrlKey) {
       toggleAssetSelect(asset.id)
       setLastClickedId(asset.id)
       return true
     }
     return false
   }
   ```
   Keep the exact existing range-computation logic (over `filtered`,
   additive, no-anchor-falls-back-to-single-select) — don't rewrite
   it, just relocate it.
2. `handleCardClick` becomes:
   ```ts
   const handleCardClick = (asset: Asset, e: React.MouseEvent) => {
     if (applyModifierSelection(asset, e)) return
     setLastClickedId(asset.id)
     onAssetSelect?.(asset, e)
   }
   ```
3. Grid checkbox (`:555`): change `onSelect={() =>
   toggleAssetSelect(asset.id)}` to `onSelect={(e) => {
   if (!applyModifierSelection(asset, e)) { toggleAssetSelect(asset.id);
   setLastClickedId(asset.id) } }}`. Confirm `AssetCard`'s `onSelect`
   prop type actually accepts an event parameter (it should, per
   `asset-card.tsx:150` already calling `onSelect(e)`) — if the TS
   prop signature currently types it as a no-arg function, widen it.
4. List-view checkbox (`:740`): same pattern, inline in the `onClick`.
5. Confirm in BOTH cases that a plain click (no modifier) on the
   checkbox still only toggles and never calls `onAssetSelect` (never
   opens the side panel) — this is the one thing that must not change.

## Verification

Extend `asset-grid-multiselect.test.tsx` with checkbox-specific cases,
not just card-body ones: shift-click the checkbox on two assets
several rows apart, confirm the range selects. Cmd/ctrl-click a
checkbox, confirm it toggles without disturbing an existing selection.
Plain-click a checkbox, confirm it toggles AND does not open the side
panel (assert `onAssetSelect` was not called). Repeat all three for
the list view's separate checkbox implementation. Run the full
`asset-grid-multiselect.test.tsx` file plus `npx vitest run` for the
whole app at the end, per the standing full-test-suite policy — report
pass/fail counts, and flag anything that wasn't already a documented
pre-existing failure (the `api.test.ts`/`notification-store.test.ts`
five, per the last verified run).
