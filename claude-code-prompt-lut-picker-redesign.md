# Claude Code prompt — LUT picker: rebuild as a left sidebar with
grouped, collapsible, sub-grouped LUTs

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`. Do not start this until told to — it's queued behind the
processing-progress fix and the UI-order fix already in flight. Run
`npx vitest run` at the end.

## Confirmed current state

Single shared component, used identically for video and photo (one
call site: `app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx:433`,
same review page for both media types — no duplicate implementation to
worry about) — `components/review/lut-picker.tsx`.

**Three separate problems, all confirmed by reading the component:**

1. **Fixed 240px width, non-responsive**: `lut-picker.tsx:125`,
   `DropdownMenu.Content` has `w-60 max-h-80 overflow-y-auto`. LUT names
   truncate inside via `truncate` with no `max-w` override (`:76`), and
   the trigger button's own label is separately clipped at
   `max-w-[110px]` (`:116`).
2. **Overlaps left nav because of anchor direction**: `lut-picker.tsx:122-124`
   — Radix `DropdownMenu.Content` uses `align="end"`, no `side` prop
   (defaults `bottom`), no `collisionPadding`/`avoidCollisions`. `align="end"`
   anchors the panel's right edge to the trigger and grows LEFTWARD —
   with the trigger sitting near the left of the transport toolbar, a
   240px panel growing left runs straight into the nav. This is a
   direct architecture cause, not a viewport-collision edge case.
3. **Trigger button unreadable in some conditions**: `lut-picker.tsx:99-118`
   button classes have no `bg-*` at all in either state — just a 1px
   border (`border-border`/`border-accent`) and text color, sitting
   directly over arbitrary video/photo content with no backdrop fill or
   blur to fall back on. Low-contrast footage behind it makes the whole
   control disappear.

**Groups: the hard part is easier than it looks.** `group_id` is
already present on every LUT the picker receives —
`hooks/use-lut.ts:36-38` fetches `GET /projects/${projectId}/luts`,
whose backend response (`apps/api/routers/luts.py:827-886`,
`_to_response`) already sets `group_id` per LUT. It's just unused today
— the picker only splits personal vs. shared-with-project
(`lut-picker.tsx:43-44`), nothing group-aware. What's MISSING is the
group's own name/nesting — that lives in `GET /me/lut-groups`
(`routers/luts.py:438-446`) and `GET /luts/platform-groups`
(`routers/luts.py:499`), which the picker doesn't currently call. So:
membership linkage needs no backend change, but resolving `group_id` →
group name/parent needs either an additional fetch to those existing
endpoints, or (cleaner, your call) a small extension to `LutResponse`
to inline the group name so the picker doesn't need a second round-trip.

**Collapse: don't build new, reuse what's already there.**
`components/shared/collapsible-section.tsx` is the exact shared pattern
already used by LUT Settings, Projects, and Admin (per its own doc
comment: "Admin now renders through this too rather than being left as
a fourth divergent copy"). It already handles persisted collapse state
(`storageKey` → `localStorage`, restored pre-paint), accessibility
(`<h2><button aria-expanded>`), and nested groups (LUT Settings already
uses it for Main/Sub group nesting at
`app/(dashboard)/settings/luts/page.tsx:1345,1395,1440,1475,1968`). Use
this directly for per-group collapse in the picker — do not build a
second collapse mechanism.

## Decided direction (don't re-litigate this — it's settled)

Not a dropdown. Rebuild as a persistent left sidebar panel, matching
the existing layout pattern already used for the right-hand
Comments/Fields/Transcript panel — same visual language (surface,
border, header row), mirrored to the left side. It sits directly
between the icon rail (the narrow left-most column with the layers/
bell/upload icons) and the video/photo frame, pushing the frame over
rather than floating above it. Roughly 260px wide as a starting point,
adjust based on what real LUT names/group headers actually need.

The current floating trigger button stays, but changes role: instead
of opening a dropdown, it toggles the sidebar open/closed. When closed,
the frame reclaims the full width; when open, the sidebar occupies its
column and the frame narrows. Persist the open/closed state the same
way `CollapsibleSection` persists collapse state (`localStorage`), so
it doesn't reset every time the user reloads or switches assets.

## Build

1. Build the sidebar panel and wire the trigger button to toggle it,
   per the "Decided direction" section above. Reuse the existing
   right-panel's structural pattern (container, header, scroll
   behavior) rather than inventing new sidebar chrome from scratch —
   check whatever component renders the Comments/Fields/Transcript
   panel shell for the pattern to mirror.
2. Remove the two truncation points (`w-60`, `max-w-[110px]`) in favor
   of a width that fits real LUT names, or wrap/ellipsize only as a
   last resort at a much more generous width. No overlap concern
   anymore since this isn't a floating dropdown, but still don't
   truncate names unnecessarily.
3. Fix trigger button contrast: add a real background fill (a solid or
   semi-opaque `bg-*` with enough contrast against arbitrary
   video/photo content — check what the app's other floating-over-media
   controls use, e.g. the comment-toggle/zoom-controls background classes
   from the compare-mode work, for a consistent pattern rather than
   inventing a new one) so the button reads clearly regardless of
   what's playing behind it, in both its open and closed toggle states.
4. Fetch and resolve LUT groups (per the "groups" section above),
   render them as `CollapsibleSection`s wrapping each group's LUT list,
   preserving the existing personal/shared split as either top-level
   sections or a filter — your call on which reads more clearly with
   groups added, but don't lose that existing distinction.
5. **Sub-groups, one level of nesting** — this picker needs to support
   the same Main/Sub group nesting that LUT Settings already renders
   via `CollapsibleSection` at
   `app/(dashboard)/settings/luts/page.tsx:1345,1395,1440,1475,1968`.
   Check how that page resolves and nests sub-group membership (it's
   already solved there) and mirror the same approach here rather than
   re-deriving it — a sub-group is a `CollapsibleSection` nested inside
   its parent group's `CollapsibleSection`, collapse state persists
   independently per level. This is the same nesting scoped separately
   for LUT Settings under a different task (§81) — if that work has
   already landed by the time you read this, reuse its group-resolution
   logic directly instead of writing a second version; if not, resolve
   group→parent linkage the same way LUT Settings does.
6. Confirm this single component still serves both video and photo
   review identically — no need to branch by media type anywhere in
   this work.

## Verification

Manual, real browser: confirm the sidebar renders in its own column
between the icon rail and the video/photo frame, not floating over
either. Confirm the toggle button opens/closes it and the frame
resizes correctly both ways. Confirm the open/closed state persists
across a reload. Confirm the trigger stays readable over both a busy/
light-colored frame and a dark frame, in both toggle states. Confirm
groups AND sub-groups render correctly nested, each level collapses/
expands and persists its own state independently across a reload.
Confirm full LUT names are readable, no truncation on reasonably-named
LUTs. Confirm applying a LUT from inside a collapsed-then-reopened
group or sub-group still works correctly. Run `npx vitest run` for the
whole app at the end — report pass/fail counts, flag anything not
already a documented pre-existing failure.
