# Claude Code prompt — web: share-link sidebar — hide disabled tabs, add Fields info level

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §33 — read it first. The design questions are already
answered there (asked and confirmed with the user 2026-08-18); this is
a build prompt, not an investigation prompt. Flag back if the real
code contradicts something written there, don't silently override it.

## The two bugs being fixed

1. `apps/web/app/share/[token]/page.tsx`'s `ShareViewer`: when
   `permission === 'view'`, the Comments tab still shows with a
   "Comments are disabled" message (`:599-603`) instead of
   disappearing.
2. `apps/web/components/share/folder-share-viewer.tsx`'s sidebar
   (`:914-958`): the Comments/Fields switcher is unconditional, and
   the Fields tab has never rendered anything — `activeTab ===
   'fields'` isn't handled at all (`:927` only branches on
   `'comments'`).

## Decisions already made (§33) — don't re-litigate

- Sidebar (including its open/close toggle button) is fully hidden
  when both Comments and Fields end up disabled for a link.
- When exactly one of the two is enabled, show that panel with **no**
  tab switcher — not a switcher with one dead tab.
- When both are enabled, keep today's switcher behavior.
- Fields is independent of the comments permission — its own setting,
  not a fallback.
- Fields is three states: `disabled` / `basic` / `full`.
  - `basic`: name, type, description, rating, due date, keywords —
    exactly what `page.tsx`'s current Fields tab already renders
    (`:606-633`), reuse that.
  - `full`: basic + `primaryFile.technical_metadata` (the same
    expandable list built at
    `apps/web/app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx:1526-1538`)
    + `SidecarMetadata` (`apps/web/components/review/sidecar-metadata.tsx`).
  - Explicitly **excluded** from `full`: custom project-defined
    metadata fields and the rating voter breakdown — both are
    internal/collaboration data, not asset data, and shouldn't be
    exposed to an anonymous share-link recipient. If you think this
    scoping is wrong, say so in your report rather than expanding it
    unasked.

## Build order

### 1. Backend

- `apps/api/models/share.py`: new column on `ShareLink`, following
  `allowed_download_variants`'s exact shape (typed Python enum, not a
  raw string — see `DownloadVariant` in the same file for the
  pattern). Call it something like `fields_visibility` with values
  `disabled`/`basic`/`full`.
- Migration + backfill: existing links get `disabled` (neither current
  Fields implementation was a real, intentionally-shipped feature —
  page.tsx's works but was never gated by a setting, folder's never
  worked at all — so there's nothing existing behavior obligates you
  to preserve here, unlike §30's boolean-to-list mapping).
- `apps/api/schemas/share.py` / `apps/api/routers/share.py`: expose
  and accept the new field wherever `allowed_download_variants` is
  read/written today (same routes, same PATCH shape) — trace it the
  same way §30's build traced `allow_download`, don't assume it's
  only in one place.
- New route (or extend an existing share-token route) to serve
  `technical_metadata` + sidecar data for `full` — this doesn't exist
  today for unauthenticated share viewers. Gate it server-side on
  `fields_visibility == 'full'` for that link, the same enforcement
  pattern as `_require_download_variant` (single point, not
  duplicated per caller).

### 2. Frontend — shared tab-visibility logic

Both `page.tsx`'s `ShareViewer` and `folder-share-viewer.tsx`'s
sidebar need identical "which tabs are visible, is the switcher shown,
is the sidebar shown at all" logic. Write this once (a hook or small
shared component) and use it in both places, rather than writing the
same conditional out twice — this codebase has had real bugs from
exactly that pattern drifting (§30's `_require_download_variant`,
§32's `resolveStreamUrl`, both call this out explicitly as the
reason they were centralized).

### 3. Frontend — Fields content

- `page.tsx`: existing basic Fields content stays; add the `full`
  additions (technical metadata list + sidecar metadata) reusing the
  existing components/rendering from the asset detail page rather
  than re-implementing them.
- `folder-share-viewer.tsx`: build actual Fields content for the first
  time — basic and full, same components as above.

### 4. Frontend — share-link settings UI

Add a 3-way Fields control (Disabled/Basic/Full) to the three settings
surfaces `DownloadVariantPicker` already lives in:
`share-link-detail.tsx`, `share-create-dialog.tsx`,
`review/share-dialog.tsx`. Independent control from the existing
comments toggle, not nested under it.

## Verification

Create a link with comments off and Fields off — confirm the sidebar
and its toggle button don't appear at all. Comments on, Fields off (or
vice versa) — confirm the panel shows with no tab switcher. Both on —
confirm the switcher still works like today. Fields=full — confirm
technical metadata and sidecar data appear and that custom
project-defined fields and voter breakdown do NOT appear anywhere in
the share view. Test both the single-asset path (`page.tsx`) and a
folder share (`folder-share-viewer.tsx`) — this bug and its fix are
almost identical in both files, verify both were actually fixed rather
than assuming a fix in one location covers the other.
