# Claude Code prompt — desktop: OffShoot-style filename suffix, manual date override, shorter checksum blurbs, seeded card values

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §77, §78, §79, §80 — read all four first. Four independent
changes, combined into one build. Do not run `npm test` or any e2e
script other than `node scripts/test-naming.js` (pure logic, no
Electron) — see CLAUDE.md's standing rule about `apps/desktop`'s test
suite being unscoped and focus-stealing.

## Part A — §77: auto-suffix becomes a per-preset choice (counter/filename, front/end)

### Current state (confirmed, don't re-investigate)

- `renderBaseFor(rel)` (`naming.js:411-423`) currently does
  `if (autoCounter && out) out += \`_${pad(ctx.index, 4)}\`;`.
- `mapRel()` (`:449-453`) re-adds the real extension after calling
  `renderBaseFor()` — untouched by this change.
- `path` is already required at the top of `naming.js`.
- `normalizePreset()` (`presets.js:85-114`) is the pattern for adding
  a new normalized preset field — see how `filters:
  normalizeFilters(p?.filters)` is done there, right next to where the
  new `autoSuffix` field goes.
- `buildRelMapper()`'s call sites: the preview at `main.js:530`, the
  real job at `main.js:995`. Both need the two new params threaded
  through.
- `namingPayload()` (`index.html:3356-3375`) is where the renderer
  packages `folderTemplate`/`fileTemplate`/`filters`/etc. for a job —
  `preset.autoSuffix` needs to ride along the same way.
- `preset-editor.js` — find where the file-name pattern's "Click to
  insert" chips and the existing auto-append explanation are rendered;
  the new Source/Position control goes in the same area, and should
  save through whatever mechanism already persists
  `folderTemplate`/`fileTemplate` edits, not a new one.

### Build

1. `presets.js`: add `normalizeAutoSuffix(value)` — returns `{
   source: "counter" | "filename", position: "end" | "front" }`,
   defaulting each axis independently to `"counter"`/`"end"` on
   anything missing or invalid. Add `autoSuffix:
   normalizeAutoSuffix(p?.autoSuffix)` to `normalizePreset()`'s
   returned object.
2. `naming.js`: `buildRelMapper({ ..., autoSuffixSource = "counter",
   autoSuffixPosition = "end" })` — two new destructured params.
   `renderBaseFor(rel)` becomes:
   ```js
   function renderBaseFor(rel) {
     if (renderedBase.has(rel)) return renderedBase.get(rel);
     index += 1;
     const ctx = { now, sourceLabel, rel, index: indexFor.get(rel) ?? index, sourceCounter };
     let out = renderTemplate(file, values, ctx);
     if (autoCounter && out) {
       const suffixValue = autoSuffixSource === "filename"
         ? path.basename(rel, path.extname(rel))
         : pad(ctx.index, 4);
       out = autoSuffixPosition === "front"
         ? `${suffixValue}_${out}`
         : `${out}_${suffixValue}`;
     }
     renderedBase.set(rel, out);
     return out;
   }
   ```
   Update the comment block above `autoCounter` (`:331-343`) to
   describe both axes instead of a single fixed `_0001` suffix.
3. `preset-editor.js`: add the Source (Counter / Original filename)
   and Position (Front / End) control near the file-name pattern
   editor, persisting into the preset's `autoSuffix` field via the
   existing save path.
4. `namingPayload()` (`index.html:3356-3375`): include
   `autoSuffix: preset.autoSuffix` in the returned payload.
5. `main.js:995`'s real-job `buildRelMapper({...})` call: read
   `naming.autoSuffix.source`/`.position` from the payload (defensive —
   fall back to `"counter"`/`"end"` on anything unexpected, same
   posture as the rest of this boundary) and pass as
   `autoSuffixSource`/`autoSuffixPosition`.
6. `main.js:523-537`'s `presets:preview` handler: accept and pass
   through the same two values so the live preview matches what a real
   job would produce.

### Verification

Using the real "TEST" pattern (constant-per-job fields +
`{sourcecounter}`, no `{counter}`): with the preset's `autoSuffix` at
its default (counter, end) — confirm behavior is UNCHANGED from what
shipped in `e880ec2` (`_0001`/`_0002`, at the end). Switch the preset
to filename/end — confirm `P1012257.MOV`/`P1012258.MOV` produce
`..._P1012257.MOV`/`..._P1012258.MOV`. Switch to filename/front —
confirm the source stem lands at the START of the rendered name
instead. Switch to counter/front — confirm the zero-padded number
moves to the front. Confirm the naming-card preview matches whichever
combination is selected. Confirm a pattern that already includes
`{counter}` still skips the auto-suffix entirely regardless of these
settings (unchanged from §74). Confirm an existing preset saved before
this build (no `autoSuffix` field on disk) loads with counter/end and
behaves exactly as it did before.

## Part B — §78: manual date override, defaulting to live/auto

### Current state (confirmed, don't re-investigate)

- `naming.js:62`, `builtinValues({ now = new Date(), ... })` — the
  live clock, no override path exists anywhere today.
- `namingPayload()` (`index.html:3356-3375`) never sends a date/`now`
  field.
- `buildRelMapper()`'s two call sites both omit `now`: the preview at
  `main.js:530` and the real job at `main.js:995`.
- `renderCardNumber()` (`index.html:3596-3611`) is the pattern to
  follow for a small override control outside the per-field list —
  read it for the visual/structural convention (label, input, a
  reset-style action).
- `updateFieldsPreview()` (`index.html:3652-3665`) calls
  `window.freeframe.previewNaming(folderTemplate, fileTemplate,
  values, sourceLabel, disabled)` — positional args, IPC channel
  `presets:preview` (`main.js:523-537`).

### Build

