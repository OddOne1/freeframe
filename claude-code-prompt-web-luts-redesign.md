# Claude Code prompt — LUT settings: frame-box redesign, count-badge fix, relabel, whole-group drag

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §41 — read it first. **Build after
`claude-code-prompt-web-luts-subgroups.md`** if doing both — this
prompt's redesign work should render sub-groups correctly if they
already exist.

## 1. Count-badge bug — root cause already found, don't re-diagnose

`settings/luts/page.tsx:448` — Platform's `CollapsibleSection` gets
`count={platform.length}`, the true unfiltered total (confirmed correct
server-side, `luts.py:234-254`). But rows render inside nested
per-group/ungrouped `CollapsibleSection`s with independently persisted
collapse state — a collapsed nested section shows zero rows while the
parent badge keeps counting everything. That's the "8 vs 4" report.

Fix: make it visually unambiguous when a nested section is collapsed
vs. actually empty — a totals badge is fine to keep, but the user
should never be confused about "where did 4 LUTs go." Options: an
indicator on the parent frame box when children are collapsed (e.g.
"8 total, 2 hidden" or similar), or auto-expand-once behavior, or
something else — your call, state what you picked and why.

## 2. Frame-box visual redesign

Match the bordered-panel look of `settings/admin/page.tsx`'s
Admins/Members/Deactivated blocks: a prominent title reading "Private"
or "Platform" per section, the whole box collapsible via the shared
`CollapsibleSection` component (already in use here — confirm the
current rendering actually reads as a contained "frame box," not just
a header floating above a list; adjust styling if it doesn't yet match
Admin's visual weight). Nested groups (and sub-groups, if built) keep
their own independent collapse inside each frame box.

**Independent sort per frame box** — confirm Platform's sort and
Private's sort are two separate `useSort` instances (they should be,
per §40's original scope, but verify rather than assume nothing
regressed).

## 3. Button relabeling and repositioning

Current exact state: "New group" (personal, `:375-385`, in the page
header) and "New platform group" (superadmin-only, lowercase,
`:528-539`, buried at the bottom of the Platform section's content).

- Rename to **"New Private Group"** and **"New Platform Group"**.
- Move both into the page header, next to each other and next to
  "Upload .cube" — not one in the header and one buried in a section.
- "New Platform Group" stays superadmin-gated regardless of its new
  position.

## 4. Drag a whole group onto Platform

New capability: dragging an entire personal Main group (not just an
individual LUT) onto the Platform frame box promotes the whole thing in
one operation — the group's `is_platform` flips to true (superadmin
action, since this crosses into platform-management territory even
though the drag originates from the personal section) and every LUT
inside it becomes `is_platform_wide=true`, atomically (one API call,
not N individual promotions that could partially fail). If sub-groups
exist under the dragged group, they and their LUTs come along too.

Needs a group-level drag source distinct from §34's per-LUT drag type —
add a second private drag-type string rather than overloading the
existing `LUT_DRAG_TYPE` for two different payload shapes (a LUT id vs.
a group id are not interchangeable, and a drop handler needs to tell
them apart reliably before deciding what to do).

If §44 (duplicate detection) is already built, promoting a whole
group's worth of LUTs should run the platform-duplicate check on each
one and report which (if any) were rejected as already existing
platform-wide, rather than silently skipping them or failing the whole
operation.

## Verification

Confirm the count-badge fix actually resolves the confusing symptom —
collapse a Platform group, confirm it's now clear from the UI that
LUTs are hidden, not missing. Confirm both renamed/repositioned buttons
work and remain correctly gated (Platform one superadmin-only). Drag an
entire personal group with 2+ LUTs onto the Platform frame box, confirm
the group and all its LUTs become platform-wide in one action, visible
identically to a second superadmin account.
