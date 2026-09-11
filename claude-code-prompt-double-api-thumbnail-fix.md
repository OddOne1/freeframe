# Claude Code prompt — fix #139: double /api prefix on normal asset thumbnails

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is a fix
prompt, not an investigation — root cause is fully confirmed from code,
see below. Same bug shape as the already-fixed #72 (stream_url), just
never applied to thumbnail_url, its sibling field in the same function.

## Confirmed root cause

`NEXT_PUBLIC_API_URL` is `/api` in production (`docker-compose.prod.yml:260`,
`apps/web/Dockerfile.prod:52` and `:76`) — a relative path, not an
absolute origin. Both URL-resolving helpers guard against double
resolution by checking `url.startsWith('/')`:

- `apps/web/lib/utils.ts:15` — `resolveApiMediaUrl`
- `apps/web/components/review/video-player.tsx:175` — `resolveStreamUrl`
  (a separate, duplicate copy of the same logic — see the comment right
  above it, which already documents this exact bug class and says this
  function is meant to be "the ONE place a stream URL may be resolved")

That guard assumes a resolved URL starts with `http`, so it no longer
starts with `/`. But since `NEXT_PUBLIC_API_URL` is `/api`, a *resolved*
URL (`/api/stream/hls/thumbnail.jpg?...`) still starts with `/` — so
the guard can't distinguish "already resolved" from "not yet resolved."
Resolve it twice and you get `/api/api/stream/hls/thumbnail.jpg?...`.

The exact chain:

1. `apps/web/components/review/review-provider.tsx:181` (normal,
   authenticated asset page — the one that was live-tested and 404'd
   all session): `data = { ...data, thumbnail_url: resolveApiMediaUrl(data.thumbnail_url) }`
   — resolves the raw `/stream/hls/thumbnail.jpg?token=...` (returned
   by `apps/api/routers/hls_proxy.py`'s `proxy_url_for()`, which never
   includes an `/api` prefix itself) into `/api/stream/hls/thumbnail.jpg?...`.
2. `apps/web/components/review/video-player.tsx:206`:
   `const posterUrl = asset?.thumbnail_url ? resolveStreamUrl(asset.thumbnail_url) : undefined`
   — resolves it *again*, since it still starts with `/`, producing
   `/api/api/stream/hls/thumbnail.jpg?...` → 404.

This exact bug already happened once, for `stream_url` — see the
comment at `review-provider.tsx:156-163`: it explains `stream_url` was
fixed by leaving it RAW in both branches of this function and letting
`video-player.tsx` be the single place that resolves it (§32 in
CLAUDE.md, referenced in the `resolveStreamUrl` comment). That fix was
never applied to `thumbnail_url`, its sibling field in the same
function, in either branch:

- Share-mode branch, line 164: `thumbnail_url: resolveApiMediaUrl(streamData?.thumbnail_url)`
- Normal-mode branch, line 181: `data = { ...data, thumbnail_url: resolveApiMediaUrl(data.thumbnail_url) }`

## The fix

Mirror exactly what was already done for `stream_url`: leave
`thumbnail_url` raw in both branches of `review-provider.tsx` (remove
the `resolveApiMediaUrl(...)` wrapping, just pass the value straight
through), and let `video-player.tsx:206`'s existing `resolveStreamUrl`
call be the single place it gets resolved — which it already does
correctly, once.

Before removing the pre-resolve, confirm `asset.thumbnail_url` (as
read from review-provider's asset state) isn't consumed anywhere else
in the review flow that expects it pre-resolved — checked already,
`video-player.tsx:206` is the only consumer in
`apps/web/components/review/`, but verify this still holds and check
nothing outside that directory reads thumbnail_url off this same
review-provider asset state before assuming it's safe.

Also worth doing while in this code: the duplicated `resolveStreamUrl`
function exists as three separate local copies
(`audio-player.tsx`, `image-viewer.tsx`, `video-player.tsx` — found via
grep) instead of one shared export. The comment on the `video-player.tsx`
copy already warns "it was previously written out inline twice in the
effect below, and a third copy in a test is what let a mutation of the
real logic go unnoticed" — the same risk applies across files, not just
within one. Consider consolidating to a single shared function (in
`lib/utils.ts`, alongside `resolveApiMediaUrl` — worth asking whether
these two nearly-identical functions should actually just be one) if it's
a low-risk change; skip it if it touches more than the thumbnail_url
fix warrants right now — your call on scope, note it either way.

## Verification

Real browser, not just code inspection:

- Open a normal (non-share) video asset in the review page, confirm
  the poster thumbnail loads (no more `/api/api/stream/hls/thumbnail.jpg`
  404) and that the `Cache-Control` on that response is unaffected by
  this change (still whatever the success-path caching policy already
  is — this fix doesn't touch caching, only the URL).
- Confirm the share-mode branch (line 164) still works for share
  links — open an asset share link, confirm its thumbnail loads too.
- Confirm image and audio assets still show correctly (their own
  local `resolveStreamUrl` copies aren't touched by this fix, but
  confirm nothing shares state with the video path in a way that could
  regress).

Add a regression test for this exact case — an integration/component
test asserting that a raw `/stream/...` thumbnail_url from the API,
run through review-provider's fetch and then through
`VideoPlayer`'s poster resolution, produces exactly one `/api` prefix,
not two. Mirror however the existing `stream_url` double-resolution
regression (if there's already a test for #72) is structured.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