1. New renderer state near `sourceCounter`/`claimedForPath`: `let
   dateOverride = null;` — `null` means "use the live clock," anything
   else is a `Date`-constructible value the user set.
2. New row in `renderFieldsPanel()` (after the per-field loop, near
   where `renderCardNumber()` is appended, `:3579`): a date input
   showing the effective date (today, or the override if set) and a
   "Now" button that clears `dateOverride` back to `null`. Changing
   the input sets `dateOverride`. Re-render the fields preview on
   change, same as every other field control does.
3. `namingPayload()`: add `dateOverride: dateOverride ?
   dateOverride.toISOString() : null` (or similar serializable form)
   to the returned object.
4. `main.js:995`'s `buildRelMapper({...})` call: read
   `naming.dateOverride` from the payload, validate it (a real,
   parseable date — anything else falls back to `new Date()` rather
   than throwing, matching the defensive treatment
   `presets.normalizeCounter()` already gives `sourceCounter` a few
   lines above), and pass the result as `now:`.
5. `window.freeframe.previewNaming(...)` (renderer) and the
   `presets:preview` handler (`main.js:523-537`): add the same
   `dateOverride` as a 6th argument / extra payload field, and pass a
   validated `now:` through to `buildRelMapper()` there too, so the
   live preview reflects a manually-set date instead of silently
   diverging from what the real job would produce. Update
   `preload.js`'s `previewNaming` signature to match.

### Verification

With no override set, confirm the naming card shows today's date and
the preview/real job both render today's `{date}`/`{YYYY}{MM}{DD}`
values, unchanged from before this build. Set an override to a
different date, confirm the preview updates to reflect it, then run a
real (or scratch) copy job and confirm the resulting filenames use the
overridden date, not today's. Click "Now" — confirm it reverts to
today's date and the preview updates back. Restart the app (or just
assign a new source) — confirm the override does NOT persist across
that (session-only state, not a stored preference).

## Part C — §79: shorten the checksum algorithm blurbs

### Current state (confirmed, don't re-investigate)

`hashers.js:76-110`, the `ALGORITHMS` registry — four entries
(`xxhash64`, `md5`, `sha1`, `c4`), each with a multi-sentence `blurb`
shown in the algorithm picker (`index.html:686-690` describes this
picker).

### Build

Shorten each `blurb` to roughly one short sentence, keeping the one
load-bearing distinction each currently makes:

- `xxhash64`: fast, non-cryptographic, the right default when the
  question is just "did the copy succeed."
- `md5`: fast, cryptographically broken, fine for accidental
  corruption, pick for compatibility with an existing MD5 workflow.
- `sha1`: slower than MD5, also broken, legacy/compatibility pick
  only.
- `c4`: cryptographically strong, self-describing long-form identifier,
  the pick when the offload needs to hold up as evidence later.

### Verification

Open the algorithm picker in the running app, confirm all four blurbs
render as shortened one-liners rather than paragraphs, and confirm
each one still clearly conveys why you'd pick it over the others.

## Part D — §80: new cards seed their naming values from the last card's

### Current state (confirmed, don't re-investigate)

- `valuesBySource` (`index.html:3161-3167`) — a `path -> { values,
  disabled }` map. `valuesEntry(path)` creates a BLANK entry
  (`{ values: {}, disabled: new Set() }`) for any path not already in
  the map — confirmed no seeding of any kind happens today.
- `:3524`'s comment confirms per-card isolation is intentional and
  already correct for a card you've SEEN before (swap back, get what
  you typed) — this build only changes what a brand-NEW card starts
  with.
- `:3180-3189`'s comment is an explicit warning from a past mistake:
  an earlier version of `syncPresetValues()` accidentally let one
  card's edits leak into another via a shared reference. This build
  must copy values at creation time, never share the object, or it
  reintroduces exactly that bug.

### Build

In `valuesEntry(path)` (`:3163-3167`), add a module-level `let
lastActiveKey = null;` near `valuesBySource`. On creating a new entry,
seed its `values` from `lastActiveKey`'s entry if one exists (shallow
copy — `{ ...valuesBySource.get(lastActiveKey).values }` — not the
same object). Update `lastActiveKey` to the real key being accessed
AFTER that seed decision, so a new card seeds from the card before it,
not from itself. `disabled` is NOT seeded — a new card always starts
with every field enabled, unchanged from today.

```js
let lastActiveKey = null;

function valuesEntry(path = sourcePath) {
  const key = path || "__none__";
  if (!valuesBySource.has(key)) {
    const seed = key !== "__none__" && lastActiveKey && valuesBySource.has(lastActiveKey)
      ? { ...valuesBySource.get(lastActiveKey).values }
      : {};
    valuesBySource.set(key, { values: seed, disabled: new Set() });
  }
  if (key !== "__none__") lastActiveKey = key;
  return valuesBySource.get(key);
}
```

### Verification

Assign card A, fill in Operator/Shooting Type. Assign card B (a path
never seen before) — confirm its naming panel shows A's values
pre-filled, not blank. Edit B's Operator field — confirm A's stored
value is UNCHANGED (swap back to A and confirm). Assign card C —
confirm it seeds from B (the most recently active card), not from A.
Assign a card that was already used earlier in the session (swap back
to A) — confirm it still shows exactly what was typed for A, not
reseeded from whatever was last active (the existing per-card restore
behavior from `:3524` must survive this change untouched). With no
source ever assigned yet (fresh app launch), confirm the first card
still starts blank (no `lastActiveKey` to seed from).

Exact wording is your call — the requirement is "roughly one sentence,
keeps the real distinction," not a specific string.

### Verification

Open the algorithm picker in the running app, confirm all four blurbs
render as shortened one-liners rather than paragraphs, and confirm
each one still clearly conveys why you'd pick it over the others.
