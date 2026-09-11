# Claude Code prompt — Tune grid density (overview shift, in-project nudge)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §55 — read it first. Pure numeric tuning, no structural
changes.

## Current state (confirmed, don't re-investigate)

- `apps/web/app/(dashboard)/projects/page.tsx:303-308`,
  `projectGridColsMap`:
  `XS: "grid-cols-3 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9"`,
  `S: "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"`,
  `M: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"`,
  `L: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3"`.
- `apps/web/app/globals.css:112-136`, `@container assetgrid` rules:
  base `XS:3 S:2 M:1 L:1`, 640px `XS:4 S:3 M:2 L:1`, 1024px
  `XS:6 S:4 M:3 L:2`, 1280px `XS:8 S:5 M:3 L:2`.

## Build

**Overview** — replace `projectGridColsMap` with:
```ts
const projectGridColsMap: Record<CardSize, string> = {
  XS: "grid-cols-3 sm:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9",
  S:  "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
  M:  "grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3",
  L:  "grid-cols-1 sm:grid-cols-1 lg:grid-cols-1 xl:grid-cols-2",
}
```

**In-project** — replace the four `@container assetgrid` blocks in
`globals.css` (base rule + three breakpoints) so the values become:
```css
.asset-grid[data-size='XS'] { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.asset-grid[data-size='S']  { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.asset-grid[data-size='M']  { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.asset-grid[data-size='L']  { grid-template-columns: repeat(1, minmax(0, 1fr)); }

@container assetgrid (min-width: 640px) {
  .asset-grid[data-size='XS'] { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .asset-grid[data-size='S']  { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .asset-grid[data-size='M']  { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .asset-grid[data-size='L']  { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container assetgrid (min-width: 1024px) {
  .asset-grid[data-size='XS'] { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .asset-grid[data-size='S']  { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .asset-grid[data-size='M']  { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .asset-grid[data-size='L']  { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container assetgrid (min-width: 1280px) {
  .asset-grid[data-size='XS'] { grid-template-columns: repeat(9, minmax(0, 1fr)); }
  .asset-grid[data-size='S']  { grid-template-columns: repeat(6, minmax(0, 1fr)); }
  .asset-grid[data-size='M']  { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .asset-grid[data-size='L']  { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
```

Any test that snapshots or asserts specific column counts for these
sizes will need its expected values updated to match — that's
expected, not a regression to investigate.

## Note for the build report

**This is a first-pass numeric estimate, not a measured result** —
say so plainly rather than reporting it as verified. The user needs
to actually look at both grids at each size/breakpoint before this is
considered done; flag clearly that a second tuning round is likely.

## Verification

Confirm the build/tests reflect the new numbers (update any test that
hardcodes the old column counts). Beyond that, this specifically
needs human eyes in a browser — no automated check can confirm "this
now looks like what the user pictured."
