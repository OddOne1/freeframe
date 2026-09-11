# Claude Code prompt — desktop: reject {counter} in folder patterns

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §65c — read it first. Small, focused, independent of
anything else in the §65 batch.

## Current state (confirmed, don't re-investigate)

- `naming.js:291-293`'s comment already documents that a folder pattern
  containing `{counter}` "deliberately creates a folder per file" — this
  is real, existing, pre-§65 behavior, not something to build fresh.
- The editor's chip list never offers `{counter}` on the folder-pattern
  field (only on file-name, §22c) — but nothing stops someone from
  hand-typing it into the folder box, and nothing currently rejects that
  at save time or job-start time.
- `naming.js:220` (`unknownTokens`) is the existing pre-flight validation
  pattern — a template referencing a token nothing can fill is checked
  BEFORE a job starts (`main.js:878`). Follow this same shape for the
  new check rather than inventing a different validation path.
- `{sourcecounter}` (`naming.js` builtin, numbers sources/cards, not
  files) must NOT be affected by this change — it's the correct token
  for a folder pattern like `Card_{sourcecounter}` and must keep working
  exactly as it does today.

## Build

1. Add a check — same validation layer as `unknownTokens`, either
   alongside it or as a new sibling function — that rejects a folder
   pattern referencing `{counter}` specifically (not `{sourcecounter}`,
   not any other token). Fire this:
   - At preset-save time in the editor, so it's caught while writing the
     pattern, before it's ever attached to a job.
   - As a defensive re-check at job-start (covers a preset imported from
     a `.hedge`-style file or hand-edited on disk that bypassed the
     editor's own validation).
2. Error message should say plainly: `{counter}` numbers files within a
   copy, not folders — using it in a folder pattern creates one folder
   per file. Suggest `{sourcecounter}` if they want to number by card
   instead.
3. No change to `{counter}` in file-name patterns — leave §65's
   auto-append behavior and existing file-pattern rendering untouched.

## Verification

Type `{counter}` into a folder-pattern field in the preset editor —
confirm it's rejected (clear error, matching the wording above) either
immediately or at save, your call on exact timing as long as it can't be
saved successfully. Confirm `{sourcecounter}` in a folder pattern still
works exactly as before (e.g. `Card_{sourcecounter}` renders correctly,
one folder per card, not per file). Confirm a preset file on disk with
`{counter}` hand-edited into its folder template is rejected at
job-start with the same error, not silently honored. Confirm file-name
patterns using `{counter}` are completely unaffected — same rendering,
same auto-append behavior as after §65.
