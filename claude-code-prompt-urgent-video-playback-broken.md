# Claude Code prompt — URGENT: video playback broken in both compare
mode and normal player

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Live production
issue — no video plays anywhere right now. `apps/api` and `apps/web`.
Skip anything not needed to ship this fast; jumps the queue ahead of
other pending prompts. Run tests at the end.

Two separate bugs, confirmed via live network/console evidence, not
guessed:

## Bug A — normal (non-compare) player: stream fetch omits version_id, 409s

Already diagnosed in a prior prompt
(`claude-code-prompt-normal-player-version-mismatch.md` — read it for
full detail if still present) and now confirmed live: browser network
tab shows `GET /api/assets/{id}/stream` with NO `version_id` query
param returning `409`, causing `HLS error: mediaError` in the console,
silent blank player.

`components/review/video-player.tsx:238-245` fetches stream without
`version_id`. `apps/api/routers/assets.py:363-379`'s default (no
`version_id` given) picks highest `version_number` with no ready-status
filter, 409s if not ready. `review-provider.tsx:161-167`'s "current
version" is the latest *ready* one instead — the two disagree whenever
the newest version isn't ready yet.

**Fix:** pass the actual selected `version_id` into the normal player's
stream fetch (matching `hooks/use-stream-url.ts`'s already-correct
approach for compare mode), refetch when the selected version changes
(current effect deps are `[assetId, initialStreamUrl]` only — missing
version), and replace the empty `.catch()` with a real visible error
state instead of a silently-null `streamUrl` forever.

## Bug B — compare mode: stream fetch succeeds (200, correct version_id), video still doesn't play, no error surfaced

**Not the same bug as A — diagnose fresh, don't assume A's fix covers
this.** Live evidence: both compare-pane stream requests
(`/api/assets/{id}/stream?version_id=...`) return `200` with correct,
distinct `version_id`s for each pane. The stream URL is being obtained
successfully. Yet neither video loads or plays, audio included, and
nothing in the console reports an error — the failure is silent and
happens somewhere between "valid stream URL obtained" and "video
element actually plays it."

**Prime suspect: the just-deployed commit 9a59f96** (image
zoom-containment fix). Its own build report states it refactored
`CompareVideoStage` to import shared markup from a new
`compare-pane.tsx` ("Both rules now live once in compare-pane.tsx...
imported by both stages... mirroring CompareVideoStage") — meaning the
video stage's rendering was touched as part of a fix whose stated
purpose was the image stage. Diff exactly what changed in
`compare-video-stage.tsx` in that commit and check:

- Does the video `<video ref={...}>` element still receive
  `transport.playerA.videoRef`/`playerB.videoRef` correctly, or did the
  refactor into the shared `ComparePane`/`comparePaneClass` wrapper
  change how/where the ref gets attached (e.g. attached to a wrapper div
  instead of the actual `<video>` element, or the video element now
  renders inside an extra layer of nesting that breaks something
  `use-video-player.ts`'s HLS-attach effect assumes about the DOM)?
- Does `use-video-player.ts`'s HLS attach effect (`hls.attachMedia(video)`
  / `video.src = src`) still run against the correct, currently-mounted
  video element after this refactor — instrument/log if needed to
  confirm the effect actually fires and attaches to a real element with
  a real stream URL.
- Check whether the shared `ComparePane`/`compare-pane.tsx` component
  introduced any prop-forwarding gap — e.g. if it wraps children in a
  new container and something (a `key`, a ref callback, an event
  handler) doesn't propagate through correctly for the video case
  specifically, since the image case has no HLS/ref-attach mechanism to
  break in the same way and so wouldn't have caught this in that
  commit's own image-focused testing.

Get an actual repro and instrument rather than pattern-matching a fix —
this needs to be understood, not guessed at, given how live and visible
it currently is.

**Additional live evidence, strengthens the "video element itself is
disconnected" theory over a data/sync problem:** in compare mode, the
scrubber/playhead visibly moves during playback, but neither picture
nor audio plays on either side. This means `useSyncedTransport`'s clock
(`t`/the rAF loop) is advancing normally — the transport/sync layer
itself is fine — while the actual `<video>` elements are producing no
decoded output at all. This points at exactly the video-ref/HLS-attach
wiring gap described above, not a sync-logic bug: the clock thinks
playback is happening, but nothing is actually attached to media that
can play. Confirm this directly — check whether `video.readyState`/
`video.currentSrc` are actually populated on the real DOM nodes during
this state, which will show definitively whether HLS ever attached.

**Newest live evidence — Bug B is Safari-specific, not universal:** confirmed
2026-09-02 on the actual production asset
(`/projects/cacb63bf-75ff-4dfe-9b24-657eb3b684e1/assets/790e8f36-64b8-421f-b012-3982d76584ec?compare=b924b03b-8f2f-455a-ad05-a5f2a6d7b418&compareRight=85e017bb-2b58-4a98-aa67-ffa285685154`)
that compare mode works correctly in a Chromium-based browser, but fails with
`HLS error: mediaError` specifically in Safari. Two additional Safari-only
signals, both worth checking before assuming this is purely a JS-logic bug:

- Safari's own console shows a **`WebGL: context lost`** warning alongside the
  HLS error. Check whether the compare stage (zoom/pan, or the
  `compare-pane.tsx` refactor from 9a59f96) uses a WebGL canvas anywhere in
  the render path, and whether Safari is dropping that GL context under some
  condition (e.g. too many contexts alive at once from side-by-side panes,
  or a canvas losing context when its container is resized/re-parented by
  the new shared-wrapper markup). A lost WebGL context could plausibly be
  upstream of or unrelated to the video-ref/HLS-attach issue — determine
  which, don't assume they're the same failure.
- With the AdGuard Safari extension **disabled**, the error sequence changes:
  briefly shows "Video playback error" before settling back to the same
  `HLS error: mediaError`. This suggests AdGuard is intercepting/blocking
  something (likely a network request tied to the HLS manifest/segments, or
  a Worker/WASM resource hls.js needs — Safari is stricter than Chromium
  about content-blocker interaction with MSE/Worker-based media pipelines).
  Rule out ad-blocker interference as a confound: test in Safari with all
  content blockers/extensions fully disabled, and separately test whether
  hls.js's Safari-specific path (Safari has native HLS support via
  `<video>`'s `canPlayType('application/vnd.apple.mpegurl')` — confirm
  whether this app's `use-video-player.ts` even loads hls.js in Safari, or
  branches to native `<source>` playback there; if it forces hls.js's MSE
  path in a browser that has native HLS support, that divergence itself
  could be the Safari-only bug, independent of the AdGuard/WebGL signals).

