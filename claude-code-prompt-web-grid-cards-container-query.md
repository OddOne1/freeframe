# Claude Code prompt — Card size stays fixed when side panel opens

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §50 — read it first.

## Current state (confirmed, don't re-investigate)

Root cause confirmed by reading the actual layout, not guessed:

- `apps/web/app/(dashboard)/projects/[id]/page.tsx:594` — root flex
  row. Main content holding `AssetGrid`: `flex-1 min-w-0`
  (`:879-880`). Comments/Fields panel: fixed `w-[360px] shrink-0`
  flex sibling (`:1351-1352`, mounts `xl:` and above only).
- `apps/web/components/projects/asset-grid.tsx:82-87`'s
  `gridColsMap` uses plain Tailwind `grid-cols-N`, keyed to
  **viewport** breakpoints (`sm:`/`lg:`) via media queries — no
  `@container` anywhere in the file. Column count has no visibility
  into the 360px sibling panel.
- Net effect: opening the panel shrinks the main content's real
  pixel width by 360px. Column count for that viewport stays the
  same (media queries don't know about the sibling), so each
  implicit `1fr` grid track — and every card on it — physically
  shrinks to fit. That's the bug: card SIZE changes, which the user
  wants fixed. Only column count/position should change.

## Build

Convert `AssetGrid`'s grid sizing from viewport-based to
container-based:

1. Check whether `@tailwindcss/container-queries` (or equivalent) is
   already installed (`apps/web/package.json`, `tailwind.config.*`)
   — add it if not.
2. Wrap the grid's actual width-determining ancestor in a
   `@container` (`container-type: inline-size`) — likely the
   `flex-1 min-w-0` main content div in
   `page.tsx:879-880`, or a dedicated wrapper just inside
   `AssetGrid` itself if that's cleaner given how the component is
   composed.
3. Replace `gridColsMap`'s `sm:`/`lg:`/`xl:` viewport variants
   (`asset-grid.tsx:82-87`) with `@sm:`/`@lg:`/`@xl:` container
   variants, keeping the same per-size (S/M/L, and XS if
   `claude-code-prompt-web-grid-xs-and-overflow.md` has already
   landed) column counts — the goal is identical card pixel size at
   a given container width regardless of whether that width comes
   from a wide viewport or a narrow one caused by the side panel
   being open.
4. Re-check all three `AssetGrid` mount points using `gridColsMap`
   (`asset-grid.tsx:254, 346, 411`) get the container-query classes
   consistently.

## Verification

At a wide viewport (≥1600px), side panel closed, note card pixel
width at S/M/L. Open the Comments/Fields panel — confirm card pixel
width is unchanged and column count drops instead to fit the
narrower container. Close the panel — columns return without a
reload. At a narrower viewport where the panel closing/opening pushes
column count down to 1 — confirm cards don't shrink below their
defined size; report what actually happens in that edge case (e.g.
horizontal scroll, or a documented minimum) rather than silently
violating the fixed-size requirement.
