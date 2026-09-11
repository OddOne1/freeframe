# Claude Code prompt — compare mode: stop remounting video on mode switch

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`, fixing a real bug in the just-shipped video-wipe work.
Run `npx vitest run` at the end.

## Confirmed root cause (don't re-diagnose)

`compare-overlay.tsx:521-601` renders side-by-side and wipe mode as two
mutually-exclusive JSX subtrees at the same tree position — a ternary
on `mode`. Side-by-side renders `<video ref={transport.playerA.videoRef} .../>`
directly (lines 568, 593); wipe mode renders a structurally different
tree, `<VideoWipeViewer videoRefA={transport.playerA.videoRef} .../>`
(line 529), which mounts its own `<video>` deep inside `WipeStage`
(`video-wipe-viewer.tsx:68,74`). Both branches pass the same ref
*object*, but that only controls where the ref points once attached —
it does nothing to prevent React from unmounting one DOM node and
mounting a new one when the branch changes, since the two branches are
different JSX trees.

The consequence chain, confirmed:
- `use-video-player.ts:147-258`'s effect that attaches HLS / sets `src`
  has deps `[src, setPlayheadTime]` (line 258) — it does NOT re-run
  when the video element itself changes identity, only when `src`
  changes. So the freshly-mounted `<video>` after a mode switch sits
  with no HLS attached and no source — dead — until something changes
  `src`, which is only a version switch. That's the "only loads after
  switching versions" symptom.
- The synced-transport clock (`use-synced-transport.ts:117-119`, `tRef`)
  survives mode switches fine, since the hook itself is never
  destroyed. But native `HTMLVideoElement.currentTime` lives on the DOM
  node, which IS destroyed and replaced, so progress is lost regardless
  of what the transport hook remembers — the rAF loop tries to re-seek
  the new element, but seeking a sourceless `readyState 0` element is a
  no-op.
- `useSyncedTransport` itself is instantiated once, correctly, above
  the mode branch (`compare-overlay.tsx:153-166`) — it is not the
  problem, and does not need restructuring.

## Fix

Hoist the two `<video>` elements (`transport.playerA.videoRef` /
`transport.playerB.videoRef`) so they are mounted exactly once, outside
the `mode === 'wipe' ? ... : ...` ternary, and never unmount as a result
of a mode change. Side-by-side vs wipe should become a difference in
how the SAME two video elements are positioned/clipped, not which
elements exist.

Concretely, pick whichever of these is the smaller structural change
given the current `WipeStage`/`compare-overlay.tsx` layout (use your
judgment, but the goal is identical either way — one stable pair of
video elements, CSS-only mode switching):

- **Option A (portals):** keep the two `<video>` elements mounted in a
  single stable location, and use a portal (or CSS-only positioning
  trick) to project them into whichever container — the side-by-side
  flex pair or `WipeStage`'s clip-path layers — is currently active for
  `mode`.
- **Option B (always render both containers, toggle visibility/CSS):**
  render both the side-by-side container and the wipe container at all
  times, with the two actual `<video>` elements living in only ONE of
  them (whichever currently owns the DOM nodes), and use CSS
  (`display`/`visibility`/`clip-path` toggling on the wrapping
  containers, not on the video elements' mount state) to show only the
  active layout. This avoids portals but means being careful that the
  inactive container doesn't reserve layout space or intercept
  pointer events.

Either way, `WipeStage`'s clip-path layering (`video-wipe-viewer.tsx`)
needs to become something that positions EXISTING video elements passed
into it, not something that creates its own `<video>` tags — check
whether it currently takes `videoRefA`/`videoRefB` as refs to attach to
elements it renders itself (current behavior, causing the remount) vs.
being restructured to receive the already-mounted elements and just
apply clip-path styling to their existing wrapper.

Do not touch `use-video-player.ts`'s effect deps (`[src, setPlayheadTime]`)
— once the video element itself stops being remounted, that effect is
correctly scoped and will only reattach when the source genuinely
changes, which is the desired behavior.

## Also worth checking while here: "loads slowly" complaint

The user separately reported videos take a long time to load even
without a mode switch. Once the remount bug is fixed, re-test whether
this persists — it may have been the same root cause (an effect never
re-running because deps didn't change on some other version-related
remount), or a separate issue (e.g. `useStreamUrl`/`use-stream-url.ts`
fetch latency, missing `preload` attribute, or something in the HLS
manifest fetch path). Don't assume it's fully explained by the remount
bug — confirm after the fix, and if it's still slow, do a quick check
of `use-stream-url.ts` for anything obviously serial/blocking before
reporting it as a separate issue.

## Verification

Manual, real browser (this is DOM-lifecycle/timing behavior jsdom
cannot meaningfully verify):

- Load a video pair in side-by-side mode, let it play a few seconds,
  switch to wipe mode: confirm playback continues from the same
  position with no reload, no black frame, no "stuck until version
  switch" state.
- Switch back to side-by-side: same check.
- Toggle mode repeatedly (5-10 times rapidly) — confirm no memory leak
  from orphaned video elements/HLS instances, and confirm sync (master
  handoff, offset trim) still works correctly after several toggles,
  not just the first one.
- Confirm switching versions still works correctly (this is the one
  path that SHOULD still trigger a real reload, since the source
  actually changes) and doesn't regress.
- Confirm the "loads slowly" issue — re-test and report whether it's
  resolved as a side effect or needs separate investigation, per the
  section above.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
