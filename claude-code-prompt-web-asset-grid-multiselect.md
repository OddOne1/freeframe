# Claude Code prompt — web: shift-range select + select-all in the asset grid

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §99 — read it first. This is `apps/web`, a Next.js app —
confirm you're editing the right stack before starting (this
engagement also has a separate Electron desktop app in the same repo;
don't confuse the two).

## Current state (confirmed, don't re-investigate)

- `apps/web/components/projects/asset-grid.tsx`: `selectedAssetIds`/
  `selectedFolderIds` (`:144-145`) are the bulk-action selection state.
  `toggleAssetSelect(assetId)` (`:182-189`) is a plain additive toggle,
  currently only reachable via `AssetCard`'s selection-checkbox overlay
  (`onSelect={() => toggleAssetSelect(asset.id)}`, grid view `:441`,
  list view has an equivalent around `:626`).
- The card's own `onClick` (`:429` grid, `:605` list) calls
  `onAssetSelect?.(asset, e)`, which in the parent
  (`app/(dashboard)/projects/[id]/page.tsx:1088-1091`) sets
  `selectedAsset` — a completely different piece of state that opens
  the single-asset side detail panel. This must keep working for a
  plain, unmodified click.
- `filtered` (`asset-grid.tsx:236`) is the array actually rendered, in
  the current sort/filter order — use this, not the raw `assets` prop,
  when computing a shift-click range, or the range will be wrong
  whenever a filter or non-default sort is active.
- No keyboard listener for Cmd/Ctrl+A exists anywhere in this file or
  `page.tsx`.
- The bulk-action bar (`onBulkDelete` wiring around `:756`) is where a
  "Select all" control belongs — find its container and match its
  existing button style.

## Build

1. Add `lastClickedId` state (`React.useState<string | null>`).
2. In both card `onClick` handlers (`:429` grid, `:605` list):
   - Plain click (no modifiers): keep existing behavior
     (`onAssetSelect?.(asset, e)`), and also set `lastClickedId =
     asset.id`.
   - `e.shiftKey`: compute the index range in `filtered` between
     `lastClickedId` (or, if null, just this asset) and the clicked
     asset; add every id in that range to `selectedAssetIds`
     (additive — spread the existing Set, don't replace it). Do NOT
     call `onAssetSelect` in this branch (don't also open the side
     panel). Update `lastClickedId` to the newly-clicked asset.
   - `e.metaKey || e.ctrlKey`: call `toggleAssetSelect(asset.id)`
     instead of `onAssetSelect`. Update `lastClickedId`.
   - Remember to `e.preventDefault()` on the shift-click case if
     needed to stop native text-selection drag artifacts (test this —
     browsers sometimes select page text on shift-click near text
     nodes).
3. Add a "Select all" button to the bulk-action bar area (~`:756`):
   `onClick={() => setSelectedAssetIds(new Set(filtered.map(a =>
   a.id)))}`. Decide whether it also selects folders
   (`selectedFolderIds`) per §99's point 5 — state your decision in the
   build report.
4. Add a scoped keydown listener (component-level `useEffect`, not a
   raw `window.addEventListener` with no cleanup) for Cmd/Ctrl+A that
   triggers the same select-all action, but bails out if
   `document.activeElement` is an `<input>`, `<textarea>`, or has
   `isContentEditable === true` — do not hijack native select-all
   elsewhere on the page. Clean up the listener on unmount.
5. Verify the right-click context menu's existing
   "outside-selection replaces it" logic (`:205-231`) still behaves
   correctly once large ranges exist — don't change it unless you find
   an actual conflict during testing; if you do, explain what and why
   in the build report.

## Verification

In a project with 15+ assets: plain-click one (confirm side panel
still opens), shift-click one several rows down (confirm the whole
visual range gets selected and the bulk-action bar's count updates
correctly), Cmd/Ctrl-click a separate non-adjacent asset (confirm it
adds without clearing the range). Click Select All with no filter
active (confirm every visible asset is selected). Type into the search
box to filter down to a subset, click Select All again (confirm only
the filtered subset gets selected, not the full unfiltered set). Click
into some other text input on the page and press Cmd/Ctrl+A (confirm
it does the browser's normal thing there, not the grid's select-all).
Bulk-delete a shift-selected range (confirm exactly those assets are
deleted). If component or e2e tests exist for this file, run whichever
ones are safe to run in this environment and report results; if none
exist, say so rather than skipping silently.
