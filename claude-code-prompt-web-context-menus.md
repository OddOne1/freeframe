# Claude Code prompt — web: right-click context menus

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §28 — read it first.

**Read the existing code before building anything** — most of the
actions this needs already exist, this is largely about reaching them
via right-click rather than inventing new functionality. Confirm what's
already there rather than assuming from the spec text alone.

## Already done, verify and leave alone

`apps/web/components/projects/folder-tree.tsx:112-115` already wires
`onContextMenu` to open the same Rename/New Subfolder/Delete menu the
kebab button opens. Don't touch this file's context-menu behavior —
just confirm it's still correct as a reference pattern for the new work
below.

## 1. Single-asset right-click

`apps/web/components/projects/asset-card.tsx:194-252` has a Radix
`DropdownMenu` with Share, Download, Link, Rename, Delete — currently
only reachable via the kebab button. Add `onContextMenu` on the card
that opens this same menu content, positioned at the cursor. Check how
Radix's `DropdownMenu` supports a controlled/virtual trigger position
(don't invent a manual positioning system if Radix already has a
supported way to do this) — search this codebase for any other place
that already opens a Radix menu at a cursor position before assuming
none exists.

## 2. Selection-aware right-click

`apps/web/components/projects/asset-grid.tsx` already tracks
`selectedAssetIds`/`toggleAssetSelect`. Right-click behavior:
- If the right-clicked asset is already part of the current
  multi-selection, the menu should act on the whole selection.
- If it's not part of the current selection, right-clicking it should
  select just that asset first (replacing any prior selection), then
  open the single-asset menu for it — this is standard desktop-app
  behavior, don't skip it even though it's a small detail.

## 3. Bulk-action menu for a multi-selection (the actual new work here)

Today, selecting multiple assets does nothing except let you drag them
together into a folder (`asset-grid.tsx:385-393`) — there is no bulk
delete or bulk download UI anywhere. Build a menu variant for 2+
selected assets:
- **Share**: already works — `openShareDialog(assetIds, folderIds)`
  (`page.tsx:446`) already accepts an array. Just call it with the
  current selection.
- **Delete**: check whether a batch-delete API endpoint already exists
  before building one — search `apps/api/routers` for anything
  operating on a list of asset ids before assuming per-item looping
  (calling the existing single-delete path once per selected asset) is
  the only option. If no batch endpoint exists, per-item looping behind
  a single confirmation dialog is an acceptable fallback, but say
  explicitly in your report which you chose and why.
- **Download**: same check — look for an existing zip/batch-download
  mechanism before assuming one needs to be built from scratch. If
  nothing exists, this may need to be scoped separately rather than
  invented on the spot — report back rather than guessing at a new
  server-side zip-streaming endpoint's design.
- **Move to folder**: drag already covers this. Decide whether a menu
  item is also warranted for discoverability (e.g. someone who doesn't
  know drag works) — your call, note the reasoning either way.

## 4. Empty-canvas right-click

Right-clicking empty space in the asset grid (not on any card) should
offer "New Folder" — reuse the exact dialog/handler the main toolbar
button already uses (`page.tsx:1151-1162`, `setFolderDialogParentId`/
`setFolderDialogOpen`), gated on the same `canCreateFolder` check.
Consider whether "Upload" belongs here too, matching the toolbar's
`canUpload`-gated button — your call, but if you skip it, say why.

## 5. Permissions — do not skip this

Every action reachable via a right-click menu must respect the exact
same permission gate the equivalent existing button already checks
(`canCreateFolder`, `canShare`, `canUpload`, and whatever gates
rename/delete today — find these, don't assume). A right-click menu
that offers Delete to someone who can't already delete via the kebab
button is a real permissions bug, not a cosmetic one.

## Verification

Right-click a single asset and confirm the menu matches the kebab
button's menu exactly. Select 3 assets, right-click one of them, and
confirm the bulk menu appears and acts on all 3 (not just the
right-clicked one). Right-click an asset outside the current selection
and confirm it replaces the selection rather than adding to it or acting
on the stale selection. Right-click empty canvas space and confirm New
Folder creates in the currently-viewed folder, matching what the
toolbar button already does. Test as a role that lacks
`canCreateFolder`/`canShare`/`canUpload` and confirm the right-click
menus omit exactly the same actions the existing buttons already hide
for that role.
