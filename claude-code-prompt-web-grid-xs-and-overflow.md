# Claude Code prompt — XS size + Projects overview toggle + fix file-size overflow

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §51 — read it first. **Build before**
`claude-code-prompt-web-grid-cards-container-query.md` if doing both,
so the container-query conversion only has to handle the final
S/M/L/XS column maps once, not be redone after XS is added.

## Current state (confirmed, don't re-investigate)

- In-project size toggle: `AppearancePopover`
  (`apps/web/components/projects/appearance-popover.tsx:174-178`),
  bound to `cardSize`/`setCardSize` on global `useViewStore`
  (`apps/web/stores/view-store.ts`, `persist`, localStorage key
  `freeframe-view-settings`). Column effect:
  `apps/web/components/projects/asset-grid.tsx:82-87` (`gridColsMap`).
- Projects overview (`apps/web/app/(dashboard)/projects/page.tsx`)
  has its own local `viewMode` state (line 299, grid/list only) — no
  size control exists there today. Grid: fixed single density,
  `ProjectSection`, lines 157-166
  (`grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5`).
- **User's explicit decision**: overview size and in-project size are
  independent settings — separate state, separate localStorage key,
  changing one must not affect the other.
- Overflow bug, confirmed by reading the component: the
  author/date/file-size row is a single clamped line,
  `apps/web/components/projects/asset-card.tsx:245-249`
  (`<p className="text-2xs text-text-tertiary line-clamp-1">` wrapping
  `authorName • relative-time • formatBytes(fileSize)`). A long
  uploader name overflows the line and `line-clamp-1` truncates the
  WHOLE line — file size vanishes. Exists at today's S size already,
  not new to XS.

## Build

1. **New independent overview size state** — either a second field
   (e.g. `projectCardSize`) on `useViewStore`, or a wholly separate
   persisted store, whichever fits this codebase's existing pattern
   better. Must not read or write `cardSize`'s value or localStorage
   key.
2. **Add XS everywhere**: `AppearancePopover` and the new overview
   control both get a 4th option. **UI order is XS, S, M, L**
   (smallest to largest, left to right) — check the existing
   control's current order and fix it if it isn't already ascending.
   Add an `XS` entry to `gridColsMap`
   (`asset-grid.tsx:82-87`) with a higher column count than `S`'s
   current values. Build the Projects overview's own 4-entry
   column-count map from scratch (it has none today).
3. **Fix the file-size overflow** — not XS-only, fix it at every
   size where it can occur. In
   `asset-card.tsx:245-249`, stop hard-truncating the whole
   metadata line to 1 line. Either: (a) allow the line to wrap
   naturally (drop `line-clamp-1`, use `flex-wrap` or `line-clamp-2`)
   so file size can fall to its own line instead of disappearing, or
   (b) give `authorName` its own bounded `truncate` span and keep
   " • {relative-time} • {formatBytes(fileSize)}" outside the
   truncated portion so it's never eaten by the ellipsis. Either is
   acceptable — the hard requirement is that file size must always
   render, never be silently cut off.

## Verification

Set overview grid to XS — column count increases beyond S's current
density, cards render correctly. Set in-project size to XS
separately — confirm changing overview size does NOT change
in-project size on reload and vice versa (check both localStorage
keys independently). Confirm button order is XS, S, M, L in both
locations. Create a test user with a long display name (40+ chars),
upload as them, view at XS and S — confirm file size is visible
(wrapped or name truncated, your implementation choice), never fully
hidden. Confirm M/L rendering is unchanged from before this change.
