# Claude Code prompt — LutCanvas leaks WebGL contexts on images, LUT
button misplaced for photos

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`. Run `npx vitest run` at the end.

## Bug 1 — WebGL context leak when opening LUTs on an image

Confirmed live: opening the LUT picker on an image asset produces
console spam — "There are too many active WebGL contexts on this page,
the oldest context will be lost" — logged 32 times in one session, with
a stack trace through `getContext`. Browsers cap the number of live
WebGL contexts (commonly 8-16); once exceeded, the browser silently
kills the oldest context to make room.

This points at `LutCanvas` (`lib/lut/webgl-lut.ts`, used by both
`video-player.tsx` and `image-viewer.tsx` per earlier investigation
this session). Something in its lifecycle is calling `getContext()`
repeatedly — likely once per LUT selection change, or once per
re-render — without releasing the previous context first. A WebGL
context is not automatically freed when a `<canvas>` element is
merely hidden or its content redrawn; it needs either the same context
reused across LUT changes (only swap the shader/texture, not the
context), or an explicit release (`WEBGL_lose_context` extension's
`loseContext()`) before creating a new one, or the canvas element
itself unmounted/remounted cleanly so the browser can actually garbage
collect the old context.

Find where `getContext('webgl'...)` or similar is called in this file,
confirm how often it's actually being invoked during normal LUT
picker use on an image (instrument if needed — this should not be
happening on every render or every hover, only on genuine LUT
selection changes at most, and ideally not even then if the context
can be reused), and fix the leak at its actual source. Don't just
suppress the console warning — find why new contexts keep getting
created instead of the existing one being reused.

Also check whether this is the same root cause behind the "WebGL:
context lost" warning noted earlier this session during the Safari
video playback investigation (previously concluded to be unrelated to
video since the compare stage creates no GL context) — that
conclusion was reached before this leak was found and may need
revisiting, since a context-count leak elsewhere on the page could
plausibly cause contexts to be evicted anywhere, including ones video
playback doesn't itself create but ends up affected by.

## Bug 2 — LUT button in a different position for images vs. video

The LUT picker was redesigned as a shared left sidebar component in
today's earlier work (§5 of that round), with an explicit requirement
that "this single component still serves both video and photo review
identically — no need to branch by media type anywhere in this work."
Confirmed live: the LUT selection button sits in a different spot on
an image asset than on a video asset. Since this was supposed to
already be identical, find where the divergence actually is — check
whether the image review page renders the trigger button through a
different wrapper/position than the video review page, even though
both use the same underlying LUT sidebar component. Fix it so the
button's position matches exactly between video and photo review,
matching whichever position the video player currently uses.

## Verification

Real browser: open an image asset, open the LUT picker on it several
times in a row (select different LUTs, close and reopen), watch the
console — confirm no WebGL context warnings appear at all, not just
fewer of them. Confirm applying a LUT to an image still works
correctly (this is a leak/lifecycle fix, not a rendering fix — the LUT
preview itself must still render correctly). Then compare a video
asset and a photo asset side by side (or in quick succession) and
confirm the LUT button renders in the exact same screen position on
both. Run `npx vitest run` for the whole app at the end — report
pass/fail counts, flag anything not already a documented pre-existing
failure.
