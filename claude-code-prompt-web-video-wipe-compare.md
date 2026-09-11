# Claude Code prompt — web: video wipe-compare mode + top-bar mode toggle

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is `apps/web`.
Extends the just-shipped Version Compare feature (§107, commit 789a4bf).
Run `npx vitest run` for the whole app at the end.

## Confirmed current state (don't re-investigate)

- `components/review/compare/wipe-viewer.tsx` implements wipe purely via
  CSS `clip-path: inset()` on two `absolute inset-0` layers (lines
  ~59-129): side A renders plain, side B sits in a wrapper clipped with
  `clipPath: inset(0 0 0 ${split}%)`, and a separate absolutely-positioned
  drag handle (lines ~111-124) drives `split` via pointer events. This
  technique has no dependency on `<img>` specifically — `clip-path`
  works identically on `<video>`.
- `components/review/compare/use-synced-transport.ts`'s `useSyncedTransport`
  (lines ~113-197) only ever touches `playerA.videoRef`/`playerB.videoRef`
  via `.currentTime`/`.play()`/`.pause()` — it has zero DOM-layout
  assumptions and doesn't care where the video elements are painted on
  screen or how they're clipped/positioned.
- `components/review/compare/compare-overlay.tsx` currently: the mode
  toggle button is wrapped in `{!isVideo && (...)}` around line 397, so
  it never renders for video assets. The render branch around line 507
  checks `isVideo` first and unconditionally routes to a side-by-side
  flex layout (video elements at roughly lines 523 and 548) — the
  `mode === 'wipe'` check only happens in the non-video else-branch
  (~line 578), so video can never reach wipe mode today even via a
  forced URL param.

## Build

1. Add a video-capable wipe path. Either extend `wipe-viewer.tsx` to
   accept `<video>` elements as well as `<img>` (prop for element type,
   or separate `videoRefA`/`videoRefB` vs `imgSrcA`/`imgSrcB` props), or
   add a sibling component that reuses the exact same clip-path/handle
   structure with video elements — whichever keeps the split-drag and
   handle-rendering logic from being duplicated. Reuse
   `transport.playerA.videoRef` / `transport.playerB.videoRef` (the same
   refs `useSyncedTransport` already drives) as the video elements in
   the clip layers — do not create new video elements or new sync
   plumbing, this is a rendering-only change.
2. In `compare-overlay.tsx`: remove the `!isVideo` condition gating the
   mode-toggle button so it renders for both video and image assets.
3. Reposition the toggle: it should sit in the middle of the top bar,
   between the left and right version-select pills, not off to one
   side. Check the current top-bar flex/grid layout and adjust so the
   toggle is visually centered regardless of how long the version pill
   labels are.
4. Update the render branch (~line 507 onward) so that for video assets,
   `mode === 'wipe'` routes to the new video wipe path instead of always
   forcing side-by-side. Side-by-side stays the default/other option for
   video, exactly as today.
5. Confirm keyboard/URL-param behavior stays consistent with the
   existing image wipe mode (same `mode` query param drives both).

## Also fix while in this file (unrelated but adjacent, cheap)

`components/review/compare/compare-version-select.tsx:55` hardcodes
`left-0` on the dropdown menu (`role="listbox"` div), so it always grows
rightward from its trigger. This is fine for the left-pane version pill
(used at `compare-overlay.tsx:382`) but the right-pane pill
(`compare-overlay.tsx:410`, `testId="compare-select-b"`) sits at the
top-right corner, so its dropdown overflows off-screen. Fix: make the
anchor direction prop-driven (e.g. an `align: 'start' | 'end'` prop) so
the right-pane instance can render `right-0` instead of `left-0`, or at
minimum confirm swapping to `right-0` for the right pill doesn't regress
the left one.

## Verification

Manual, in a real browser (jsdom can't verify visual clipping or video
playback) — this repo's last round skipped this and it should not be
skipped again:

- Compare two video versions, toggle to wipe mode, drag the handle:
  confirm the boundary reveals version A vs B cleanly with no visible
  seam/flicker while both videos are playing and synced.
- Confirm audible-side-as-master and offset trim still work correctly
  in wipe mode (not just side-by-side) — this exercises the same
  `useSyncedTransport` hook, so a regression here would mean the
  rendering change accidentally affected sync, which it shouldn't.
- Confirm the toggle button appears centered in the top bar at a few
  viewport widths, including narrow ones where version-pill labels are
  longer (e.g. "v10" vs "v2").
- Confirm the right-pane version dropdown now opens within the viewport
  instead of overflowing, and the left-pane dropdown still behaves
  correctly.
- Confirm existing image wipe mode still works unchanged (regression
  check on the shared clip-path logic).

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
