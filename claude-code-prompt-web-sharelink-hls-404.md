# Claude Code prompt — web: folder-share HLS player 404 (double `/api` prefix)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §32 — root cause fully diagnosed there from a real failing
request, this is a build prompt.

## Root cause

`apps/web/app/share/[token]/page.tsx`'s `FolderAssetViewer` (the
folder-share asset detail path — not the single-asset share path)
resolves `stream_url`/`thumbnail_url` through `resolveApiMediaUrl`
(`apps/web/lib/utils.ts:15-19`, which prepends the build-time
`NEXT_PUBLIC_API_URL` — `/api` in production per
`docker-compose.prod.yml:181`) once at `:830`/`:840`, storing the
already-`/api`-prefixed URL in React state. That resolved value then
gets passed as `pseudoAsset.stream_url`/`.thumbnail_url` (`:867-868`)
into `<ShareViewer asset={pseudoAsset}>`, which calls
`resolveApiMediaUrl` on `asset.stream_url`/`.thumbnail_url` *again*
(`:704`, `:712`, `:521`) — doubling the prefix to `/api/api/stream/...`,
which 404s.

Confirmed live: `GET /api/api/stream/hls/master.m3u8?token=...` → 404,
from a "Red Bull ReShuffle" folder share.

## Fix

In `FolderAssetViewer`, store the **raw, unresolved** URL from
`streamData.url` (`:830`) and `thumbData.url` (`:840`) in state — drop
the `resolveApiMediaUrl(...)` call at both sites. `ShareViewer`
downstream already does the one resolution needed on
`asset.stream_url`/`.thumbnail_url`.

Before changing this, grep the rest of `page.tsx` for every other call
site of `resolveApiMediaUrl` and every place that reads
`pseudoAsset`/`asset.stream_url`/`asset.thumbnail_url`, to make sure
there isn't a third caller relying on `FolderAssetViewer`'s state
already being resolved (e.g. a direct `<img src={thumbnailUrl}>`
somewhere in this same component using the state value directly rather
than going through `ShareViewer`). If one exists, resolving it there
instead is fine — the fix is "resolve exactly once, at the point of
actual use," not "always resolve at the fetch site."

## Verification

Open a folder share link (not a single-asset link) containing a video
asset, confirm the HLS player loads without a console 404, and confirm
the network tab shows a single `/api/stream/hls/...` (not
`/api/api/...`). Also check a folder share's image/thumbnail assets
load correctly (same double-prefix risk via `thumbnail_url`). Confirm a
single-asset share link (the non-folder path) still works — it wasn't
broken by this bug, don't introduce a regression fixing this.
