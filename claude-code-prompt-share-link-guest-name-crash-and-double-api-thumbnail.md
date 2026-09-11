# Claude Code prompt — share-link page crashes on comments from
logged-in users, plus double /api thumbnail 404 on every video

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`. Two separate live bugs. Run `npx vitest run` at the end.

## Bug 1 — share-link page crashes rendering comments from non-guest users

Confirmed live: opening any share link that has at least one comment
posted by a logged-in user (not an anonymous guest) crashes the entire
page with:

```
TypeError: undefined is not an object (evaluating 'e.guest_name.charAt')
```

Full repro: create a share link for a single asset that already has a
comment from a logged-in account (not a guest), open the share link in
a private/incognito browser (so you're viewing as an anonymous guest,
not authenticated) — the video briefly shows, then the page crashes to
Next.js's generic "Application error" screen once the comment list
renders or re-renders.

Root cause is almost certainly in whatever component renders comment
avatars/initials in the share-link view: it calls `.charAt(...)`
directly on `guest_name` with no null-check, but `guest_name` is only
populated for comments actually posted by an anonymous guest — a
comment posted by a real logged-in user has `user`/`user.name` (or
whatever the authenticated-author field is called) instead, and
`guest_name` is legitimately undefined for those. Find that render
path (search for `.guest_name` in the comments/share components) and
fix it to fall back to the authenticated user's name when `guest_name`
isn't set, matching whatever the non-share (authenticated) comment
list already does correctly, since Magdalena's comment renders fine
there.

Also confirm whether this same unguarded pattern exists anywhere else
comments are rendered (the authenticated asset view, notifications,
etc.) — this is exactly the kind of thing worth checking isn't
duplicated elsewhere, given how many places comment authorship gets
displayed in this app.

## Bug 2 — double /api prefix on video thumbnails, every video shows
black until played

Confirmed live, now seen across multiple unrelated videos, not one
asset: `GET https://frame.yon.studio/api/api/stream/hls/thumbnail.jpg?token=...`
— 404, doubled `/api` prefix. This is why every video currently opens
to a black frame until the user manually hits play — the poster/
thumbnail request never succeeds. Already filed as its own known issue
(#139 in project tracking) but not yet fixed. Same bug shape as the
already-fixed #72 (FolderAssetViewer/ShareViewer double-resolving a
URL through `resolveApiMediaUrl`), but that fix was scoped specifically
to the share-link folder-viewer code path — this is happening on the
plain, non-share asset review page, so it's different code hitting the
same underlying mistake (a URL that's already been resolved through
the API-prefix helper gets passed through it a second time).

Find wherever the normal (non-share) asset viewer resolves
`thumbnail_url`/poster URLs and check for the same
store-already-resolved-then-resolve-again pattern #72 found. Given
this is now the second, and with the share-link crash above
potentially a third, unrelated place this exact bug shape has
appeared, seriously consider whether there's a single shared URL-
resolution helper that's fragile to being called twice, and whether
it's worth making that helper idempotent (safe to call on an
already-resolved URL without doubling the prefix) rather than chasing
every individual call site as it turns up.

## Verification

Real browser, both bugs:

- Open a share link for an asset that has a comment from a logged-in
  user, as an anonymous/incognito viewer — confirm the page loads and
  stays loaded, comment renders correctly with a sensible fallback
  name/initial, no crash.
- Open several different video assets (not just one) and confirm the
  thumbnail/poster shows immediately instead of a black frame, without
  needing to hit play first.
- Confirm existing thumbnail behavior elsewhere (project grid, uploads
  panel) isn't affected by whatever fix is applied.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
