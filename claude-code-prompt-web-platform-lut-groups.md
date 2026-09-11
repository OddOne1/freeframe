# Claude Code prompt — Platform LUT groups (shared, global)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §39 — read it first. **Build after
`claude-code-prompt-web-collapsible-sections.md`** if doing both —
this prompt assumes platform groups can reuse that shared collapsible
component.

**The design question is already answered — this is a build prompt.**
Platform LUT groups are one shared/global set, visible and editable by
any superadmin, not a private view per superadmin. Don't re-litigate
this.

## Backend

`LutGroup` (`apps/api/models/lut.py:24-45`) currently has `owner_id` —
every group belongs to exactly one user. This app already has the
exact parallel concept for "belongs to everyone, not one owner":
`Lut.is_platform_wide`. Mirror that pattern rather than inventing a new
one — either make `LutGroup.owner_id` nullable with NULL meaning
"platform group," or add an explicit `is_platform: bool` column.
Re-grep the current file for the exact shape of `is_platform_wide`
before deciding, and state which approach you picked and why in your
report.

Endpoints needed (extend `apps/api/routers/luts.py`):
- Any superadmin can create/rename/delete a platform group — same
  shape as the existing personal-group endpoints
  (`create_lut_group`/`rename_lut_group`/`delete_lut_group`,
  `:216-276`), but permission-checked as superadmin-only instead of
  owner-only, and NOT scoped to `owner_id` in the list query.
- `GET` for platform groups needs to return the same shared set to
  every superadmin who asks — not filtered by who's asking.

**Validation, server-side, not just UI**: a platform LUT
(`is_platform_wide=True`) should only be assignable to a platform
group; a personal LUT only to a personal group. Enforce this in
`update_lut` (`:278-320`, the `group_id` handling at `:309-315`) —
reject a mismatched assignment rather than silently allowing it.

## Frontend

`apps/web/app/(dashboard)/settings/luts/page.tsx`'s Platform LUTs
section (`:275-325`) currently renders one flat list. Give it the same
group-listing UI the personal library already has (reuse the
components/rendering logic, don't duplicate it) — including:
- Drag&drop into a platform group, extending §34's existing drag
  mechanism (`LUT_DRAG_TYPE`, the drop-target handlers already built
  for personal groups/Ungrouped/promote-to-platform).
- A "New group" action for platform groups, superadmin-gated.
- Collapsible platform groups, using the shared collapsible component
  from §38 if that's been built, or `UserGroupBlock`'s pattern directly
  if not.

## Verification

As superadmin A, create a platform group and add a LUT to it. As
superadmin B (different account), confirm the same group and LUT
assignment are visible — proving it's genuinely shared, not per-user.
Confirm a non-superadmin sees platform groups read-only (can view but
not create/rename/delete/drag), consistent with how the rest of the
Platform LUTs section already treats non-superadmins. Confirm
attempting to put a platform LUT into a personal group (or vice versa)
is rejected server-side, not just hidden from the UI.
