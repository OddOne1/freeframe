# Claude Code prompt — compare mode: fix control-row regression + zoom
containment + mode-relative zoom percentage

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`, fixing three regressions introduced by commit adba966 on
top of the persistent-video-elements work (982e6a6). Run `npx vitest
run` at the end.

**Explicitly out of scope: do not touch anything related to video
mirroring, flipping, or rotation.** The app has no such feature and
none should be added — a user-visible "mirrored" video the reporter saw
was their own manual test setup (re-encoding a copy flipped, to make
two versions visually distinguishable while testing), not a bug. If you
encounter this while reading `compare-video-stage.tsx` or
`use-shared-transform.ts`, it is unrelated and must not be changed.

## Confirmed root causes (don't re-diagnose)

**1. Comment-toggle buttons** — `compare-overlay.tsx:504-526`: both
buttons were hoisted into one shared wrapper during the prior refactor
and both use `left-*` positioning (button B sits at `left-16`, next to
button A, despite its `aria-label` still saying "Toggle right
comments"). Both are `absolute bottom-4`, low enough to sit inside/
behind the scrubber's control bar (`compare-scrubber.tsx:245`,
`border-t ... py-2`), since nothing accounts for the scrubber's height.

**2. Zoom overflow in side-by-side mode** — `compare-video-stage.tsx`:
wipe mode contains zoomed content via `clip-path` (`clipA`/`clipB`,
lines ~125-126), but side-by-side mode (`!isWipe`) has no
`overflow-hidden` anywhere in its container chain (stage div is
`'relative flex min-h-0 flex-1 bg-black'`, pane class is `'relative flex
min-w-0 flex-1 items-center justify-center bg-black'` — neither clips).
The zoom transform applies to an inner `absolute inset-0` div with no
containment above it in sbs mode, so scaled-up video paints into the
sibling pane and the comment panels. `CompareZoomControls`
(`compare-zoom-controls.tsx:52-55`) is a separate `bottom-4 right-4`
sibling with the same low-height overlap problem as the comment
buttons, plus an overflowing video can render on top of it and the
mode-switch button and intercept clicks, since nothing clips overflow
before it reaches that z-index.

**3. Zoom percentage is absolute-pixel-based, not mode-relative** —
`use-shared-transform.ts:33-36`'s own doc comment confirms the current
design: "100%" means one media pixel equals one screen pixel (an
absolute footprint), not "fitted to the current pane." `actualScale` is
correctly recomputed per mode via the `ResizeObserver` in
`compare-video-stage.tsx:96-117` (which does see the real box-width
difference between a half-width sbs pane and a full-width wipe pane),
but `zoomPct` (the number shown as "100%"/"150%"/etc.) is preserved
raw across a mode switch with no rebasing — so the same "100%" occupies
very different proportions of the two modes' panes, exactly as
reported. No `mode` parameter exists anywhere in `use-shared-transform.ts`
today.

## Fix

### A. One control row, above the scrubber, not inside the zoomable stage

Per the user's marked-up screenshot: build a single row that sits
directly above the scrubber/player-control bar (`compare-scrubber.tsx`),
NOT absolutely positioned inside the video stage where a zoomed video
can cover it. This row spans each pane's width (or the whole stage
width in wipe mode) and contains, left to right: left-pane comment
toggle pinned to the row's left edge, zoom controls centered in the
row, right-pane comment toggle pinned to the row's right edge. All
three sit at the same height. In side-by-side mode this likely means
the row needs to visually span both panes (matching where the zoom
controls are meant to be centered — "the active video frame," check
with the user if that means centered per-pane or centered across the
whole stage when both panes are active simultaneously, since side-by-
side shows both at once and there's no single "active" pane the way
wipe mode might imply one). Make sure this row is a normal-flow
sibling of the zoomable content, not a descendant of whatever container
gets `overflow-hidden`/clipped in part B — it must never be visually
coverable by video content regardless of zoom level.

**Confirmed: zoom controls are centered across the WHOLE stage width**
(one shared cluster spanning both panes), not per-pane, and this stays
fixed regardless of where the wipe divider currently sits — the
divider's position must never move or influence the zoom controls'
centering. This matches zoom already being a single shared value
between both sides.

Keep each comment toggle's actual left/right association correct (left
toggle still controls the left pane's comments, right toggle the
right's) — only reposition them, don't swap which one does what.

### B. Contain zoom overflow in side-by-side mode

Add `overflow-hidden` to the side-by-side pane containers (or the
stage, whichever correctly scopes it per-pane so a zoomed-in left pane
doesn't spill into the right pane) so scaled video content is clipped
to its own pane's box, matching how wipe mode already contains content
via clip-path. Confirm wipe mode's existing clip-path containment isn't
affected by this change.

### C. Make zoom percentage mode-relative

Change `use-shared-transform.ts` so that "100%"/"Fit"/every step in
between means "sized correctly for whichever mode's frame is currently
active," not a fixed absolute-pixel footprint carried across modes.
Concretely: when `mode` changes (side-by-side ↔ wipe), the numeric
`zoomPct` value shown to the user should stay conceptually the same
(e.g. still reads "100%"), but the underlying pixel scale must
recalculate against the new mode's available frame size — so switching
modes at "100%" always shows a correctly-fitted video in both modes,
never something that overflows or shrinks unexpectedly. This likely
means `use-shared-transform.ts` needs to know which mode is active (it
currently has no `mode` awareness at all) and rebase its scale
calculation accordingly, or reinterpret what `actualScale`'s baseline
represents per mode. Use your judgment on the cleanest implementation,
but the user-visible contract is: the percentage number means the same
relative thing in both modes, and switching modes never produces an
overflowing or unexpectedly-tiny video at whatever percentage was
previously showing.

## Verification

Manual, real browser:

- Confirm all three controls (left comment toggle, zoom controls, right
  comment toggle) sit in one row, same height, above the scrubber, in
  both side-by-side and wipe mode, at a few viewport widths.
- Zoom in significantly in side-by-side mode: confirm the video stays
  contained within its own pane, never overlapping the sibling pane,
  the comment panels, or the new control row.
- Zoom to 100%, switch from side-by-side to wipe and back: confirm the
  video renders correctly fitted in both modes at "100%" with no
  overflow and no need to manually re-fit.
- Confirm the mode-switch button is never blocked/covered by video
  content regardless of zoom level.
- Confirm comment toggles still open/close the correct pane's comment
  panel (left stays left, right stays right) after repositioning.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
