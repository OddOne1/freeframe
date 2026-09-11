# Claude Code prompt — compare mode: resize bug, per-pane zoom/fit,
comment-toggle position, elapsed/remaining timecode

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`, extending Version Compare (§107, commit 789a4bf) and the
video-wipe work (see `claude-code-prompt-web-video-wipe-compare.md` if
that hasn't landed yet — this prompt assumes it has, since zoom/fit
needs to affect wipe mode too). Run `npx vitest run` at the end.

## 1. Video-shrink bug — repro first, don't guess a fix

**This one is not diagnosed yet — investigation could not confirm a
root cause and flagged it explicitly as unconfirmed.** What's ruled
out: the video/img elements use plain CSS sizing (`max-h-full
max-w-full` inside a flex container, `compare-overlay.tsx:568,593,663,679`,
`video-wipe-viewer.tsx:68,74`) with no JS-computed width/height, so a
panel-toggle-driven container resize should reflow natively. The two
`ResizeObserver` instances that exist (`image-frame-constraint.tsx:68-70`,
`video-player.tsx:144-145`) only reposition the annotation-overlay
layer, not the video/img box itself, and both already fire on container
resize — so neither explains a "stuck until next version switch"
symptom on its own.

Do not patch around this speculatively. First reproduce it in a real
browser: open compare mode on two video versions, toggle the comments
panel open/closed a few times, and use DevTools to watch actual layout
box dimensions on the video element through the toggle — is the video's
rendered box actually shrinking, or is something else (a stale
`transform`/`scale` from `use-shared-transform.ts`'s zoom/pan state
persisting across the panel-width change, since that hook clamps zoom
`[1,8]` and tracks pan offsets that were computed against the
pre-toggle container width) the real cause? Check whether
`use-shared-transform.ts`'s pan/zoom state is reset or recalculated when
the container's available width changes — that's the most likely
candidate given the "self-corrects on next version switch" symptom
(version switch probably resets transform state, panel toggle doesn't).
Confirm with a real repro before writing the fix, and note in your
build report what the actual root cause turned out to be.

## 2. Per-pane zoom/fit control

Confirmed state: compare mode has its own hand-rolled zoom
(`use-shared-transform.ts`) — wheel-only, continuous, clamped `[1,8]` in
1.2x steps, drag-pan, reset via double-click — with no fit mode and no
visible control (zoom only reachable via mouse wheel). This does NOT
reuse the app's other zoom implementation: the single-asset image
viewer (`components/review/image-viewer.tsx:1-80`) already has a full
`react-zoom-pan-pinch`-based `ZoomControls` component (zoom in/out,
"Actual size" via `centerView(1)`, "Fit to screen" via
`resetTransform()`), positioned `absolute bottom-4 right-4`.

Build a visible zoom control for compare mode with these exact fixed
steps: 10%, 33%, 50%, 77%, 100%, 133%, 150%, 177%, 200%, plus "Fit"
(auto-scale so the video/image fits entirely within the pane on
whichever axis is the constraint — width or height — without cropping
any pixels, i.e. the standard "fit to screen" behavior, self-explanatory
as the user noted, no special-casing needed beyond correct
implementation).

Critical constraint: **zoom level must be shared across both panes**,
not independent per side — this is a hard requirement in wipe mode
specifically (the two videos are overlaid via clip-path, so mismatched
zoom levels would break the comparison entirely), and should almost
certainly stay shared in side-by-side mode too for consistency (confirm
this matches user expectation before making side-by-side independently
zoomable, if there's any ambiguity flag it rather than assume). This
likely means porting the zoom level into `use-shared-transform.ts`'s
existing shared state rather than duplicating it per pane — check
whether that hook already centralizes this correctly or needs
restructuring.

Reuse the `react-zoom-pan-pinch`-based approach and the `ZoomControls`
visual pattern from `image-viewer.tsx` rather than extending the
existing hand-rolled wheel-zoom from scratch, if that's a clean fit —
otherwise extend `use-shared-transform.ts` to support the fixed-step
list plus fit mode directly. Use your judgment on which is less
invasive, but don't end up with two parallel zoom implementations
long-term inside `components/review/` — note in your build report which
approach you took and why.

## 3. Comment-toggle button — move off the video, into the corner

Confirmed: `compare-overlay.tsx:504-519` positions the comment-toggle
buttons `absolute left-2 top-1/2 -translate-y-1/2` (and mirrored
`right-2` for the other pane) — floating over the vertical center of
the video content, `z-20` above it. Move both buttons to sit in a
corner of their respective pane (bottom corner, matching where similar
controls sit elsewhere in this app — check `image-viewer.tsx`'s
`ZoomControls` at `bottom-4 right-4` for the app's established corner
convention) rather than centered over the video. Make sure it doesn't
collide with the new zoom control from part 2 if both end up in a
bottom corner — stack or offset them cleanly.

## 4. Elapsed/remaining timecode toggle, dual timecode for mismatched runtimes

Confirmed: compare mode's timecode display
(`compare-scrubber.tsx:219`) shows only `formatTimecode(t, fps ?? 24)` —
current time, no total, no toggle. The single-asset video player
(`video-player.tsx:525-548,197-228,554-559`) has a click-to-toggle
*format* picker (Frames / Standard / Timecode via `timeFormat` in
`useReviewStore`) — that's a different axis (format of the number, not
elapsed-vs-remaining) but its dropdown-toggle UI pattern is a reasonable
template to copy for this new toggle. No elapsed/remaining toggle
exists anywhere in the codebase today — this is new.

Build:
- Clicking the timecode in compare mode's scrubber toggles between
  showing elapsed time and remaining time (i.e. `total - current`,
  counting down). Make the current mode unambiguous — an icon, or short
  label text ("Rem." / "Cur.") with a leading `+`/`-` sign, as the user
  specified — not just a bare number that silently means something
  different after a click.
- If the two compared versions have different total durations, show
  two timecodes stacked vertically next to the toggle instead of one:
  the left-pane version's timecode on top, the right-pane version's
  below, each independently reflecting elapsed/remaining per the shared
  toggle state (both flip together when clicked — the toggle controls
  display mode, not which side). When both versions have equal
  duration, a single shared timecode is enough (current behavior,
  extended with the new toggle) — no need for the redundant stacked
  display in that case.

## Verification

Manual, real browser (this is UI layout/timing behavior jsdom can't
meaningfully verify):

- Repro and confirm the fix for the resize bug specifically — toggle
  comments panel open/closed several times on a video pair, confirm the
  video never shrinks and stays correctly sized without requiring a
  version switch to self-correct.
- Test all 9 zoom steps plus Fit on both an image pair and a video pair,
  in both side-by-side and wipe mode — confirm both panes always zoom
  together, confirm Fit correctly fits without cropping on both
  landscape and portrait media if test assets of both are available.
- Confirm comment-toggle buttons no longer overlay video content and
  don't collide with the zoom control.
- Confirm timecode toggle flips correctly, label/icon is clear, and
  test with two versions of visibly different duration to confirm the
  dual-stacked-timecode display renders correctly and both update in
  sync when toggled.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
