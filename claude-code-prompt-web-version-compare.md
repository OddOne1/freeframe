# Claude Code prompt — web: Version Compare, ported from upstream (§107)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §107 — read it in full first. This is a PORT of a real,
already-merged upstream feature (Techiebutler/freeframe PR #169, both
repos MIT-licensed, no licensing barrier to reading and adapting their
code directly), not a from-scratch design — treat their implementation
as the primary reference throughout, not just the changelog summary.
This is `apps/web`. Sizeable build — check in with the user partway if
this runs long rather than treating it as fire-and-forget. Run `npx
vitest run` for the whole app at the end.

## Reference source

Fetch these directly from GitHub as you work (raw file, MIT-licensed,
safe to read and adapt):

- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/compare-overlay.tsx`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/compare-scrubber.tsx`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/compare-version-select.tsx`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/use-shared-transform.ts`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/use-synced-transport.ts`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/compare/wipe-viewer.tsx`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/lib/compare-time.ts`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/lib/resolve-submit-timecode.ts`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/hooks/use-stream-url.ts`
- `https://raw.githubusercontent.com/Techiebutler/freeframe/main/apps/web/components/review/image-frame-constraint.tsx`
- Also fetch their PR #169 diff for `annotation-overlay.tsx`,
  `comment-input.tsx`, `comment-panel.tsx`, `progress-bar.tsx`,
  `version-switcher.tsx`, `video-player.tsx`, and
  `assets/[assetId]/page.tsx` (view the PR at
  `https://github.com/Techiebutler/freeframe/pull/169/files` or fetch
  each file's `main` branch raw content and diff mentally against ours)
  — these are MODIFIED files upstream, and you need to know what
  changed in each before deciding what to port into our versions,
  which have diverged since the fork point.
- Their test files live alongside each new component (e.g.
  `compare/__tests__/compare-overlay... `) — port and adapt these too,
  don't write coverage from scratch when a working reference exists.

`compare-overlay.tsx` and `use-synced-transport.ts` have already been
read in full during scoping (§107 in CLAUDE.md quotes their key
mechanics) — treat that section as accurate context, but still fetch
the files yourself for the exact current content before porting.

## Current state in OUR fork (confirmed, don't re-verify these specific facts)

- `hooks/use-comments.ts:44` already has the exact signature compare
  needs: `useComments(assetId: string | null, versionId: string | null)`.
  Call it twice (once per side) — no backend change needed for
  per-version comment scoping.
- Already present, existence confirmed but signatures NOT verified
  against what `compare-overlay.tsx` expects: `hooks/use-video-player.ts`,
  `components/review/annotation-canvas.tsx`, `video-player.tsx`,
  `comment-panel.tsx`, `comment-input.tsx`, `progress-bar.tsx`,
  `version-switcher.tsx`. Check each one's actual current props against
  how the reference `compare-overlay.tsx` calls it before assuming
  compatibility.
- Missing entirely, confirmed by file-existence check: `hooks/use-stream-url.ts`,
  `components/review/image-frame-constraint.tsx`.
- **Confirmed divergent, not just missing:** our
  `components/review/annotation-overlay.tsx`'s `AnnotationOverlay()`
  takes ZERO props (reads a single global annotation off
  `stores/review-store.ts` internally). Upstream's version takes an
  explicit `annotation` prop, specifically so each compare pane can
  show its own. This needs porting/refactoring — not a straight copy.

## Build

Follow CLAUDE.md §107's "Build shape" section (7 steps) as the outline.
In brief:

1. Port `compare-time.ts` and `resolve-submit-timecode.ts` near-verbatim.
2. Add `use-stream-url.ts` and `image-frame-constraint.tsx` — first
   check our `page.tsx` doesn't already have equivalent logic inline
   (these were extracted FROM page.tsx upstream; ours may not have had
   that extraction yet).
3. Refactor `AnnotationOverlay` to accept an optional `annotation` prop,
   defaulting to today's store-read behavior so no existing call site
   breaks. Check `CommentPanel`/`CommentInput`'s real current
   signatures against what compare needs (`onShowAnnotation`,
   `onSeekToTimecode`, `exportVersionId`, `playheadTimeOverride`,
   `disableAnnotations`, `annotationActive`, `onToggleAnnotation`) and
   adapt whichever have diverged.
4. Port the whole `compare/` directory, adapting import paths and any
   prop-shape fixes from step 3.
5. Wire `CompareOverlay` into `assets/[assetId]/page.tsx` — check
   upstream's actual page.tsx diff for the real trigger/entry point
   rather than guessing where the "Compare" button/action lives.
6. Do NOT silently fold in the `comments.py` N+1/batching fix as part
   of this port — it's real and valuable but independent of compare;
   flag it as a separate opportunity in your build report rather than
   bundling it here.
7. Port their test files per component, adapting to our fork's current
   test setup/mocks.

## Verification

Per CLAUDE.md §107's verification section: synced dual-video playback,
audible-side-as-master with no audio crackle, per-side offset trim via
the scrubber, comment-marker click behavior (seek/pause/open panel/
focus/show drawing, correct pane only), drawing a new annotation on one
side without it leaking to the other pane or into the normal
single-view page after closing, image compare in both wipe and
side-by-side modes, URL deep-linkability, and clean state after ESC/
close (the specific guarantee upstream's mount/unmount cleanup exists
for — verify it actually holds in our ported version, not just that it
compiles). Run the ported/adapted test suite plus `npx vitest run` for
the whole app at the end — report pass/fail counts, flag anything not
already a documented pre-existing failure.
