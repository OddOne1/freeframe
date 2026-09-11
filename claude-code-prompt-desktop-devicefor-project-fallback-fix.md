# Claude Code prompt — desktop: deviceFor() must not resolve a FreeFrame project to the internal volume

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §93 — read it first. Renderer-only. Do not run `npm test`
or any e2e script other than `node scripts/test-cascade.js` if it
already exercises `deviceFor`/`narrowingTarget`-shaped logic — extend it
rather than adding a new script, since this is the same family of bug
§89 just fixed (a shared helper's fallback leaking into a call site that
never wanted it).

## Current state (confirmed, don't re-investigate)

- `deviceFor(p)` (`index.html:2141-2155`): for any `p` that doesn't
  match a real mounted volume's mount point, falls through to
  `return best || internal;` — returning the INTERNAL volume's mount
  point. Deliberate for a genuinely local folder with no resolvable
  parent (its own comment: "a folder with no resolvable parent keeps its
  own tile rather than vanishing"). Not deliberate for a
  `freeframe://<id>` URI, which isn't a filesystem path and has no
  device at all.
- `narrowingTarget()` (`:1738-1746`) already knows this and guards
  against it: `if (isProject(p)) return null;` before ever calling
  `deviceFor(p)`, with a comment explaining exactly why.
- `roleFor(mountPoint)` (`:1519-1529`) does NOT guard: `owns(sourcePath)`
  calls `deviceFor(sourcePath) === mountPoint` directly. Assigning a
  FreeFrame project as Source or a Destination makes `deviceFor` resolve
  it to the internal volume, so `owns()` — and therefore `roleClass()`,
  which tints/outlines a Volumes tile as Source/Destination/both — falsely
  reports the INTERNAL DRIVE as holding that role. Confirmed by the user
  visually: assigning a project shows a dashed highlight around
  Macintosh HD with no real relationship to the project.
- Other `deviceFor()` call sites to audit, don't assume any of them are
  fine without checking: `:1492` (volumesColumnEntries' picked-folder
  filter), `:1746, 1763` (narrowingTarget itself, already guarded one
  level up by its own `isProject` check before reaching these), `:1930`
  (rememberRecent), `:2353`'s comment (a different function nearby,
  confirm it's not affected), `:3314, 4183` (drag/drop recent-folder
  remembering).

## Build

1. Fix `deviceFor()` at the source: return `null` immediately for
   `isProject(p)`, before the loop that would otherwise fall through to
   the internal-volume default. This makes every caller correct by
   construction rather than needing its own guard — matching the
   principle §89 already established for `narrowingTarget`/`addDest`
   call sites (one shared rule beats N separate guards that can each be
   forgotten).
2. Audit every other `deviceFor()` call site listed above. For each,
   confirm behavior is either unaffected (the caller already guards
   `isProject` itself, e.g. `narrowingTarget`) or now CORRECTLY returns
   null/no-match for a project where it previously silently matched the
   internal volume. List each site and its classification in the build
   report, the same way §89's report classified every `addDest` call
   site — don't skip this audit, it's exactly how §89's bug from an
   earlier "obviously safe" fix reached a third occurrence.
3. Since `narrowingTarget()`'s own `if (isProject(p)) return null;`
   guard becomes redundant once `deviceFor` itself is fixed, decide
   whether to remove it (now dead but harmless) or leave it as
   defense-in-depth with an updated comment noting the fix now lives one
   level down. Prefer leaving it with an updated comment — removing a
   working guard on the strength of "the function underneath should
   handle it now" is exactly the kind of confidence that produced §89's
   bug in the first place.

## Verification

Assign a FreeFrame project as the current Source (or a Destination) with
at least one real local drive also visible in the Volumes column.
Confirm the real drive (Macintosh HD or whichever is the internal
volume) shows NO source/destination tint or outline purely from the
project being assigned — only tiles genuinely holding that role, or
containing a folder that genuinely resolves to them, should be tinted.
Confirm a real local folder with a genuinely unresolvable parent (the
original case the internal-volume fallback exists for) still correctly
falls back to being treated as living on the internal volume — this
fix must narrow the fallback to exclude projects specifically, not
remove the fallback altogether. Re-run `narrowingTarget`'s existing
project-exclusion tests (§73/§89's suite) and confirm they still pass
unchanged.
