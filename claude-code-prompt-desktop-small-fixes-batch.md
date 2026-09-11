# Claude Code prompt — desktop: remove cosmetic rename, fix Settings/Volumes list height

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §65b — read it first. Two small, independent fixes,
unrelated to the naming-fields work in the other two prompts from this
batch.

## Current state (confirmed, don't re-investigate)

- Cosmetic rename: `index.html:2269-2289` (`setDisplayName`,
  `openRename`), `:2406` (tile title `"Click to rename (label only)"`),
  `#rename-backdrop` modal markup (`:953-960`), wiring at `:3801-3812`.
  Backend: `preload.js:160-164`, writes to an app-local `display-names`
  store only — confirmed it never touches `diskutil` or any real disk
  label, comment there says so explicitly ("Never renames anything on
  disk").
- Settings → Volumes hide-list panel clips after ~4 rows regardless of
  content — fixed short `max-height` somewhere in `settings.html`'s
  CSS or the hide-list container markup in `settings-window.js`.

## Build

1. **Remove the cosmetic rename affordance entirely** from the Volumes
   column — for every tile, not just the internal/boot volume. Delete:
   the click-to-rename tile title/handler, `#rename-backdrop` and its
   modal, `openRename`/`closeRename`/`setDisplayName` wiring at the
   listed line numbers, and the `#rename-*` CSS. **Do not delete the
   underlying `display-names` store/IPC handlers** (`getDisplayNames`,
   `setDisplayName` in `preload.js`) if anything else reads display
   names (e.g. tile rendering falling back to a stored label) —
   check before removing the backend, only remove the UI entry point
   unless you confirm nothing else depends on being able to set one.
   Note in the build report: this removes the only way to disambiguate
   two drives sharing an identical name in the Settings hide-list (its
   own copy says "Drives are remembered by name, so two drives sharing
   a name hide together") — confirmed accepted trade-off, not an
   oversight, don't try to compensate for it in this prompt.
2. **Fix the Settings → Volumes hide-list panel height** — give it the
   Settings window's available height instead of a fixed short
   max-height, so it doesn't clip/scroll prematurely with few items.

## Verification

Volumes column: confirm no tile shows a rename affordance or cursor
change on click, and clicking a tile's name does nothing (or does
whatever the non-rename click behavior should be — check what else, if
anything, currently triggers on that click before removing just the
rename part). Confirm `#rename-backdrop` no longer exists/opens from
anywhere. Settings → Volumes: confirm the Drives/Projects list fills
available vertical space and doesn't clip prematurely with only a
handful of items.
