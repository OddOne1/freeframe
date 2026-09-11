# Claude Code prompt — web: halve S/M/L grid card size (double column counts)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §67 — read it first, including the exact target numbers.

## Current state (confirmed, don't re-investigate)

- `apps/web/app/(dashboard)/projects/page.tsx:303-308` —
  `projectGridColsMap`, Tailwind `grid-cols-*` classes at base/sm/lg/xl.
- `apps/web/app/globals.css:112-136` — `.asset-grid[data-size]`, plain
  rule plus three `@container assetgrid` breakpoints (640/1024/1280px).

## Build

Replace the S/M/L rows in both places with the exact doubled values in
`CLAUDE.md` §67's tables. XS is unchanged in both files — do not touch
it. Do not change breakpoint widths, only column counts.

## Verification

Load Projects overview at each of S/M/L, check at a few window widths
that column count matches the new target table. Load an in-project
asset grid at each of S/M/L, same check against the asset-grid table.
Confirm XS is pixel-identical to before (unchanged) in both views.
Actually look at S at the widest breakpoint (12 columns in the asset
grid, 8 in the overview) — if it reads as absurdly dense/unreadable in
the running app rather than just "smaller as asked," say so plainly in
the build report rather than silently shipping it — this was flagged in
the spec as the most extreme cell in the table.
