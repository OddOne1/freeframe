# Claude Code prompt — desktop: visible eject button on volume tiles, gated by role

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §76 — read it first, including why "prevent OS-level
eject" was scoped out. Do not run `npm test` or any e2e script other
than the one named below (see CLAUDE.md's standing rule about
`apps/desktop`'s test suite being unscoped and focus-stealing).

## Current state (confirmed, don't re-investigate)

- Eject already exists end to end: `main.js:291-341`
  (`ipcMain.handle("volumes:eject", ...)`) refuses internal drives and
  any volume with a running/queued job touching it.
  `index.html:2470-2486` exposes it via the tile's right-click context
  menu ("Eject" for a real volume, "Disconnect" for a network mount),
  disabled only when `isBusy(path)` (mid-copy). `ejectVolume(vol)`
  (`:2522-2533`) is the actual handler — on success it clears
  `sourcePath`/`destNodes` for the ejected path silently; on failure
  it calls `showEjectError()`.
- `makeTile()` (`:2564-2713`) already has a top-right button on the
  same pattern this needs: the `.tile-menu` kebab (`:2694-2705`),
  appended to the tile's `media` element, with `mousedown` stopped
  from propagating (so it doesn't also start a drag) and `click`
  stopped from bubbling (so it doesn't also open the tile's own
  handlers).
- `isBusy(path)` — find its definition and reuse it, don't reimplement.
- `sourcePath` and `destNodes` are the two structures that hold role
  assignment; `deviceFor()` exists if you need device-level matching,
  but this button's role check should be an EXACT path match (`entry.
  mountPoint === sourcePath` / `destNodes.some(n => n.path === entry.
  mountPoint)`), not device-level — ejecting the physical volume is
  what's being gated, and a tile in the Volumes column is always a
  real mount point or a project URI (projects have nothing to eject,
  see the `vol` lookup at `:2473` for how the existing menu entry
  already filters projects out).

## Build

1. In `makeTile()`, add a new button mirroring `.tile-menu`
   (`:2694-2705`) but positioned top-LEFT via CSS (new class, e.g.
   `.tile-eject`), appended to the same `media` element. Only render
   it for a real volume (same `vol = volumes.find(...)` /
   `vol.type !== "internal"` condition already used at `:2473-2474` —
   a project tile and the internal drive tile get no eject button at
   all, not just a disabled one, matching "internal drive(s) should
   not be ejectable").
2. Disabled attribute set when EITHER:
   - `isBusy(entry.mountPoint)` (existing mid-copy gate), OR
   - the tile currently holds a role: `sourcePath === entry.mountPoint`
     OR `destNodes.some((n) => n.path === entry.mountPoint)`.
   Give the disabled state a `title` explaining why (e.g. "Remove this
   drive's Source/Destination role before ejecting" vs the existing
   mid-copy message), so a disabled button isn't silently
   unexplained.
3. On click (when enabled), call the SAME `ejectVolume(vol)` function
   the context menu already uses (`:2522`) — don't duplicate its
   error-handling or its silent-unassign fallback logic. Since this
   button already refuses when a role is held, `ejectVolume()`'s
   existing "silently clear the role on success" branch becomes
   unreachable from this new entry point (it can still fire from the
   old context-menu path, which is intentionally left as-is per the
   spec).
4. Stop `mousedown` propagation and click bubbling on the new button,
   same as the kebab (`:2704`) — it must not also start a tile drag or
   trigger the tile's own click/context-menu handlers.

## Verification

With a card assigned as Source, confirm its tile in the Volumes column
shows the eject button disabled, with a title explaining why. Remove
the Source assignment (via the existing "Remove" context-menu entry)
— confirm the button becomes enabled. Click it — confirm the volume
actually ejects (same success path as the existing context-menu
"Eject"). Assign a card as a destination (including a cascaded child,
not just top-level) — confirm its button is disabled the same way.
Confirm the internal/boot drive's tile shows NO eject button at all.
Confirm a FreeFrame project tile shows no eject button (nothing to
eject). Start a copy job, then check the eject button on a volume
that's neither source nor dest for that job — confirm it's still
enabled (mid-copy only blocks the volumes actually in use, unchanged
from today). Confirm the pre-existing context-menu "Eject"/"Disconnect"
entry still works exactly as before, unchanged.
