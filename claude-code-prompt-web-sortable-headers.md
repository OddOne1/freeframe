# Claude Code prompt — sortable column headers across Settings

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §40 — read it first.

**Confirmed by prior audit, don't re-check**: no clickable
column-header sort component exists anywhere in this app.
`components/projects/sort-popover.tsx` and the `<select>` at
`settings/admin/page.tsx:1290-1291` are both dropdown/named-option sort
selectors, a different pattern. The user explicitly chose building a
real column-header component over extending that dropdown convention —
this is a build prompt for the new pattern, not a request to
re-litigate the choice.

## Build

1. **One shared component/hook** — a clickable table-header cell that
   shows a sort-direction arrow when active, toggles ascending/
   descending on repeat clicks. Put it in `components/shared/` or
   wherever this app's other reusable table pieces live. Sort state can
   be local per table (no need for a global store) — this isn't data
   worth persisting server-side, and cross-table persistence isn't
   required (state your call on localStorage persistence per table if
   you think it's worth it, it's optional here, lower stakes than §38's
   collapse persistence).

2. **Wire into `settings/projects/page.tsx`**: `OwnedProjectsView`'s
   table and both `ProjectsTable` instances (Joined/General) in the
   superadmin view.

3. **Wire into `settings/admin/page.tsx`**: the Admins/Members/
   Deactivated user tables. Per the screenshot's actual columns — User,
   Projects, Role, Status, Joined, Storage — add sortable headers where
   it's meaningful (Name/User, Role, Status, Joined date, Storage
   value). Projects and Actions columns likely don't have a sensible
   single sort key (Projects is a multi-badge list per row) — use
   judgment, don't force a sort onto a column where "sorted by" doesn't
   mean anything coherent, and say which columns you skipped and why.

4. **Wire into `settings/luts/page.tsx`** — **two separate sort
   surfaces**, both requested explicitly:
   - Sort the **list of groups themselves** (by name, or by how many
     LUTs each contains).
   - Sort the **LUTs within** each group/section (by name, size, date
     added) — this applies inside every group, Ungrouped, and the
     Platform LUTs section (including platform groups if
     `claude-code-prompt-web-platform-lut-groups.md` has already been
     built).

## Verification

In each of the three Settings pages, click a column header and confirm
the list reorders; click again and confirm it reverses. Confirm sorting
one table doesn't affect the sort state of a different table on the
same page (e.g. sorting Admins doesn't resort Members). In LUTs,
confirm group-order sorting and within-group LUT sorting are
independent controls that don't interfere with each other, and that
sorting doesn't break collapsed/expanded state from §38 if that's
already built (a sorted-but-collapsed group should stay collapsed,
just with its contents reordered underneath once expanded).
