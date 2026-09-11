# Claude Code prompt — desktop: project folder round 2 + window/layout fixes

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec: `CLAUDE.md` §24c and §25
(25a/25b/25c parts 1-2 only) — read both before starting.

## 1. (24c) Selecting a project's role folder doesn't activate that role

Found in real use, the same day §24a shipped (`23a7a06`). Compare the two
`roleSubmenu` call sites in `index.html`:

- Drive (`:2329-2330`): `apply` is `(f) => setSource(f)` /
  `(f) => addDest(f, null)` — picking a folder immediately assigns the
  drive to that role.
- Project (`:2261-2276`): `apply` is
  `(folder) => { setProjectFolder(projectId, roleKey, folder); render(); }`
  — this only remembers the folder. The project is never added to
  Sources/Destinations by picking a folder for it.

This is exactly what was reported: "I can select source and destination
folders now in the projects, but they are not being added to source or
destination if I do so... the only thing that happens is that the
information below is being changed."

**Fix:** make the project `apply` callback do both — call
`setProjectFolder(projectId, roleKey, folder)` **and**
`setSource(path)` (for the source role) / `addDest(path, null)` (for the
destination role), where `path` is the project's `freeframe://<id>`
mountPoint already in scope inside `openMenu`. This should match the
drive precedent exactly rather than leaving projects as a
menu-then-separately-drag two-step. Confirm the existing
same-project-both-sides conflict check (`showProjectConflict`) still
fires correctly once this path is exercised via the menu, not just via
drag — it's called from inside `setSource`/`addDest` already, so it
should compose for free, but verify rather than assume.

**Also fix `folderLabels`** (`:1526-1533`): it currently shows a role's
label (`from /path` or `to /path`) whenever a folder has ever been
configured for that role, even if the project isn't currently holding
that role. Change it to only show a role's label when the project is
actually assigned to that role right now — `sourcePath === mountPoint`
for the source label, `destNodes.some(n => n.path === mountPoint)` for
the destination label. A configured-but-unused folder selection
shouldn't read as if it's currently in effect; this is likely what made
the user think a Source-only folder selection was somehow being used as
a Destination target.

## 2. (25a) Window minimum size is smaller than the launch size

`main.js:201-206`:
```js
mainWindow = new BrowserWindow({
  width: 960, height: 640,
  minWidth: 720, minHeight: 480,
  ...
```
Change `minWidth`/`minHeight` to `960`/`640`, matching the launch size —
the window shouldn't be resizable below the size everything is actually
laid out for.

## 3. (25b) Header and column headers have no responsive wrap

Zero `@media` queries anywhere in `index.html`. `header` (`:39-43`) and
`.col-head` (`:192-195`) are both plain `display: flex` rows with no
`flex-wrap`. At the (soon-to-be-former) minimum width, the checksum/
queueing/naming-preset pills and the "Choose folder…" buttons overlap
and clip instead of reflowing — visible in the user's screenshot (a
"Choose fol…" button overlapping a path tooltip).

Add `flex-wrap: wrap` plus a sensible `row-gap` to both `header` and
`.col-head`, so controls stack onto a second line instead of clipping
when space runs out. This should matter less after #2's fix raises the
floor, but do both — a user could still shrink other panels (the fields
panel, the job panel) in ways that squeeze these rows.

## 4. (25c, parts 1-2 only) Rename "Fields" → "Naming Fields", hide when
   no preset is active

**Not in scope: an on/off toggle inside the panel (25c part 3) or the
"sideways window tab" restyle (25d) — both need a decision from the
user first, don't build either.**

1. Rename the label from "Fields" to "Naming Fields" in both places:
   the header reopen button (`:964`, currently `<button
   id="fields-show">Fields</button>`) and the panel's own heading
   (`:1004`, `<h2>Fields</h2>`).
2. The panel (`#fields-panel`, `:1002-1009`) and its reopen button
   (`#fields-show`) currently show unconditionally —
   `fieldsPanelHidden` (`:3663`) defaults to `false` with nothing tying
   it to whether a preset is active, so with no preset selected the
   panel just displays its own empty-state text ("No naming preset
   selected..."). Change this so the panel (and the reopen button) are
   hidden entirely — not shown-with-a-prompt — whenever `activePreset()`
   returns null. Read how `activePreset()` is already used elsewhere
   (e.g. in `missingRequired()`, `:3652-3658`) to match the existing
   pattern for checking it, rather than writing a new check.

## Verification

For #1: select a Source folder on a project via the menu, confirm it
appears in the Sources column without any additional drag. Confirm
picking a Destination folder on a *different* project works the same
way for Destinations. Confirm the tile's label only shows the role(s)
the project is actually currently assigned to. For #2: confirm the
window can no longer be resized below 960×640. For #3: shrink the
window to somewhere near the old 720px minimum (even though it's no
longer reachable via drag, resize programmatically or via devtools for
the test) and confirm header/column-header controls wrap instead of
overlapping. For #4: with no preset selected, confirm the Naming Fields
panel and its reopen button are both absent; select a preset and confirm
it appears.
