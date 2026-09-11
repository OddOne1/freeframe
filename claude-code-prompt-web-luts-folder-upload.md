# Claude Code prompt — LUT folder upload + raised size limit

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §42 — read it first. **Build after
`claude-code-prompt-web-luts-duplicate-detection.md`** if doing both,
so a folder full of duplicate `.cube` files gets caught rather than
silently bulk-uploaded.

## 1. Raise the size limit

Current: 8MB, server-only, `apps/api/routers/luts.py:42-43`
(`MAX_CUBE_BYTES`), checked at `:184-185`. Raise to 1GB
(`1 * 1024 * 1024 * 1024`). **Also add a client-side pre-check** —
currently missing entirely (`page.tsx`'s `handleFiles` uploads first,
only learns the limit from a 400 response) — reject oversized files
before attempting the upload, same per-file error reporting pattern
§34 already established.

## 2. Folder upload

The upload input/drop-zone needs to accept a folder, not just
individual files:
- Drag-and-drop a folder (use `DataTransferItem.webkitGetAsEntry()` to
  detect and walk a dropped directory).
- Click-to-browse fallback: a folder-picker input (`webkitdirectory`
  attribute) alongside the existing file picker, or a way to trigger
  folder mode from the existing "Upload .cube" button (your call on
  the exact UI — a dropdown/split-button choosing "Files" vs "Folder,"
  or just making the drop-zone smart enough to handle both file and
  folder drops without a separate button).
- Walk the folder recursively, extract every `.cube` file found
  (case-insensitive extension match), silently ignore everything else
  — same spirit as this app's existing camera-card junk-file handling
  (§23), don't error on non-.cube files being present.
- Upload each extracted `.cube` through the existing per-file path
  (§34's sequential upload, respecting duplicate detection if that's
  been built, and the new 1GB limit).

## 3. Prompt to create a group from the folder name

After the folder's `.cube` files are identified (before or after
upload completes — your call, just don't make it a blocking modal that
stalls the whole upload), ask the user whether to create a new group
named after the folder and file every successfully-uploaded LUT from
it into that group. A simple confirm — accept creates the group and
assigns it, decline leaves everything ungrouped (today's default
behavior for individual uploads, unchanged).

## Verification

Drag a folder containing 3 `.cube` files and 2 non-`.cube` files onto
the upload area — confirm exactly 3 uploads happen, the 2 others are
silently ignored, and the group-creation prompt appears once for the
batch (not once per file). Accept the prompt, confirm a new group named
after the folder exists with all 3 LUTs in it. Repeat and decline —
confirm the 3 LUTs land ungrouped. Confirm a >8MB but <1GB `.cube` now
uploads successfully (proving the raised limit), and something >1GB is
rejected client-side before an upload attempt is even made.
