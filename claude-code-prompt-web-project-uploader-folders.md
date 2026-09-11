# Claude Code prompt — Project uploader: folder support + sidecar extraction

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §49 — read it first, and note it now cross-references
§48-REVISED for the click-to-browse UI shape (two explicit buttons,
"Add files" / "Add folder", not a single button + menu — that design
was superseded after testing showed Windows genuinely requires the
split). Larger than most prompts in this batch — real backend work
(folder creation on upload), not just UI.

## Current state (confirmed, don't re-investigate)

Root cause of "drop a folder → upload just stops" — confirmed by
reading the code, not guessed:

- `apps/web/components/upload/upload-zone.tsx:44-49`'s `handleDrop`
  reads `e.dataTransfer.files` directly, never `dataTransfer.items`
  or `webkitGetAsEntry()`. A dropped folder flattens to nothing
  usable per the DOM DnD spec — nested images never become `File`
  objects.
- `isMediaFile()` (`apps/web/stores/upload-store.ts:323-337`) allows
  `file.type === ''` through, which is what a phantom
  directory-as-File entry looks like — it reaches
  `startUpload`/`runChunkedUpload` and fails immediately on a
  0-byte/unreadable blob. That's the "auto stops" the user is
  seeing.
- The LUT settings page already has a correct recursive folder-walk:
  `readEntry()`/paginated `readEntries()` loop,
  `apps/web/app/(dashboard)/settings/luts/page.tsx:68-88` (driven
  from `dataTransfer.items` + `webkitGetAsEntry()`, `:340-358`). It's
  local to that file — extract it, don't duplicate it.
- Sidecar matching already exists and works on whatever flat
  `File[]` batch makes it through: `isSidecarFile()`/`isCameraJunkFile()`
  (`upload-store.ts:243-291`), `uploadSidecars()` →
  `POST /projects/{id}/sidecars/match` (`upload-store.ts:299-321`),
  called from the project page's `handleStartUpload`. Fixing the
  walk fixes sidecar-inside-folder matching automatically — no new
  matching logic needed.
- Backend sidecar parsers already exist:
  `apps/api/services/sidecar_parsers.py` (CDL, ALE, per-brand XML,
  DJI `.SRT`, AVCHD `.CPI`, Nikon `.NKSC`, RED `.RMD`, Sony `.BIM`,
  Canon `.CIF`). Don't touch these — the gap is purely upstream
  (files never reaching the browser's `File[]`), not parsing.
- `Asset` model (`apps/api/models/asset.py:33-66`) has only
  `folder_id` — no relative-path field. Project page has a standing
  comment (`apps/web/app/(dashboard)/projects/[id]/page.tsx:557-558`)
  admitting `startUpload` doesn't accept a `folderId` yet — this
  prompt is what finally wires that up.
- Accepted file types: `upload-zone.tsx:77` (`accept` attr) +
  `isMediaFile()`'s extension regex (`upload-store.ts:323-337`) —
  don't change the allowed-type list, just make sure files found
  inside a folder pass through the same checks as files dropped
  loose.

## Build

1. **Extract the shared recursive walk.** New file, e.g.
   `apps/web/lib/read-dropped-entries.ts`. Move `readEntry`'s logic
   out of the LUT page. Signature needs to return relative path too
   (the LUT version didn't need it): something like
   `{ file: File; relativePath: string }[]`, where `relativePath` is
   the path components from the dropped root folder down to the
   file (empty/just filename for loose files). Re-point the LUT
   page's existing folder handling at this shared function so
   there's one implementation.
2. **`upload-zone.tsx`'s `handleDrop`**: prefer
   `dataTransfer.items` (needed to see folders at all) with the
   shared walk; keep a fallback to `dataTransfer.files` for browsers/paths
   where `items` isn't populated.
3. **Filter during the walk** using the existing
   `isMediaFile()`/`isSidecarFile()` checks — silently drop anything
   that matches neither (camera junk, `.ds_store`, etc.), same as
   §23's existing camera-card handling. Don't error on non-matching
   files being present.
4. **Folder-structure prompt**: if the walk found at least one
   directory (not just loose files), ask once per drop/selection
   batch — keep folder structure vs. flatten. Flatten = today's
   behavior unchanged (everything to project root). Keep structure:
   - Check `apps/api/models/folder.py` for existing nesting support
     before adding anything — this app's folder model may already
     support parent/child; use what's there.
   - For each unique directory path encountered in the walk, ensure
     a matching `Folder` row exists (create if missing, matching
     nesting), then resolve each file's target `folder_id` from its
     `relativePath`.
   - Wire `folder_id` into the existing upload flow — `startUpload`
     currently has no path for this per the standing comment at
     `page.tsx:557-558`; add the parameter and thread it through to
     wherever the asset row is actually created.
5. **Click-to-browse**: the Project uploader already sits inside a
   popup dialog (`page.tsx:1269-1282`, `Dialog.Root` with
   `open={uploadOpen}`) — no new dialog needed here, unlike the LUT
   page. Inside that existing dialog, add a second explicit button
   next to `UploadZone`'s current "Upload" button: "Add files" (today's
   plain `<input type="file" multiple>`, `upload-zone.tsx:69-80`,
   unchanged) and a new "Add folder" button driving a second hidden
   `<input type="file" webkitdirectory multiple>`, walked through the
   same shared `read-dropped-entries.ts` util as the drop zone. Two
   buttons, confirmed necessary for Windows — see §48-REVISED for why
   (WeTransfer itself needs the same split; macOS's hybrid
   file-or-folder dialog doesn't work the same way on Windows).

## Verification

Drop a folder with 5 images, 2 sidecar files (`.xml`, `.srt`), and 3
junk files (`.ds_store`, `thumbs.db`, a random `.txt`) — confirm
exactly 5 uploads, both sidecars match via the existing pipeline, 3
junk files are silently ignored (not queued, no error). Confirm the
structure-prompt appears once for the whole batch. Accept "keep
structure" — confirm matching `Folder` row(s) exist and the 5 assets
land inside them. Repeat and choose "flatten" — confirm all 5 land at
project root as before this change. Confirm a plain loose-file drop
(no folder involved) is completely unaffected. Confirm click-to-browse
"Folder" option behaves identically to a folder drag-drop.
