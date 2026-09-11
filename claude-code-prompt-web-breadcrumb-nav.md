# Claude Code prompt — web: fix breadcrumb/folder navigation not syncing from URL

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §29 — read it first, root cause is fully diagnosed there.

## Root cause

`apps/web/app/(dashboard)/projects/[id]/page.tsx:136-137`:
```js
const [currentFolderId, setCurrentFolderId] = React.useState<string | null>(
  searchParams.get("folder") || null,
);
```
This only reads the URL once, at mount. The breadcrumb's folder links
(`:259-261`) are real `<Link>`s to `/projects/{id}?folder={f.id}` and do
change the URL, but since it's a same-route query-only transition, the
component never remounts, so `currentFolderId` never updates. Clicking a
breadcrumb segment past "Projects" visibly does nothing.

## Fix — recommended direction

Make the URL the actual source of truth for `currentFolderId` rather
than a `useState` merely seeded from it once:
1. Derive `currentFolderId` from `searchParams.get("folder")` directly
   on every render — no separate `useState` for it.
2. Every place that currently calls `setCurrentFolderId(...)` (sidebar
   folder clicks, `handleSelectFolder`, etc. — find all call sites, the
   grep for `currentFolderId`/`setCurrentFolderId` in this file will
   surface them) needs to instead navigate via `router.push` or
   `router.replace` to `/projects/{id}?folder={id}` (or drop the param
   entirely for root).
3. Decide `push` vs `replace` deliberately: folder-to-folder navigation
   should probably be `push` (so back/forward moves between folders,
   which is the whole point of fixing this), but you may want `replace`
   for some transient states — don't default to one without thinking
   about what back/forward should do at each call site.

## Also check

Browser back/forward between folders very likely has the identical
underlying problem, for the identical reason — confirm whether it's
currently broken too, and confirm the fix above resolves it as a side
effect (it should, if `currentFolderId` genuinely becomes URL-derived).

## Verification

Navigate into a nested folder, then click each breadcrumb segment in
turn (including the project-name segment, not just leaf folders) and
confirm the displayed contents change to match. Confirm the browser
back button steps back through folder history correctly after this fix.
Confirm a hard page load with `?folder={id}` in the URL still opens
directly into that folder (the original behavior this `useState`
initializer was there for — don't regress it).
