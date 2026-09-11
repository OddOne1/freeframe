# Claude Code prompt — desktop: Choice field type, naming engine changes

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §65, points 1-9 — read it first, including the "Current
state (confirmed)" block above the decisions list.

## Current state (confirmed, don't re-investigate)

- Field types today: Text and "Suggesting" (`presets.js`'s
  `recordValues()`, `MAX_SUGGESTIONS=20`). No authored fixed-list type
  exists.
- `naming.js:62-89` (`builtinValues`) — all built-in tokens, lowercase
  keys, exact-match lookup in `renderTemplate` (`:217-237`).
- `naming.js:372-386` — the `NAMING_COLLISION` hard-refusal on two files
  rendering to the same destination path.
- `naming.js:79-87` — `{counter}` (per-file, resets per job) vs.
  `{sourcecounter}` (per-source, persists globally via `presets.js:168-181`).

## Build

1. **New "Choice" field type** in the preset data model (`presets.js`)
   and preset editor (`preset-editor.js`): an ordered list of options,
   each `{ label: string, token?: string }` (token falls back to label
   when blank). A per-field boolean, `allowOther`, defaults false. Field
   editor UI: add/remove/reorder option rows (label + optional token
   input each), a checkbox for `allowOther` ("Offer 'Other…' for one-off
   values not on this list" — match this wording or close to it).
2. **Remove the Suggesting field type entirely** — the type option
   itself, `recordValues()`/history mechanism, `MAX_SUGGESTIONS`, and
   the `<datalist>` wiring. This is a real capability removal, not a
   rename — say so plainly in the build report. If any existing saved
   preset has a Suggesting-type field, decide what happens to it on
   load (e.g. treat as plain Text going forward) and state the choice
   and reasoning in the report.
3. **Runtime rendering of a Choice field** (wherever field values are
   collected before a job starts — locate this via `index.html`, it's
   the panel referenced from prior work around `:3186-3356`, re-verify
   current line numbers before editing): render as a `<select>` of the
   authored options, substituting the picked option's `token` (or
   `label` if token is blank) into the naming pattern exactly where that
   field's placeholder token sits. If `allowOther` is true, add an
   "Other…" entry; selecting it reveals an inline text input directly
   beside/below THAT field only, and its typed value becomes the
   substituted value instead.
4. **Filename collision auto-append.** In `naming.js`'s file-pattern
   rendering path, before the `NAMING_COLLISION` check at `:377`: if the
   file template does not reference `{counter}` or `{sourcecounter}`
   (check via `tokensIn()`, `:186-192`), append `_{counter}` (4-digit,
   `pad(index, 4)` matching existing padding) to the rendered base name.
   Scope this to the FILE pattern only — do not touch folder-pattern
   rendering, folder-level `{counter}` behavior (folder-per-file,
   `:79-81`) is unchanged. Leave the `NAMING_COLLISION` throw in place
   as a defensive fallback for other collision shapes; note in the build
   report that it should now be effectively unreachable for the
   "forgot {counter}" case specifically.
5. **Chip/insert-list pruning** in the preset editor's pattern-input UI:
   remove `{ext}`, `{cardname}`, `{datetime}`, `{date}` from the
   clickable chip list. Keep `{name}`, `{counter}`, custom field tokens
   (`{operator}`, `{camera}`, etc.).
6. **Case-sensitive date/time token pairs.** This requires
   `renderTemplate`'s lookup (`naming.js:217-237`) to become genuinely
   case-sensitive with distinct keys for both cases — today it's one
   lowercase key set. Add: `YY`, `YYYY`, `MM`, `DD` (uppercase, same
   values as existing `yy`/`yyyy`/`mm`/`dd`) and `hh` (new, hour,
   24-hour format, 2-digit padded) and `mm` (new, lowercase, MINUTES,
   2-digit padded — deliberately the same string as the uppercase `MM`
   token except for case; these must resolve to different values).
   Decide how you handle the fact that a plain-lowercase `mm` already
   doesn't exist today (it's currently only `mm` = month) — the safest
   path is likely: keep lowercase `mm` = month unchanged for backward
   compatibility with any existing saved pattern, and introduce the new
   minute token under a different casing that doesn't collide (e.g. only
   `MM` uppercase = month, `mm` lowercase = minutes, and existing
   patterns using `{mm}` need a decision — check whether any existing
   preset patterns use `{mm}` before deciding whether this is a safe
   breaking change; state your finding and choice explicitly in the
   build report, this is a real behavior-change risk if any saved preset
   relies on today's `{mm}`). Chip labels in the editor show `{YY}`
   `{YYYY}` `{MM}` `{DD}` `{hh}` `{mm}` — remove the old `{time}` chip.
7. **Split, scoped preview.** Replace the single before/after full-path
   preview with two independent previews: one under the Folder pattern
   field (rendered folder structure only), one under the File name
   pattern field (rendered filename only). Neither should include the
   preserved original source subtree beneath the template (e.g. no
   `DCIM/100MEDIA/` noise) — render using only the template's own output,
   not the full destination-relative path. Highlight any auto-corrected
   or inferred text (e.g. the auto-appended `_0001`) in amber/yellow —
   check what warning/amber CSS variable this app already uses elsewhere
   before inventing a new color.

## Verification

Create a Choice field with 3 options (label + token) and `allowOther`
on — confirm it renders as a dropdown at job-start with a working
"Other…" reveal, and the picked/typed value lands correctly in the
rendered filename. Confirm Suggesting no longer appears as a field-type
option anywhere. Run a job with a file pattern that omits `{counter}` —
confirm no `NAMING_COLLISION` error, files get a `_0001`-style suffix
automatically, and this is shown in amber in the preview. Confirm a
folder-only pattern with `{counter}` in it still creates folder-per-file
exactly as before (unaffected by the collision-fix scoping). Type
`{YYYY}_{MM}_{DD}_{hh}{mm}` into a file pattern — confirm it renders
correct year/month/day/hour/minute values, and specifically confirm
`{MM}` and `{mm}` render DIFFERENT values (month vs. minutes) in the
same pattern. Confirm the old `{ext}`/`{cardname}`/`{datetime}`/`{date}`/`{time}`
chips are gone from the insert list. Confirm the two split previews
each show only their own field's rendered output, no source-subtree
noise.
