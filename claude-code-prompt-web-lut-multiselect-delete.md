# Claude Code prompt — LUT multi-select + bulk delete

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §54 — read it first.

## Current state (confirmed, don't re-investigate)

- Single delete: `deleting` state
  (`apps/web/app/(dashboard)/settings/luts/page.tsx:228`), shared
  `ConfirmDialog` (`:1264-1276`), `handleDelete` (`:425-431`) →
  `DELETE /me/luts/{id}`. Backend (`apps/api/routers/luts.py:747`,
  `_get_own_lut`) is strict `owner_id == current_user.id` — no
  separate platform-LUT delete rule; client already gates platform
  rows on `canManage={isSuperAdmin && lut.is_owner}` (`:763`).
- **No bulk-delete endpoint exists anywhere in this app, for any
  resource — this is the established convention, not a gap.**
  `project-members-dialog.tsx` and `asset-grid.tsx` both do
  multi-select bulk-delete by looping the existing single-item
  endpoint client-side (`Promise.allSettled` in the members dialog,
  a sequential `for` loop in the asset grid) rather than adding a
  batch route — explicitly commented in the members dialog as
  deliberate, to avoid re-checking authorization in two places.
  Follow the same approach here.
- LUT rows render across up to 4 separate lists via `renderGroupTree`
  (`:662-733`): Platform-grouped, Platform-ungrouped,
  Private-grouped (with sub-groups), Private-ungrouped. No selection
  UI exists in this file today.

## Build

1. `const [selectedLutIds, setSelectedLutIds] = React.useState<Set<string>>(new Set())`
   — one set spanning all 4 lists, same `Set<string>` convention as
   the two existing multi-select UIs in this codebase.
2. Checkbox on each LUT row, but **only where delete is already
   permitted**: personal rows always; platform rows only when
   `canManage` is already true (`isSuperAdmin && lut.is_owner`) —
   reuse the exact existing condition, don't create a new one. A row
   with no checkbox must never end up selectable by any other means.
3. Selection toolbar (same shape as `project-members-dialog.tsx`'s):
   renders only when `selectedLutIds.size > 0`, shows the count, a
   "Clear selection" action, and "Delete selected." The latter opens
   the existing `ConfirmDialog` (`:1264-1276`) — generalize its
   copy to show a count ("Delete 3 LUTs?") when more than one is
   selected, instead of the single LUT's name.
4. Confirming runs `Promise.allSettled` over
   `DELETE /me/luts/{id}` per selected id (mirror
   `project-members-dialog.tsx`'s `runBulk`, lines 407-434, for the
   exact shape) — no new backend endpoint. On completion,
   successfully-deleted ids clear from the selection and the list
   refreshes; any that failed stay selected (retry-friendly, matches
   the members dialog's behavior) and their failure is surfaced
   (toast/inline message — match whatever the members dialog already
   does for a per-item bulk failure).
5. Selecting across Platform and Private sections simultaneously is
   fine — same endpoint, same per-item ownership check either way,
   nothing to special-case.

## Verification

Select 2 personal LUTs + 1 owned platform LUT (mixed) — toolbar shows
"3 selected," confirming deletes all 3, selection clears, list
refreshes. As a superadmin who doesn't own a given platform LUT,
confirm that row never renders a checkbox at all. Select 2 LUTs, then
before confirming have one of them deleted from another session/tab
— confirm on submit the already-gone one fails cleanly, the other
succeeds, and the failed id remains selected rather than the whole
action silently reporting full success.
