# Claude Code prompt — desktop: two-tier checksum (live + finalized) + Settings reorder

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §86 — read it first. Do not run `npm test` or any e2e
script other than `node scripts/test-copy.js` (checksum-related pure
logic; check it exists and is the right scoped script before running
anything Electron-launching — see CLAUDE.md's standing rule about
`apps/desktop`'s test suite being unscoped and focus-stealing).

## Part A — settings storage

1. `main/settings.js`: rename `DEFAULTS.defaultChecksumAlgo` to
   `liveChecksumAlgo` (still defaults to `"xxhash64"`). Add
   `finalizedChecksumAlgo` (defaults to the same value as
   `liveChecksumAlgo`) and `finalizedChecksumEnabled` (default
   `false`).
2. `normalize()`: when reading a raw settings object, if
   `liveChecksumAlgo` is absent but the OLD key `defaultChecksumAlgo`
   is present, use that as the source value — an existing
   `settings.json` from before this change must upgrade cleanly, not
   silently reset to xxHash64. Validate both new algo fields against
   the caller's known algorithm ids the same defensive way the current
   code already validates `defaultChecksumAlgo` (stale id from an
   older build → fall back to default, don't leave nothing selected).
3. Grep every other reader of `defaultChecksumAlgo` (renderer
   `index.html`, any IPC handler in `main.js`) and update them to read
   `liveChecksumAlgo` instead — this is the field that actually drives
   copy-time hashing, so nothing should regress silently here.

## Part B — Settings window UI (`renderer/settings.html` + its script)

1. Reorder the General tab: Day boundary time block FIRST (unchanged
   content, just moved above the checksum section), then the checksum
   section.
2. Replace the current `.algo-list` clickable-picker markup with two
   real `<select>` dropdowns: "Live checksum" (`id="settings-live-checksum"`)
   and "Finalized checksum" (`id="settings-finalized-checksum"`), each
   populated from the same algorithm list the old picker used. Keep
   using `window.freeframe.getAlgorithms()`/`getSettings()`/whatever
   IPC the old picker called — only the markup and the settings key
   names change, not the underlying wiring.
3. Add a toggle switch near the finalized dropdown, labelled something
   like "Also run a finalized checksum after copy" — wire it to
   `finalizedChecksumEnabled`. When off, the finalized dropdown can
   stay visible but visually de-emphasized (your call on exact
   styling — match this app's existing disabled/muted convention).
4. Below both dropdowns, add a static, non-interactive block listing
   all four algorithms' existing `blurb` text from `hashers.js`'s
   `ALGORITHMS` — read-only reference copy, not a picker. Reuse the
   blurb strings verbatim, don't rewrite them.
5. Add one line of copy near the finalized toggle noting it only
   applies to jobs with a real local source (not FreeFrame-upload-only
   jobs) — check the exact current wording used elsewhere in this file
   for FreeFrame/upload-only jobs and match that tone rather than
   inventing new terminology.

## Part C — the actual second verification pass (`main/copy-engine.js`)

1. After ALL legs for a job (primary + any cascade) finish
   successfully, if the job was started with `finalizedChecksumEnabled`
   true AND the job has a real local `sourcePath` (not upload-only),
   run one more pass: for each file already in `fileResults`, re-read
   the SOURCE file from disk and hash it with the finalized algorithm
   (a fresh read — do not reuse the in-memory live-algorithm hash,
   they are different algorithms and not comparable), then re-read and
   hash every destination file the same way, and compare.
2. Store this as a NEW field per entry, e.g. `entry.finalCheck = {
   algo, sourceHash, destinations: [{path, hash, bytes, ok}], ok }` —
   do not overwrite or merge into `entry.destinations` (the existing
   live-verification result), both must survive side by side.
3. Respect `isCancelled()` the same way `runLeg()` already does —
   someone cancelling mid-finalized-pass should stop promptly, not
   finish rehashing everything first.
4. Thread `finalCheck` through to the job summary and public shape the
   same way `entry.destinations`/`entry.ok` already do (`summarizeRoot()`,
   `publicNode()`) so it's available to the job log.
5. Fold a finalized-check summary into §84's readable log section
   (`main/main.js`'s `buildJobLog()`) as its own clearly labeled block
   — e.g. "Finalized checksum (sha1): 42/42 verified" — separate from
   the existing live-verification numbers, not merged into them. If
   §84 hasn't been built yet in this repo when you get to this step,
   add it as a straightforward extra key in the existing log shape
   instead and note that in the build report so it can be folded into
   §84's structure later.

## Verification

Set live=xxHash64, finalized=SHA-1, toggle on. Run a real (or scratch)
local-source copy job. Confirm the job log/summary shows BOTH a live
verification result and a separate finalized SHA-1 result for every
file, both `ok: true` on a clean copy. Turn the toggle off and run
another job — confirm no finalized pass runs (check timing/duration
roughly matches a plain live-only job, not a doubled one). Deliberately
corrupt a destination file after copy but before triggering a
finalized re-check manually if there's a way to do so in testing, or
otherwise confirm via code review that a destination mismatch during
the finalized pass would be reported and not silently swallowed.
Restart the app and confirm the Settings window still shows the
correct saved live/finalized algorithms and toggle state after the
`defaultChecksumAlgo` → `liveChecksumAlgo` rename (i.e. confirm the
backward-compat fallback actually works against a settings.json
written by the OLD key name, not just a fresh install).
