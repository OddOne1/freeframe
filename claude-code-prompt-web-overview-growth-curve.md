# Claude Code prompt — web: Projects overview S/M/L on a 1/3-growth curve

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §68 — read it first, including the exact formula and the
validation target.

Scope: Projects OVERVIEW grid only (`projectGridColsMap` in
`apps/web/app/(dashboard)/projects/page.tsx`). Do NOT touch the
in-project asset grid (`globals.css`'s `.asset-grid[data-size]`) — that
one is out of scope here entirely, handled by a separate,
already-written prompt.

## Current state (confirmed, don't re-investigate)

- `page.tsx:303-308`, current live values (base/sm/lg/xl): XS `3/5/7/9`
  (unchanged by this task), S `2/4/6/8`, M `2/4/4/6`, L `2/2/2/4`.
- Original pre-§67 values, for reference only (the L validation target
  below is this table's M row): XS `3/5/7/9`, S `1/2/3/4`, M `1/2/2/3`,
  L `1/1/1/2`.

## Build

1. In the running app (or via a script that renders the grid container
   at each of the four breakpoint widths — 640/1024/1280px plus the
   base/no-breakpoint case, matching what `XS`'s own breakpoints use),
   measure the actual rendered card width for XS at each breakpoint.
2. Compute target widths: `width(S) = width(XS) × 4/3`,
   `width(M) = width(S) × 4/3`, `width(L) = width(M) × 4/3`, at each
   breakpoint independently.
3. For each breakpoint, find the integer column count that produces a
   rendered card width closest to each target (accounting for the
   grid's actual gap size, not just container-width ÷ columns).
4. Enforce strict `XS_cols > S_cols > M_cols > L_cols` at every
   breakpoint — if the nearest-width column count for a tier would tie
   or invert with its neighbor, adjust by one column in whichever
   direction preserves the ordering while staying closest to the width
   target, and note in the build report where this adjustment happened.
5. Check the validation target: is L's resulting rendered width close
   to what the ORIGINAL pre-§67 M rendered at (the `1/2/2/3` column
   values, computed at the same breakpoints)? Report the actual
   comparison (widths in px, not just column counts) rather than
   asserting a match. If it's meaningfully off, say so and explain why
   (e.g. the ordering constraint from step 4 forced a compromise) rather
   than silently calling it close enough.
6. Update `projectGridColsMap`'s S/M/L rows with the resulting Tailwind
   classes. Leave XS untouched.

## Verification

At each of the four breakpoints, confirm rendered card width strictly
increases XS → S → M → L. Report the actual measured px width of each
tier at each breakpoint in the build report — this is a case where the
numbers matter more than "looks right." Report how close L's width
landed to the pre-§67 M width target, with the actual numbers. Confirm
the in-project asset grid file (`globals.css`) has zero changes in this
commit.
