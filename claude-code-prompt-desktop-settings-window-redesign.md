# Claude Code prompt — desktop: Settings as a real window, tabs, themed dropdown, no redundant list

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §61 (desktop) — read it first. This substantially reworks
what §58/§60a just built — expect real deletions, not just additions.

## Current state (confirmed, don't re-investigate)

- Settings is currently a plain in-page modal (`#settings-backdrop`,
  `index.html:1260-1306`), same pattern as every other modal in this
  file (rename dialog, preset editor). No `BrowserWindow` involved.
- **Precedent for a real second window already exists**: the
  detached job panel. `apps/desktop/src/renderer/panel.html` is a
  genuinely separate HTML file (not `index.html` reused), created via
  a dedicated `BrowserWindow` block in `main.js:896-933`
  (`ipcMain.handle("panel:detach", …)`) — same `preload.js`,
  singleton pattern (focuses the existing window instead of
  duplicating). Follow this exact precedent for the new Settings
  window.
- `renderHideLists()` (`index.html:4484-4555`) genuinely duplicates
  every hidden-but-connected item across two lists — confirmed by
  reading it, not assumed. Only `orphans` (`:4535-4542`,
  disconnected-but-hidden items) is unique content.
- The only existing custom-styled dropdown in this app is the
  toolbar's `#algo-menu`/`.algo-opt` (`:118-144` CSS, `:1491-1521`
  JS) — per-option name + description + checkmark. The Settings
  `<select>` (`:1264-1271`) has zero theming (`.settings-modal select { width: 100%; }`
  is the only rule touching it, CSS `:783`).
- Naming preset editor is a fully separate modal today
  (`#preset-backdrop`, `:1192-1216`, triggered by header `#preset-btn`),
  built by `renderPresetPane()` (`:3511-3701`) — one flat vertical
  list: name field, bare "Fields" text label (not a real section),
  field rows, folder/file pattern rows with hint text and token
  chips, live preview, next-card-# counter, then the one already-
  grouped piece (a `<details>` filtering block, `:3683`), then
  Delete.

## Build

1. **New `settings.html`** mirroring `panel.html`'s structure, plus a
   matching `BrowserWindow` constructor block in `main.js` (same
   `preload.js`, `contextIsolation: true`, singleton focus-not-
   duplicate behavior like `panel:detach`'s handler). Resizable,
   moveable, independent from the main window.
2. **Tab structure inside the new window** (first-pass grouping,
   reorganize if a cleaner split emerges while building):
   - **General**: default checksum algorithm, themed dropdown.
   - **Volumes**: the single show/hide list.
   - **Naming Presets**: the relocated, restructured preset editor.
   - **About**: logs folder button + version/about text (unchanged
     content, just relocated).
3. **Delete the old modal entirely** once content is migrated:
   `#settings-backdrop` markup (`:1260-1306`), `openSettings`/
   `closeSettings`/backdrop-click/Escape wiring
   (`initStep("settings", …)`, `:4438-4591`), and the header
   `#settings-btn`'s click handler repointed to open the new
   `BrowserWindow` instead of toggling the old modal.
4. **Single hide/show list**: merge `orphans` into the main list with
   a "not connected" tag/badge on those rows, instead of rendering
   them a second time in a separate "Hidden items" section. Delete
   the second render pass and its markup (`#settings-hidden-wrap`,
   `:1281-1289`).
5. **Themed checksum dropdown**: port `#algo-menu`'s visual pattern
   (name + description + checkmark, custom-positioned panel) into
   the new Settings window's General tab. Then **delete the toolbar
   picker entirely**: `#algo-btn` (`:1022-1025`), `#algo-menu` mount
   (`:1320`), its CSS (`:118-144`), `renderAlgoMenu`/`openAlgoMenu`/
   `closeAlgoMenu`/`algoLabel` (`:1486-1537`), the click-outside guard
   (`:2727-2728`), and its wiring (`:4413-4418`) — keeping only
   whatever reads the Settings-stored default at job-start time.
   **This removes per-job checksum override** — every job uses the
   Settings default from now on. State this plainly in the build
   report as a real behavior change, not a silent side effect.
6. **Move naming presets into the Settings window's own tab**: relocate
   `#preset-backdrop`'s content (`:1192-1216`) and `renderPresetPane()`'s
   logic (`:3511-3701`) into the Naming Presets tab. Delete the old
   modal and the header's `#preset-btn` trigger.
7. **Restructure the preset editor into visually distinct sections**
   — group into something like "Preset name," "Fields," "Naming
   pattern" (folder + file templates together), "Filtering" (already
   has its `<details>` treatment, extend the same visual language to
   the other groups — cards, or consistent collapsible sections, your
   call on the exact mechanism, just not one continuous flat list
   anymore). This is explicitly a first design pass — say so in the
   build report.

## Verification

Open Settings from the header — confirm a real separate window opens
(own title bar, independently movable/resizable from the main
window, can sit beside it). Confirm exactly one show/hide list, with
a disconnected-but-hidden drive tagged "not connected" inside it
rather than appearing in a second list. Confirm the checksum dropdown
in General is themed (dark, matches app style) not a native white
select, and behaves like the old `#algo-menu` (name + description per
option). Confirm there's no checksum picker anywhere in the main
toolbar anymore, and starting a job uses whatever Settings has set.
Confirm the Naming Presets tab inside Settings has the preset
list+editor, and the old standalone preset modal/header button are
gone. Confirm the preset editor now reads as grouped sections rather
than one long list.
