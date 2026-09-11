# Claude Code prompt — desktop: Volumes grouping, Delete-preset placement, filter relocate, quick preset toggle

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §62 (desktop) — read it first. Four small, independent
fixes on top of §61's new Settings window.

## Current state (confirmed, don't re-investigate)

1. `settings-window.js:93-150`, `renderHideList()` — one flat list,
   drives and projects interleaved, each tagged in place with a
   `kind` field ("drive"/"project"). Comment at `:93` confirms this
   was the deliberate original design.
2. Save preset: `settings.html:196`, `#preset-save`, `.primary`,
   static, always visible. Delete preset: `preset-editor.js:337-352`,
   only rendered `if (editingPreset.id)`, no color class, at the very
   bottom of the dynamic editor pane — not adjacent to Save.
3. "Keep the source's folder structure" control:
   `preset-editor.js:357-368`/`444-458`, inside `renderFilterBlock()`'s
   `<details class="filter-block">` — nested under "File filtering,"
   which it isn't really part of.
4. No per-preset enabled flag exists in `presets.js`'s store shape.
   Only mechanism to deactivate naming: `index.html:3879-3881`,
   picking "No naming preset" from the `#preset-btn` dropdown. Select
   handler: `index.html:3877`, `pick(id)` → `activePresetId = id`.

## Build

1. In `renderHideList()`, split the single list into two labeled
   groups — Drives, Projects — keeping identical per-row hide/show
   and orphan-tagging behavior, just grouped rendering.
2. Move Delete preset to sit immediately LEFT of Save preset (so
   they're adjacent, matching how `settings.html:196`'s toolbar row
   is structured) and style it with this app's danger/red CSS
   variables (check what other destructive actions in this app
   already use — e.g. delete-group/delete-drive confirmations —
   rather than a raw hardcoded color).
3. Move the "Keep the source's folder structure" control out of
   `renderFilterBlock()`'s `<details>` to a top-level position in the
   preset editor (above or beside the Filtering section, your call on
   exact placement, just not nested inside it anymore).
4. Add a one-click toggle for the currently active preset — reuse the
   existing `pick(id)`/`pick(null)` functions
   (`index.html:3877, 3879-3881`) as the underlying mechanism; the
   new part is a UI shortcut (e.g. a small toggle on the `#preset-btn`
   pill itself) that flips between "active preset" and "no preset"
   without requiring the dropdown menu to be reopened each time.

## Verification

Settings → Volumes: confirm two visually distinct groups (Drives,
Projects), hide/show and orphan tags unchanged per row. Preset
editor: Delete sits directly left of Save, red/destructive styling.
"Keep the source's folder structure" is visible without opening "File
filtering." Main window: toggle the active preset off and back on via
the new quick control — confirm it's equivalent to using the dropdown
menu's "No naming preset"/preset-name entries.
