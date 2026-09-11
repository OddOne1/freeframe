# Claude Code prompt — shared collapsible-section component, applied across Settings

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §38 — read it first.

**Build this before §39 (platform LUT groups) and §40 (sortable
headers) if building multiple of these prompts in sequence** — both
later prompts assume this shared component exists, since §39 needs
platform groups to be collapsible too.

## 1. Extract the shared component

`apps/web/app/(dashboard)/settings/admin/page.tsx`'s `UserGroupBlock`
(`:953-1009`) already has the exact pattern needed: a header button
with a `ChevronDown` that rotates when collapsed, title reading `{title}
({count})`. Extract this into
`apps/web/components/shared/collapsible-section.tsx` (or wherever this
app's other shared components live — match convention) as a generic,
reusable component. Refactor Admin's 3 existing instances
(Admins/Members/Deactivated, `:1324-1344`, state at `:1084-1086`) to
use the new shared component — don't leave the original as a fourth,
divergent implementation.

## 2. Wire it into Settings → LUTs

`apps/web/app/(dashboard)/settings/luts/page.tsx`:

- Each personal group (`:341-382`) gets its own collapse.
- Ungrouped (`:386-419`) gets its own collapse.
- Platform LUTs section (`:275-325`) gets its own collapse.
- **Additionally**, the personal library as a whole and the Platform
  LUTs section as a whole each need a top-level collapse, independent
  of their internal groups — so a user can hide the entire personal
  library or the entire Platform section, not just individual groups
  within them. Two levels of collapse here: section-level (personal vs.
  platform) and group-level (within each).

## 3. Wire it into Settings → Projects

`apps/web/app/(dashboard)/settings/projects/page.tsx`'s superadmin
view: "Joined Projects" (`:1080-1097`) and "General Projects"
(`:1099-1113`) each get a collapse.

## 4. Persistence

Persist collapse state to `localStorage`, keyed per section (e.g.
`ff-collapse-luts-platform`, `ff-collapse-projects-joined`) — this is
UI convenience state, not data worth a backend migration. This is a
deliberate departure from Admin's current behavior (which resets on
every page load) — apply the same persistence to Admin's 3 blocks too
once they're on the shared component, for consistency, unless there's
a concrete reason found while building it that argues against that
(state so in your report if you deviate).

## Verification

Collapse a LUT group, reload the page, confirm it's still collapsed.
Collapse the entire Platform LUTs section and confirm the personal
library still shows normally (and vice versa). Collapse "Joined
Projects" in Settings → Projects and confirm "General Projects" is
unaffected. Confirm Admin's Admins/Members/Deactivated blocks still
work identically to before the refactor (same chevron rotation, same
count-in-header format), just now backed by the shared component.