Treat this as a third data point for Bug B's root cause, not a separate bug:
report back on whether it's (a) the same video-ref/HLS-attach wiring gap
manifesting differently in Safari's stricter MSE implementation, (b) a
genuinely separate Safari-only branch bug (e.g. missing native-HLS fallback),
or (c) a red herring caused by the AdGuard content blocker — confirm which
before fixing, since the fix differs materially depending on which it is.

## Bug C — wrong asset ID requested entirely, on repeat, when trying to play a version

New live evidence, likely related to B but distinct enough to call out
separately: while on the page for asset `4876b3cf-b1d4-45f7-a253-6bce8e1134ad`
(confirmed via the `Referer` header — page URL is
`/projects/.../assets/4876b3cf-b1d4-45f7-a253-6bce8e1134ad`), clicking
play triggers a request to `GET /api/assets/2e166f20-bb5d-47af-855e-fdb2082699af`
— a COMPLETELY DIFFERENT, unrelated asset ID, not even hitting the
`/stream` sub-route, just the bare asset-detail endpoint — which
returns `401`. The user also captured a screenshot showing that exact
ID (`2e166f20-bb5d-47af-855e-fdb2082699af`) repeated many times in a
list (looked like Safari's download panel), consistent with this
request firing repeatedly in a loop — matching the user's report that
"trying to play in the versioned stream this just keeps on repeating
but nothing happens."

This is not a missing-`version_id` problem like A — it's requesting an
entirely wrong resource ID. Find where `2e166f20-bb5d-47af-855e-fdb2082699af`
could be coming from: is it a stale ID left in some client state (a
previous asset's ID not cleared on navigation), a different resource
type's ID being passed into a generic asset-fetch function by mistake
(e.g. a comment-attachment ID, a LUT ID, a share-link ID accidentally
routed through the same fetch helper), or something in the recent
compare/player refactors leaking a ref/ID across renders? Also
determine what's causing the REPEATED firing — a `useEffect` whose
dependency never stabilizes is the likely shape of an infinite retry
loop; find it and fix the actual loop condition, not just the 401.

Treat this as connected to Bug B's investigation (both are part of "the
video playback path broke after 9a59f96/recent player refactors") but
verify and report on it as its own distinct root cause — don't assume
fixing B automatically resolves this.

## Verification

Real browser, both required before considering this closed:

- Normal player: asset with a not-yet-ready newest version loads and
  plays its actual current ready version correctly.
- Compare mode: both panes load and play correctly, audio included,
  master-handoff and offset-trim still work (this exercises the same
  video refs the regression likely broke).
- Confirm neither fix regresses the other mode.
- Confirm the image side-by-side/wipe zoom-containment fix from 9a59f96
  is still intact after whatever change fixes the video stage here —
  don't undo that fix while fixing this one.
- Test Bug B specifically in Safari (with and without content-blocker
  extensions) as well as a Chromium-based browser, on the real asset
  `790e8f36-64b8-421f-b012-3982d76584ec` compare link above — Chromium
  alone passing is not sufficient given this bug's confirmed Safari-only
  reproduction.

Push and report back immediately.
