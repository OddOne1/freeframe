# Claude Code prompt — desktop: boot-drive duplicate tile, role outlines only, log clear, context menu cleanup

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §59 (desktop) — read it first. Six parts; build #0 (the
root-cause fix) before the rest — everything else is secondary to
"the duplicate tile must never happen."

## 0. Root cause: `deviceFor()` never matches boot-volume folders

**Current state, confirmed**: the mechanism that collapses a picked
sub-folder onto its containing drive's tile already works for
external drives — `volumesColumnEntries()`
(`apps/desktop/src/renderer/index.html:1644-1650`) filters out picked
folders whose `deviceFor()` resolves to a real volume, and
`roleFor()`/`roleClass()` (`:1662-1681`) apply the highlight to that
volume's own tile. The bug is inside `deviceFor()`
(`:2116-2124`): it string-prefix-matches against
`volumes[].mountPoint`, and `volumes` (`apps/desktop/src/main/volumes.js:107-162`,
`listVolumes()`) only enumerates `/Volumes`. macOS user folders
(`~/Downloads`, `~/Desktop`) resolve via APFS firmlinks to
`/Users/...` paths, which never start with `/Volumes/Macintosh HD/` —
so `deviceFor()` returns `null` for them, the filter fails to exclude
them, and they render as standalone extra tiles.

**Fix**: read `listVolumes()` to find how it marks the boot/internal
volume vs. external ones in the returned array (a `kind`/`isInternal`
field or similar). Change `deviceFor()` so that any path NOT matching
an external volume's mount-point prefix falls back to the internal
volume by default, rather than returning `null`. Don't hardcode
`/Users` as a special path prefix — on macOS anything outside
`/Volumes/<external>` is definitionally internal storage, so "internal
is the fallback, externals need the prefix match" is the correct
framing, not a path-based special case.

## 1. Text badges removed everywhere, outline-only

`.tile-roles` (`index.html:2654-2657`) unconditionally adds a
"Source"/"Dest" text badge on every tile in all three columns,
regardless of column. Remove this block entirely — the existing
colored borders (`.tile.role-src` blue, `.tile.role-dst` teal,
`index.html:385-410`) already communicate the same state and are
being kept exactly as-is. This removes badges from the Source/Dest
columns' own tiles too, not just the middle column — the user's
stated rule ("colored outlines are enough") reads as blanket, so
treat it as blanket; flag in the build report if this needs walking
back to middle-column-only.

## 2. `role-both` needs real diagonal stripes, not a gradient split

Current `.tile.role-both` (`:402-409`) is a two-color diagonal
gradient, deliberately not `border-image` stripes per its own
comment (breaks `border-radius`). Replace it with genuine repeating
diagonal stripes in the app's existing blue (`var(--accent)`) and
teal (`var(--status-turquoise)`) — matching the visual style of a
barrier-tape reference image the user provided (diagonal
candy-stripe pattern), not the current half-and-half split. Preserve
rounded corners — a layered pseudo-element with
`repeating-linear-gradient` background, its own `border-radius`, and
`overflow: hidden` is one way to do this without `border-image`'s
corner problem; pick whatever technique actually keeps the corners
round, and say what you used in the build report.

## 3. Log panel: clear-all + per-row remove (history only)

No remove/clear function exists today —
`apps/desktop/src/main/job-queue.js`'s `JobQueue` only has an
automatic 50-item cap (`_trimHistory()`, `:295-305`) and
`cancel`/`cancelAll` for in-flight jobs (`:167-189`). Add:
- `JobQueue.removeFinished(id)` and `JobQueue.clearFinished()` —
  both must only ever touch jobs whose `status` is `done`, `failed`,
  or `cancelled`. A `queued`/`running` job must be untouchable by
  these (that's what Cancel is for — don't let Clear silently cancel
  a running job).
- New IPC handlers (`jobs:remove`, `jobs:clear` or similar — match
  the naming convention of the existing `jobs:list` handler in
  `main.js:856`) and matching `preload.js` bridge methods next to
  `listJobs`/`cancelCopy`.
- UI: a small X per row and a "Clear" action near the panel's
  existing "Transfers"/"Detach" controls, in
  `apps/desktop/src/renderer/panel.js`'s `renderJobs()` — this is
  shared between the docked tab and the detached window
  (`panel.html`), so one change covers both. `renderJobs()` currently
  only emits `onCancel`/`onOpenLog` per row (`panel.js:78`) — add an
  `onRemove` callback alongside them, and a page-level `onClearAll`.

## 4. Context menu, source tiles (`role === "source"`)

In `openMenu()` (`index.html:2261-2521`): remove "Set as Source"
entirely for a tile where `heldSource` is already true (it's always
true on a source-column tile by definition — don't just disable it,
remove the menu item). Remove "Rename" (`:2483-2487`) — the tile name
is already directly click-to-rename
(`index.html:2660-2672`, confirmed identical on every tile already —
no new rename mechanism needed, just drop the redundant menu item).
Keep "Remove" (`:2507-2516`) — untouched for source tiles. Add
"Choose a different folder/file…" (see #6).

## 5. Context menu, destination tiles (`role === "dest"`)

Same two removals as #4 (own-role "Set as Destination", "Rename"),
**plus remove "Remove" entirely** for destination tiles specifically
— the user's explicit ask. This means a destination can only be
swapped via #6 going forward, never cleared to empty from this menu.
Add "Choose a different folder/file…" (see #6).

## 6. "Choose a different folder/file…" for non-volume tiles

Confirmed this only exists today for volume-root tiles (`isVolume`
branch's Browse… submenus, `:2412-2443`). A folder/file tile already
sitting in the Source or Dest column has no equivalent — add a menu
item (for both source and destination tiles) that opens the existing
folder-picker flow (`showFolderPicker`) and, on selection, replaces
the current path in place for that same role, no Remove step needed
first. **Don't duplicate this for FreeFrame project tiles** — they
already have "Choose/Change folder in project…" from §24a/§24c;
this item is specifically for plain folders/files/volumes sitting in
the Source/Dest columns.

## Verification

Set the same boot drive as Source (Downloads) and Destination
(Desktop) — confirm exactly one tile appears for it in the middle
column, striped blue/green border, no text badge. Repeat with an
external drive the same way — confirm it still works (shouldn't have
been broken, verify no regression). Confirm no tile anywhere shows a
"Source"/"Dest" text badge. Right-click a source-column folder tile —
"Set as Source" and "Rename" absent, "Remove" present, "Choose a
different folder/file…" present and works. Right-click a
destination-column folder tile — same minus "Remove," which must be
entirely absent. Right-click a FreeFrame project tile in either
column — its existing "Change folder…" action still works, untouched
by this change. In the log panel: remove one finished row via its X
— only that row disappears; a running job's row has no X. Click
"Clear" — all finished/failed/cancelled rows clear, a running job's
row survives. Confirm all of the above in both the docked panel and
the detached window.
