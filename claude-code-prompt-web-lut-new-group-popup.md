# Claude Code prompt — "New group" form as a popup dialog

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §53 — read it first. Small, self-contained.

## Current state (confirmed, don't re-investigate)

`apps/web/app/(dashboard)/settings/luts/page.tsx:1101-1140` — one
shared inline form, conditionally rendered with `{newGroupIn && (...)}`.
Three separate triggers all feed the same state:
- "New Platform Group" button, `page.tsx:780`
- "New Private Group" button, `page.tsx:764`
- Per-group "+ subgroup" action, `page.tsx:643` (sets
  `newGroupParent` in addition to `newGroupIn`)

The form always renders at the same fixed point in the page layout
(right after the Platform section closes, before Personal), so
clicking any of the three triggers can make it appear far from where
the user clicked — reads as if it "landed at the bottom of the page."

## Build

Wrap the existing form markup (`page.tsx:1101-1140`) in a Radix
`Dialog` — reuse the same
`Dialog.Root`/`Dialog.Portal`/`Dialog.Overlay`/`Dialog.Content`
structure and styling already used for the Project upload dialog
(`apps/web/app/(dashboard)/projects/[id]/page.tsx:1269-1282`) and the
new LUT upload dialog from §48-REVISED, so all the popups in this app
look consistent.

- `open={newGroupIn !== null}` on `Dialog.Root`, `onOpenChange` wired
  to clear both `newGroupIn` and `newGroupParent` when closed (covers
  Escape and clicking the overlay, in addition to the existing Cancel
  button).
- Keep the Enter-to-submit behavior on the input
  (`page.tsx:1107-1108`) — Radix Dialog doesn't submit forms on
  Enter automatically, so keep that `onKeyDown` handler as-is inside
  the dialog content.
- Keep the placeholder/aria-label logic that distinguishes platform
  vs. personal vs. sub-group naming (`:1114-1127`) exactly as it is —
  don't change the wording, just where it renders.
- All three triggers (`:764`, `:780`, `:643`) need no changes — they
  already just set state; the dialog opening is a pure function of
  that same state.

## Verification

Click "New Platform Group" — popup appears centered on screen
immediately, no scrolling. Click "New Private Group" — same. Click
"+ subgroup" on a group that's scrolled well down the page — popup
still appears centered, not anchored to that group's position.
Escape closes without creating anything. Enter with a name typed
creates the group and closes the popup. Clicking the overlay outside
the dialog also closes it without creating anything.
