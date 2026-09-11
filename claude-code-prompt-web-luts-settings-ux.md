# Claude Code prompt — web: Settings → LUTs — multi-upload, drag&drop (incl. Platform), rename, visible platform toggle

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §34 and its "§34 revision" addendum (2026-08-18) — read
both, all citations verified against the current file. This is a build
prompt for five UX fixes in one file,
`apps/web/app/(dashboard)/settings/luts/page.tsx` (rename may also
touch a shared inline-rename component if one already exists
elsewhere in the app — check before building a new one).

## 1. Multi-file `.cube` upload

- Add `multiple` to the file `<input>` (`:133`).
- Rewrite `handleFile` (`:66-85`) to iterate every selected file rather
  than just `files?.[0]`, uploading each through the existing
  `POST /me/luts` endpoint (unchanged, single-file — no backend work
  needed).
- Report success/failure **per file**, not one aggregate message — a
  batch where 2 of 10 fail (bad `.cube` format, duplicate name,
  whatever the existing single-upload error cases are) should still
  upload the other 8 and clearly say which 2 failed and why, reusing
  whatever error message the backend already returns per file.
- One `refreshAll()` at the end rather than one per file.

## 2. Drag & drop grouping

The mutation already exists and already works via the dropdown:
`patch({ group_id })` at `:415-421`/`:349-357`. This is adding a
faster UI path to it, not new backend logic.

- Make `LutRow` (`:327` on) draggable.
- Make each group's `<section>` (`:212` on) and the "Ungrouped"
  section (`:246` on) — and, for symmetry, probably the "New group"
  drop zone if one's being created — valid drop targets.
- On drop, call the same `patch({ group_id: <target group's id, or
  null for Ungrouped> })` that the dropdown item already calls.
- Keep the dropdown's "Move to group" list working exactly as today —
  this is an addition, not a replacement. Not every input device drags
  well; the menu is the accessible fallback.
- **Also make the Platform LUTs section (`:154-192`) a valid drop
  target**, superadmin-only, same `canTogglePlatform` gate as feature
  #3's button below — dropping a LUT there calls
  `patch({ is_platform_wide: true })`, a second path to the same
  mutation the button uses. (The original version of this spec said
  not to do this; that was wrong and is corrected here.) Dragging a
  LUT back *out* of the Platform section isn't requested — don't build
  that direction.

## 3a. Rename — LUTs and groups

**No backend work needed.** Verified directly against
`apps/api/routers/luts.py`: `PATCH /me/luts/{id}` (`update_lut`,
`:278-320`) already accepts `name` (`:303-307` — its own docstring
says "Rename, move between groups, or toggle platform-wide"), and
`PATCH /me/lut-groups/{id}` (`rename_lut_group`, `:243-258`) already
exists and does exactly this. Both are pure frontend gaps.

- Add inline rename for a LUT's name (`LutRow`, name at `:363`) and a
  group's name (group header, `:214`) — click-to-edit, or a "Rename"
  ⋯ menu item, whichever matches an existing inline-rename pattern
  already used elsewhere in this app (asset names in the web app, or
  the desktop app's renaming UI) rather than inventing a new
  interaction from scratch.
- LUT rename: owner-only, same as today's other LUT mutations (no new
  permission check needed — `update_lut` already enforces this
  server-side).
- Group rename: owner-only, same pattern.

## 3. Platform-wide toggle: promote from ⋯ menu to its own button

The capability already exists and is correctly gated
(`canTogglePlatform={isSuperAdmin}`, `:399-407`) — the user (a
superadmin) just didn't find it inside the overflow menu. This file
already has the precedent for exactly this fix: read `SharePopover`
(`:458` on) and its comment at `:452-456` — it replaced an old buried
⋯ → "Share into project" menu item with an always-visible control, and
the old menu item is gone now that `SharePopover` exists (confirmed:
no share item remains in the current ⋯ menu). Do the same thing here:

- Add a small always-visible button next to `SharePopover` (`:382`),
  shown only when `canTogglePlatform` is true, that toggles
  `is_platform_wide` the same way the current ⋯ menu item does
  (`patch({ is_platform_wide: !lut.is_platform_wide })`, `:402`).
  Design it so its state is legible at a glance (e.g. filled/outlined
  globe icon, or matching `SharePopover`'s active/inactive border
  treatment) rather than just a static "Make platform-wide" label that
  doesn't reflect current state.
- Remove the corresponding item from the ⋯ menu (`:399-410`) once the
  button exists — don't leave two controls for one action; the whole
  point of this change is discoverability, and a duplicate path
  undermines that.
- This button should NOT appear on Platform LUT section rows a
  superadmin doesn't own (`canManage = isSuperAdmin && lut.is_owner` at
  `:180` already restricts the whole ⋯ menu there — apply the same
  gate to the new button).

## Verification

Upload 3+ `.cube` files at once, confirm all appear without a page
reload and that a deliberately-broken file (e.g. rename a `.txt` to
`.cube` if there's client or server validation to trigger) fails
without blocking the others. Drag a LUT from Ungrouped into an
existing group and confirm it moves (both visually and via a
follow-up `GET /me/luts` reflecting the new `group_id`); drag it back
to Ungrouped. Drag a LUT onto the Platform LUTs section as a
superadmin and confirm it becomes platform-wide; confirm a
non-superadmin can't (no drop affordance, and the PATCH would 403 if
somehow triggered). As a superadmin, confirm the platform toggle
button appears on your own LUT rows, toggles correctly, and that the
⋯ menu no longer has a duplicate entry for it. As a non-superadmin,
confirm neither the button nor the old menu item ever appears. Rename
a LUT and a group, confirm the new name persists after a refresh
(actually hits the PATCH, not just local state), and confirm rename is
owner-only (a non-owner superadmin can toggle platform-wide but should
not be able to rename someone else's LUT, per `update_lut`'s existing
owner check).
