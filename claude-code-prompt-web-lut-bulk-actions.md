# Claude Code prompt — LUT bulk actions: group move, Platform promote/demote, ungroup

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §56 — read it first. Builds directly on §54's
multi-select toolbar — don't rebuild selection state, extend it.

## Current state (confirmed, don't re-investigate)

Every action below already exists as a single-item
`PATCH /me/luts/{id}` — no new backend endpoint needed:
- Move to group: `moveLutToGroup`, `page.tsx:522-527` — `{ group_id }`.
- Ungroup: same call, `group_id: null` (already used at `:1201`/`:1282`).
- Promote to Platform: `moveLutToPlatformGroup`, `:537-547` —
  `{ group_id, is_platform_wide: true }` in one call.
- Demote to private: the row's existing toggle button, `:1619-1620` —
  `patch({ is_platform_wide: !lut.is_platform_wide })`.
- `canTogglePlatform={isSuperAdmin}` on both personal and platform
  rows (`:817`, `:842`) — this is a role gate, not an ownership gate;
  §54's checkbox already restricts selection to manageable rows, so
  the only extra gate the toolbar needs is hiding the two Platform
  buttons from non-superadmins.
- `LutGroup.is_platform` means a group is scoped to personal OR
  platform — a LUT can't move into a group outside its own scope.
  Bulk "move to group" therefore only makes sense for a
  single-scope selection.

## Build

Extend §54's toolbar (`page.tsx:1048+`) with four new actions:

1. **"Move to group ▾"** dropdown — lists the current user's groups
   in whichever scope (personal/platform) the ENTIRE selection is in;
   include a "New group…" entry that opens the §53 popup dialog (or
   reuses `handleCreateGroup`) scoped correctly, then moves every
   selected LUT into the resulting group. If the selection spans both
   scopes, hide this control and show a short inline note ("Select
   only personal or only Platform LUTs to move as a group") rather
   than guessing which scope to use.
2. **"Remove from group"** — `Promise.allSettled` over
   `PATCH /me/luts/{id}` with `group_id: null` for every selected id.
3. **"Move to Platform"** — render only when `isSuperAdmin` and at
   least one selected LUT has `is_platform_wide === false`. Acts on
   just that subset — `{ is_platform_wide: true, group_id: null }`
   unless the user picked a target group via #1 first — and silently
   skips any already-platform LUTs in the selection (not an error for
   them, just a no-op).
4. **"Move to Private"** — render only when `isSuperAdmin` and at
   least one selected LUT has `is_platform_wide === true`. Acts on
   just that subset, `{ is_platform_wide: false }`, skips
   already-personal ones.

All four use the same `Promise.allSettled` + partial-failure pattern
§54 already established for bulk delete: failed ids stay selected and
report their own message, succeeded ids clear from selection, list
refreshes once at the end.

## Verification

Select 3 personal LUTs → "Move to group" into an existing personal
group → all 3 move, selection clears. Select 2 owned platform LUTs →
"Move to Private" → both demote out of the Platform section. Select a
mix of personal + platform → confirm "Move to group" is hidden with
the explanation note, "Move to Platform" only touches the non-platform
ones, "Move to Private" only touches the platform ones. As a
non-superadmin with personal LUTs selected, confirm neither Platform
button renders. Delete a group from another tab mid-bulk-move —
confirm the affected LUT stays selected with its own failure message
rather than the batch reporting silent success.
