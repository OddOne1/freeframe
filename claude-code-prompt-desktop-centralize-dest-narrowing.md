# Claude Code prompt — desktop: centralize destination narrowing inside addDest()

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §73 — read it first.

## Current state (confirmed, don't re-investigate)

- §69 (`42bc587`) fixed exactly one of nine `addDest()` call sites in
  `apps/desktop/src/renderer/index.html` — the `[data-choose="dest"]`
  header button, now at `:2941-2982`.
- Confirmed still-broken via a fresh screen recording, on a build the
  user verified was actually running (`git log -1` = `d9a3198`): the
  tile context-menu's "Destination Folder ▸" submenu, built by
  `roleSubmenu()` (`:2197-2211`), destination call site at `:2296`.
  Both its "Browse…" entry and every "Recent Folders" entry call
  `apply(f)` → `addDest(f, null)` directly, with zero narrowing.
- `grep -n "addDest(" index.html` — nine call sites: `:1620` (the
  definition), `:1683` (`cascadeFrom`, legitimately unguarded —
  cascade children never narrow), `:1828` (`assignProjectRole`, adds a
  `freeframe://projectId` URI — leave alone, no device concept
  applies), `:2103` (drag a tile onto the Destination zone), `:2185`
  ("Set as Destination" context-menu entry), `:2296` (the confirmed
  bug site), `:2312` ("Also use as Destination…"), `:2941-2982` (the
  §69 fix — already correct), `:3668` (OS drag-and-drop onto the
  Destination zone).
- The correct narrowing logic already exists, written twice: the
  pre-existing "Choose a different folder/file…" context-menu handler,
  and §69's header-button fix at `:2956-2980`. Both use `deviceFor(p)`
  to find an existing `parentId === null` destination node on the same
  device, then `addDest()` the new path before `removeDest()`-ing the
  old one.

## Build

1. In `addDest(p, parentId = null)` (`index.html:1620-1638`), after
   the existing `destNodes.some((n) => n.path === p)` exact-match
   guard and the project/cascade-parent guards, and BEFORE
   `destNodes.push(...)`: if `parentId === null`, compute
   `deviceFor(p)` and look for an existing node with
   `n.parentId === null && deviceFor(n.path) === dev`. Push the new
   node, then if a match was found and its path differs from `p`,
   `removeDest()` it — same add-before-remove ordering §69 already
   established, so a failure mid-way leaves the destination populated
   rather than empty. Skip this whole check when `parentId` is set —
   a cascaded child copies FROM another destination and must not be
   treated as narrowing the device it happens to share.
2. Simplify the header button's `[data-choose="dest"]` handler
   (`:2941-2982`) back down to a plain `addDest(folder, null)` call —
   its own copy of the narrowing logic is now redundant now that
   `addDest()` does it, and leaving both risks them drifting apart
   later. Keep the `rememberRecent()` call above it; that's unrelated.
3. Do not touch `:1683` or `:1828` — see "Current state" above for why
   each is a legitimate exception.

## Verification

Reproduce the exact sequence from the screen recording: drag a whole
drive into Destination (e.g. `ODDONE_01` root), then right-click that
same tile → "Destination Folder ▸" → click a "Recent Folders" entry
for a subfolder on that same drive (e.g. `01_Projects/ReShuffle`) —
confirm the ORIGINAL tile narrows to the subfolder rather than a
second tile appearing, and "Copy & Verify" does not show a "→ 2" leg
count. Repeat via "Browse…" instead of a recent folder, same result.
Repeat via "Set as Destination" (`:2185`) on a tile that's a subfolder
of an already-present destination drive. Repeat via dragging a tile
straight onto the Destination zone (`:2103`) and via an OS
drag-and-drop of a Finder folder onto the Destination zone (`:3668`).
Confirm a genuinely different drive is still added as a second,
parallel destination in all of the above (the negative case — this
must not collapse two real destinations into one). Confirm cascading
(dropping a destination onto another destination to chain them) still
works unchanged — cascade children must never trigger narrowing.
Confirm the pre-existing "Choose a different folder/file…" path and
the §69 header-button path both still narrow correctly after the
simplification in step 2.
