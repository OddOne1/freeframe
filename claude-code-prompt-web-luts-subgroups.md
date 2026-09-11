# Claude Code prompt — LUT sub-groups (one level of nesting)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §45 — read it first. **Recommended to build this first**
among the new §41-§45 batch — it's a schema change several of the
others (§41's redesign, §42's folder-upload group creation) should be
built aware of.

## Backend

`apps/api/models/lut.py`'s `LutGroup` is currently flat by deliberate
choice (its own docstring says so, and says a `parent_id` column would
be cheap to add later — do exactly that):

- Add `parent_group_id`, nullable, self-referential FK to
  `lut_groups.id`.
- Migration + backfill (existing groups: NULL, i.e. everyone stays a
  top-level Main group — no existing behavior changes).
- Server-side validation on whatever endpoint sets `parent_group_id`:
  - Reject if the target group already has children (no
    grandchildren — enforces exactly one level).
  - Reject if the group being nested already has a parent of its own
    being reassigned to grandparent-depth (same rule, other direction).
  - Reject if `is_platform` doesn't match between parent and child — a
    personal sub-group must have a personal parent, a platform
    sub-group must have a platform parent.
- Decide and state: does creating a group with a `parent_group_id`
  happen through the existing `create_lut_group`/`create platform
  group` endpoints (extended to accept an optional parent) or a new
  endpoint? Prefer extending existing ones unless there's a concrete
  reason not to.

## Frontend

`apps/web/app/(dashboard)/settings/luts/page.tsx`: sub-groups render
nested inside their Main group's `CollapsibleSection`
(`apps/web/components/shared/collapsible-section.tsx`), each with its
own independent collapse. Check whether `CollapsibleSection` already
supports being nested inside itself cleanly (it likely does if it was
built as a generic component rather than assuming a fixed depth) —
confirm rather than assume, and only add depth-handling if something
actually breaks.

**UI for creating a sub-group**: needs a way to say "this new group is
a sub-group of X" — could be a dropdown/selector on the existing
create-group form (offering "Top-level" or an existing Main group as
parent), or a "New sub-group" action attached to each Main group's
header. Your call on which reads more naturally in this app's existing
UI language; state which you picked.

**Drag&drop**: a LUT can be dropped directly into a sub-group, same
mechanism as dropping into a top-level group today. Dragging a whole
group to become someone else's sub-group (or promoting a sub-group back
to top-level) is explicitly NOT requested — don't build it, keep scope
to LUT-into-subgroup drops only.

## Verification

Create a Main group, create a Sub group under it, confirm a LUT can be
dropped into the sub-group and displays there correctly (collapsed and
expanded). Confirm attempting to nest a third level (sub-group of a
sub-group) is rejected server-side. Confirm a personal sub-group can't
be attached to a platform Main group or vice versa. Confirm existing
groups (no parent) are completely unaffected — this should be a purely
additive capability.
