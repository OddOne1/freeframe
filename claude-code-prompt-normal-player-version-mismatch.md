# Claude Code prompt — fix normal video player not loading multi-version
assets

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`. Pre-existing bug, not caused by the recent Version Compare
work — just newly exposed because this session is the first time
multi-version video got exercised in the normal (non-compare) viewer.
Run `npx vitest run` at the end.

## Diagnosis — confirmed by code reading, NOT yet reproduced in a
browser. Confirm the repro before trusting this fully.

`components/review/video-player.tsx:238-245` fetches `GET
/assets/${assetId}/stream` with **no `version_id` param**, and the
`.catch()` at that call site is empty — a comment claims stream-URL
errors are "handled by player error state," which is false:
`use-video-player.ts`'s `error` state is only ever set by native
`<video>` element error *events*, never by a failed/rejected fetch. A
failed fetch here just leaves `streamUrl` `null` forever, silently — no
spinner, no error message, blank player.

Backend default when `version_id` is omitted
(`apps/api/routers/assets.py:363-379`): picks the version with the
highest `version_number`, **no ready-status filter**, then 409s if that
version's `processing_status != ready`.

Frontend's own "current version" selection
(`review-provider.tsx:161-167`): picks the latest **ready** version —
which is not necessarily the same one as "highest version_number" the
instant a newer version exists but hasn't finished processing yet.

So: single-version assets can never hit this (only one candidate,
they're always the same version). Multi-version assets diverge exactly
when the newest version isn't `ready` yet — the version switcher shows
the older, actually-playable version as current, while the stream fetch
silently asks for (and gets rejected on) the not-ready newest one.

Second, related bug: the stream-fetch effect
(`video-player.tsx:232-246`) depends only on `[assetId,
initialStreamUrl]`, not on the currently-selected version — so manually
switching versions via `version-switcher.tsx` doesn't even trigger a
refetch in the normal viewer.

## Fix

1. Pass the actual selected `version_id` into the stream-URL fetch
   (matching what `hooks/use-stream-url.ts` already correctly does for
   compare mode) instead of relying on the backend's ambiguous
   highest-version-number default.
2. Add `currentVersion`/`versionId` to the fetch effect's dependency
   array so switching versions actually refetches the stream in the
   normal viewer, not just in compare mode.
3. Fix the empty `.catch()` — surface a real error state (reuse
   whatever error UI the player already has for native video errors, if
   one exists) instead of silently leaving `streamUrl` null forever.
   Don't just log-and-swallow; a user staring at a blank player with no
   feedback is the actual bug being fixed here, not just the wrong URL.

## Verification

Manual, real browser, per this project's standing practice of
confirming repros before trusting a diagnosis:

- First, confirm the actual repro: find (or create, by uploading a new
  version and checking before it finishes processing) a multi-version
  video asset where the newest version isn't `ready` yet, and confirm
  the normal player currently fails to load in exactly this state.
- After the fix: confirm the same asset now loads correctly, showing
  whichever version is actually current/ready.
- Switch versions via the version switcher, confirm the player now
  actually refetches and plays the newly-selected version.
- Confirm single-version assets are unaffected (regression check).
- If the stream fetch genuinely fails for some other reason (e.g. the
  version really isn't processed yet), confirm the new error state
  shows something visible to the user instead of a silent blank player.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
