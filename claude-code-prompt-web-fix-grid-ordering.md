# Claude Code prompt — web: fix S/M/L density ordering broken by §67

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §67 correction — read it first, including the constraint
explanation (XS's own density leaves no room for S to fully double at
the two smallest breakpoints — this is expected, not a bug).

## Current state (confirmed, don't re-investigate)

- `1b7f16e` (§67) already shipped and pushed. It inverted the asset
  grid's size ladder: S ended up denser (more columns = smaller cards)
  than XS at every breakpoint, and M denser than XS at most. The
  overview grid (`projectGridColsMap` in `page.tsx`) did NOT have this
  problem — its S/M/L already stay behind XS at every breakpoint. Only
  `apps/web/app/globals.css`'s `.asset-grid[data-size]` rules need
  correction.
- The metadata-truncation issue from `1b7f16e`'s build report (S cards
  narrower than ~120px, cutting off file size) is EXPECTED to resolve
  once S is corrected to stay wider than XS — don't build a separate
  fix for it, just re-verify after this correction.

## Build

Replace `globals.css`'s `.asset-grid[data-size]` S/M/L values (base
rule plus all three `@container` breakpoints) with the corrected table
in `CLAUDE.md`'s §67 correction section:
```
             base   640    1024   1280
XS:            4      5      7      9   (unchanged)
S:             3      4      6      8
M:             2      3      5      7
L:             1      2      4      6
```
Do not touch `page.tsx`'s `projectGridColsMap` — it's already correct.
Do not touch XS in either file.

## Verification

At every one of the four breakpoints, confirm column count strictly
decreases XS > S > M > L (this is the entire point — check the actual
arithmetic, don't just eyeball it). Confirm cards get visually LARGER
going XS → S → M → L at every window width, not just at some. Re-check
the metadata line (name · time · file size) at S — confirm it now fits
without truncation; if it still doesn't, say so plainly in the build
report rather than treating it as resolved. Confirm the overview grid
is byte-for-byte unchanged from `1b7f16e`.
