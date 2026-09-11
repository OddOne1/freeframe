# Claude Code prompt — fix the guest_name.charAt crash on asset share links (confirmed live, scoped)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is a fix
prompt — the bug, its exact location, and the existing correct pattern
elsewhere in the codebase are all already confirmed. No further
investigation needed, just implement and test.

## Confirmed bug

`apps/web/app/share/[token]/page.tsx:242`:

```tsx
{comment.guest_name.charAt(0).toUpperCase()}
```

This crashes the entire share-link page with
`TypeError: Cannot read properties of undefined (reading 'charAt')`
whenever the comment list includes a comment from a logged-in user
(who has no `guest_name`, only an authenticated author). Confirmed
live against production on two separate, independent asset share
links (different assets, different comments, both freshly created):
both hit this exact line and both take the whole page down to
Next.js's generic "Application error: a client-side exception has
occurred" screen — not a partial failure, the whole share view is
unusable.

Also confirmed live, for scoping: **folder share links and project
share links do NOT hit this bug** — they route through
`apps/web/components/share/folder-share-viewer.tsx`, which already
has the correct pattern (see below) and was tested clean in an
isolated browser session, including drilling into the exact asset/
comment that crashes the direct asset-link path. So this fix is scoped
to the one file — don't go looking for the same bug in
`folder-share-viewer.tsx`, it's already handled there correctly.

## The fix — copy the existing correct pattern

`apps/web/components/share/folder-share-viewer.tsx:509` already solves
this exact problem correctly:

```tsx
const name = comment.author?.name || comment.guest_author?.name || comment.guest_name || comment.author_name || 'User'
```

and then renders `name.charAt(0).toUpperCase()` — never crashes,
because `name` always resolves to a string (falls through to `'User'`
in the worst case).

Apply the same fallback chain to `apps/web/app/share/[token]/page.tsx`
at line 242 and its surrounding render (check the full component for
every place `comment.guest_name` is used directly — the type
definition at line 62 (`guest_name: string`) is itself wrong, it
should be optional (`guest_name?: string`), which is presumably how
this shipped without TypeScript catching it). Use the resolved name
for both the avatar initial and the displayed name text next to it
(line 244 also reads `comment.guest_name` directly for the visible
name — same bug, needs the same fix, currently just not throwing
because it renders `undefined` as text rather than calling a method on
it).

Check whether any replies/nested comments in this same file have the
identical pattern (the folder-share-viewer fix applied it to both a
top-level `name` and a reply `rName` — check if this file has an
equivalent reply-rendering path that needs the same treatment).

## Verification

Real browser, not just unit tests:

- Recreate the exact repro: comment on an asset as a logged-in user,
  create a share link for that single asset (not folder/project), open
  the share link fresh (new tab/incognito) — confirm the page loads,
  the comment renders with a sensible initial/name instead of crashing.
- Confirm a share link with a genuine anonymous guest comment (has a
  real `guest_name`) still renders that guest's name/initial correctly
  — don't regress the case this was originally built for.
- Confirm folder and project share links still work correctly
  afterward (should be unaffected, this fix doesn't touch
  `folder-share-viewer.tsx`, but confirm nothing else broke).

Also add a unit/component test covering: comment with `guest_name` set
renders the guest name; comment with only an authenticated `author`
(no `guest_name`) renders the author's name without throwing; comment
with neither falls back to `'User'` without throwing.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
This one's low-risk (isolated to one render path, verified scope
already), safe to commit and push once tests pass — no need to hold
for confirmation before pushing to GitHub, but do not deploy/rebuild
without checking in first.
