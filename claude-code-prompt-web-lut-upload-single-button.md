# Claude Code prompt — LUT uploader: move into a popup dialog, keep both buttons

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §48-REVISED — read it first. This supersedes §48's
original "single button + menu" idea — don't build that, build this.

## Current state (confirmed, don't re-investigate)

`apps/web/app/(dashboard)/settings/luts/page.tsx:746-801` already has
everything functionally needed: a plain multi-file input (`fileRef`,
"Upload .cube" button) and a `webkitdirectory` input (`folderRef`,
"Upload folder" button), both sitting directly in the page's top
button row. The drop zone (`lut-drop-zone`, `:814+`) already handles
both loose `.cube` files and folders via `webkitGetAsEntry()`/
`readEntries()` and needs no change.

**Why two separate buttons, confirmed necessary, not a fallback**:
tested directly by the user against WeTransfer (which has this exact
same "Add files" / "Add folders" split) on both macOS and Windows.
macOS Chromium's `webkitdirectory` dialog happens to allow selecting
individual files too, but Windows's version genuinely blocks file
selection in folder mode and vice versa. So both buttons are required
for Windows users, not just a macOS nicety — keep both, don't try to
merge them into one control.

## Build

The only real change: **wrap the existing upload controls in a Radix
`Dialog`** instead of leaving them as page-level buttons, matching
the Project page's existing upload dialog pattern
(`apps/web/app/(dashboard)/projects/[id]/page.tsx:1269-1282` — same
`Dialog.Root`/`Dialog.Portal`/`Dialog.Overlay`/`Dialog.Content`
structure, same visual style, so the two uploaders feel identical to
a user).

- Replace the current always-visible "Upload .cube" / "Upload folder"
  button pair with a single "Upload" trigger that opens the dialog.
- Inside the dialog: the drop zone, plus the two existing buttons
  ("Add files" / "Add folder" — rename from "Upload .cube"/"Upload
  folder" to match this wording, consistent with the Project
  uploader once that's built) sitting together, same as WeTransfer's
  own layout (drop zone with two buttons underneath/beside it).
- Keep `fileRef`/`folderRef` and their existing `handleFiles`/
  `handleFolderInput` logic as-is — this is a layout/wrapping change,
  not new upload logic.
- Uploads still proceed the same way once files are selected
  (sequential per-file upload with progress, per existing §34/§42
  behavior) — the dialog can either stay open showing progress or
  close and show progress on the page itself, your call, just don't
  lose visibility into upload progress/errors.

## Verification

Click "Upload" — confirm a popup dialog opens (not inline buttons on
the page anymore). Inside it, drag a folder onto the drop zone —
confirm it still extracts `.cube` files correctly (§42 behavior
unchanged). Click "Add files" — confirm the plain multi-file `.cube`
picker opens. Click "Add folder" — confirm the folder picker opens
and extracts `.cube` files the same way as a folder drop. Confirm
closing the dialog and reopening it doesn't lose in-progress uploads
unexpectedly.
