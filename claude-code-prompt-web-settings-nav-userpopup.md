# Claude Code prompt — Settings nav reorder + dividers, remove user-icon popup

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §46 — read it first. Small, self-contained, two unrelated
layout changes in one prompt.

## 1. Settings sidebar: reorder + dividers

`apps/web/app/(dashboard)/settings/layout.tsx:21-32`
(`settingsNavItems`) and its render loop (`:55-78`). Current order:
Profile, Appearance, Notifications, Branding, Projects, Admin, LUTs,
Contact — flat array, plain `.map()`, no divider concept exists.

New order:
```
Profile
Appearance
Notifications
LUTs
──────────
Projects
──────────
Admin
Branding
──────────
Contact
```

Existing visibility gating (`adminOnly`, `projectPrivilegeOnly`) stays
exactly as-is on each item, just reordered. Add divider rendering
between the three marked groups — a divider next to a
conditionally-hidden item (e.g. the one before/after Projects, which is
`projectPrivilegeOnly`-gated) must not render as a stray line when
that item is hidden for the current user. Restructuring the flat array
into grouped sections (each with its own array of items) is probably
the cleanest way to make this work correctly rather than
index-counting inside the render loop — your call on the exact
implementation shape.

## 2. Remove the user-icon popup menu

`apps/web/components/layout/sidebar.tsx:204-271` — the avatar opens a
Radix `DropdownMenu` with: Profile (plain link, `:238-246`),
conditional Settings (`:247-261`, target depends on `isSuperAdmin`),
separator, Log out (`:264`).

Replace this entire dropdown with a plain `Link` to `/settings/profile`
— no popup, no menu, avatar click just navigates. The per-role routing
logic that picked between `/settings/admin` and `/settings/projects`
for the old "Settings" item is no longer needed here: Settings itself
already gates what each user sees once they arrive
(`settingsNavItems`'s own `adminOnly`/`projectPrivilegeOnly`), so
landing everyone on `/settings/profile` and letting them navigate from
there is sufficient.

**Log out needs a new home.** The dropdown was its only exit besides
whatever exists inside Settings pages already. Check
`settings/profile/page.tsx` — if it doesn't already have a log-out
control, add one there (reuse whatever `logout` function/hook the
current dropdown item calls, `sidebar.tsx:264`).

## Verification

Confirm the Settings sidebar shows the new order with dividers in the
right places, and that a user without project-owner/admin privileges
(so Projects is hidden) doesn't see a stray divider where Projects
would have been. Click the avatar in the main app sidebar — confirm it
navigates straight to `/settings/profile` with no popup appearing at
any point (not even a flash before redirect). Confirm logging out still
works, from its new location on the Profile page.
