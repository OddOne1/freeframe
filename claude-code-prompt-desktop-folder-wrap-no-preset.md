# Claude Code prompt — desktop: wrap a folder source in its own name when no preset is active (§100)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §100 — read it first. Do not run `npm test` or any e2e
script other than `node scripts/test-copy.js` and
`node scripts/test-naming.js`.

## Current state (confirmed, don't re-investigate)

- `runLeg()` (`copy-engine.js:275-296`): `const destRel = mapRel ?
  mapRel(rel) : rel;` then `const destFiles = toRoots.map((d) =>
  path.join(d, destRel));`. `rel` is relative to the source folder
  itself (`listFilesRecursive`, `:140`), so with `mapRel` null the
  folder's own name never appears anywhere in the destination path.
- `mapRel` is built in `main.js`'s `copy:start` handler, only `if
  (naming)` (`:1389, 1396-1454`), via `buildRelMapper(...)`
  (`:1448`). When `naming` is null (no preset active), `mapRel` stays
  `null` for the entire job.
- Root-vs-cascade-leg gating already exists and must be preserved
  exactly: `copy-engine.js:673`, `mapRel: groupNodes[0].parentId ===
  null ? mapRel : null` — only the ROOT leg ever gets a mapper: a
  cascaded leg reads from a destination whose layout is already
  mapped, and mapping again would nest it inside itself and break the
  leg's byte-for-byte verification.
- `sourceFiles` (individually-picked files) is passed to `copy:start`
  separately from `sourcePath` — when present, there is no single
  source folder, so this fix does not apply there at all; leave that
  path completely untouched.
- `job-journal.js`'s per-file entries record whatever `runLeg` treats
  as the file's identity (`result.file`) — confirm this naturally
  picks up the new wrapped path once `mapRel` starts returning one, no
  separate change should be needed there, but verify with a real test
  rather than assuming.

## Build

1. In `main.js`, in the `if (naming) { ... } ` block's `else` path (or
   right after it, wherever `mapRel` is left `null` today, `:1389`
   onward): when `!naming` AND `sourcePath` is a non-empty string (the
   real-folder case, not `sourceFiles`), set `mapRel = (rel) =>
   path.join(path.basename(sourcePath), rel)`. This is a fixed
   one-level prefix — do NOT route it through `buildRelMapper` or any
   naming-template machinery, this isn't a template.
2. Confirm (don't just assume) that this fallback mapper flows through
   the SAME `groupNodes[0].parentId === null ? mapRel : null` gate at
   `copy-engine.js:673` that a real naming-template `mapRel` already
   does — it should, since it's the same variable, but trace it
   through and say so in the build report.
3. `sourceFiles`-only jobs (the `fileset://selected` sentinel case):
   confirm explicitly, with a test, that they remain completely flat
   and unwrapped — no change in behavior there.
4. A FreeFrame project as SOURCE (`projectSource`/a "download"-kind
   job, `sourcePath` is a `freeframe://<projectId>` URI): decide what
   `path.basename()` on that URI actually produces and whether it's a
   sane folder name (probably not — likely just the raw project id or
   a URI fragment). If it's not sane, find whatever the app already
   uses to LABEL such a job elsewhere (check `sourceLabel`
   construction in the same `copy:start` handler, or wherever the
   project's display name is already resolved for UI purposes) and use
   that instead. Do not ship a folder literally named `freeframe:` or
   a bare UUID without checking for a better name first. State your
   decision and what you found in the build report.
5. Confirm the journal correctly records the new wrapped relative path
   per file — run a job with no preset, inspect the journal file
   written under `LOG_DIR()` while/after it runs, confirm `file` entries
   include the wrapper folder segment.

## Verification

Copy a real folder (several files) with no naming preset active —
confirm the destination gets `<destRoot>/<sourceFolderName>/...`
containing every file, not a flat dump directly in `<destRoot>`. Set
up a cascade from that same no-preset copy to a second local
destination — confirm the cascade leg does NOT double-wrap
(`.../<sourceFolderName>/<sourceFolderName>/...` would be the bug).
Repeat the same folder copy WITH a naming preset active — confirm
destination structure is completely unchanged from before this fix,
governed entirely by the preset's own folder template. Pick
individual files (not a whole folder) with no preset — confirm they
still land flat, exactly as before. If a FreeFrame project is
reachable as a source in this environment, test that path too and
confirm the wrapper folder name is sane, not a raw UUID.
