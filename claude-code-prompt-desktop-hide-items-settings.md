# Claude Code prompt — desktop: hide drives/projects via Settings

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §60a (desktop) — read it first. Builds on §58's Settings
screen (`apps/desktop/src/main/settings.js`) — extend it, don't
rebuild it.

## Current state (confirmed, don't re-investigate)

- `VolumeInfo` (`apps/desktop/src/main/volumes.js`, JSDoc `:17-24`):
  `name`, `mountPoint`, `deviceId` (unstable across reboots/replugs,
  empty for network volumes) — no fully stable per-drive ID exists.
  Matching on `name` is the best available option; two drives sharing
  a name will hide together. FreeFrame projects have a real stable
  `id` — use that for projects, not name.
- `volumesColumnEntries()` (`index.html:1644-1650`) already has
  filtering logic (excludes sub-folder tiles whose device resolves to
  a real volume) — add the hide filter alongside it, same function.
- §58's `settings.js` already establishes the `settings.json` pattern
  and its own file (not folded into `naming-presets.json` or the
  cache files) — follow that exact pattern for these new fields.

## Build

1. Add `hiddenVolumeNames: string[]` and `hiddenProjectIds: string[]`
   to `settings.json`'s schema (`settings.js`).
2. Settings screen (from §58) gets a new section: every currently
   visible drive/project with a hide toggle, PLUS a separate "Hidden
   items" list (drives by name, projects by name+id) with an unhide
   action — hiding must not be a one-way door with no path back.
3. Apply the filter inside `volumesColumnEntries()`
   (`index.html:1644-1650`) — a hidden drive/project simply doesn't
   appear in the middle column.
4. **A currently-assigned Source or Destination tile must NOT be
   hidden even if its underlying drive/project is on the hidden
   list** — hiding is about decluttering the browse view, not about
   breaking an in-progress or configured job. The Source/Dest column
   tiles are unaffected by this feature entirely; only the middle
   Volumes column filters.

## Verification

Hide a drive by name in Settings — it disappears from the middle
column immediately; unhide it from the "Hidden items" list — it
reappears. Hide a FreeFrame project by id — same. Set a drive as
Source, then hide it from Settings — confirm its tile in the Source
column is still there and still functions normally; only its
would-be entry in the middle Volumes column is gone.
