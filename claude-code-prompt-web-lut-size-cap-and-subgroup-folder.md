# Claude Code prompt — Raise LUT size cap to 129 + subgroup-aware folder upload

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §52 — read it first. Two bugs found in the user's first
real test of the LUT folder upload (§42/§48-REVISED/§45 combined).

## Current state (confirmed, don't re-investigate)

- `MAX_LUT_SIZE = 64` at `apps/api/routers/luts.py:47`, and a
  matching `MAX_SIZE = 64` at `apps/web/lib/lut/cube-parser.ts:30`
  (comment there already says it must track the backend value).
  Both reject real 65-point `.cube` files, which are an ordinary,
  common export size from camera manufacturers — not malformed data.
  The user hit this uploading three genuine Leica/Sony LUTs.
- The folder-to-group prompt (`page.tsx:315-317`, `:337-341`,
  `createGroupFromFolder` at `:344-358`) only ever uses the
  top-level dropped folder name — `d.path[0]` — and discards any
  subfolder names. §45 already built one-level LUT sub-groups
  (`parent_group_id` on `LutGroup`, validated one-level-only via
  `_validate_parent`, `apps/api/routers/luts.py:239`) — the folder
  upload prompt should use that when the dropped folder has
  subfolders, instead of flattening everything into one group.

## Build

1. **Raise the cap to 129** in both `luts.py:47` and
   `cube-parser.ts:30` — update the error message text and code
   comments (both currently say "64"). Search both files fully for
   any other place referencing the old limit (don't assume these are
   the only two spots — check `_content_hash`'s canonicalization and
   wherever the WebGL 3D texture actually gets allocated for LUT
   preview, e.g. in `apps/web/components/review/lut-picker.tsx`).
   129³ (~2.1M RGB triples) is well inside WebGL2's guaranteed
   minimum `MAX_3D_TEXTURE_SIZE` of 256 and inside the existing 1GB
   file-size cap, so no other limit needs to move.
2. **Preserve subfolder structure in the folder-upload walk.**
   `readDroppedEntries` (`apps/web/lib/read-dropped-entries.ts`)
   already returns a path per file — read its exact return shape
   before assuming the index. When files come from `root/subfolder/file.cube`
   (one level of subfolder under the dropped root), treat `root` as
   the prospective group name and each distinct immediate subfolder
   name as a subgroup name. Files sitting directly in `root/file.cube`
   (no subfolder) belong to the root group with no subgroup. If a
   file's path goes deeper than one subfolder level, fold it into
   its immediate parent subfolder's group — LUT groups only support
   one level of nesting (§45), so don't try to represent a third
   level; state in the build report that deeper structure gets
   flattened at the first subfolder level, not silently dropped from
   the report.
3. **`createGroupFromFolder`**: create the root group first, then one
   subgroup per distinct subfolder name found, each with
   `parent_group_id` set to the root group's id (same endpoint the
   manual "New group" UI already uses for subgroups — reuse it, don't
   build a second path). Then PATCH each LUT's `group_id` to whichever
   group it actually belongs in (root or its subgroup), not all of
   them to the root as today.
4. **Update the prompt banner's copy** (`page.tsx:867-882`) to name
   the subgroups when present, e.g. "Put 12 LUTs from "Leica Looks"
   into a group of that name, with 3 subgroups (Rec2020, Cine,
   SLog3)?" — don't leave the copy describing flat behavior when the
   upload actually created subgroups.

## Verification

Upload a folder with 2 loose LUTs at its root and two subfolders
(each with 2+ LUTs) — confirm the prompt names all three group
levels correctly, accepting it creates the root group and both
subgroups nested one level under it, with every LUT filed correctly.
Upload a flat folder (no subfolders) — confirm this is unchanged,
one flat group, no subgroup created. Upload one of the three
originally-rejected 65-point `.cube` files — confirm it now succeeds
and previews correctly (actually load it in the LUT preview, don't
just check the upload response). Upload a deliberately malformed file
claiming `LUT_3D_SIZE 9999` — confirm it's still rejected, at the new
129 ceiling.
