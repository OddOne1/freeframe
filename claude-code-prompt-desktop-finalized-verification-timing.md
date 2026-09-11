# Claude Code prompt — desktop: finalized verification off/after/during (§103)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §103 — read it first, and skim §86 (`grep "^## §86"`) for
the original finalized-pass design this extends; do not re-derive it
from scratch. This is `apps/desktop`. Per the standing policy in
CLAUDE.md's hard rules, run the full desktop test suite at the end —
don't skip straight to reporting clean.

## Current state (confirmed, don't re-investigate)

- `settings.js` has a boolean `finalizedChecksumEnabled` (`:26`,
  normalized at `:99`). This becomes a 3-way `finalizedTiming`
  (`"off" | "after" | "during"`, default `"off"`).
- `main.js:1374-1379` gates `finalizedAlgorithm` on that boolean and
  passes it to `runCopyJob` at `:1522` and `:1536`.
- `copy-engine.js` `runCopyJob` accepts `finalizedAlgorithm` (default
  `null`, param at `:448`). When set, after every leg finishes
  (`:840-862`), it calls `runFinalizedPass` (`:936-985`) once over the
  whole file list — this is "After transfer," and must stay exactly
  as-is for that mode.
- `runLeg` (`:275-362`) is the per-file loop for a single leg (one
  source, one or more `toRoots`). Live copy+verify per file happens at
  `:299-341`; `entry.destinations`/`entry.ok` land at `:336-337`; the
  `file-done` event fires at `:350-358`.
- `n.files` (built at `:796-805`, in the code after all legs run)
  already carries `sourceHash`/`destPath`/`bytes`/`ok` per node — this
  is where a `finalCheck` field needs to land too, whichever mode
  produced it.
- Settings UI wiring for the current boolean is in
  `settings-window.js` at `:59`, `:90-92`, `:130-136`, `:347-350`,
  `:408-411`.

## Build

Follow CLAUDE.md §103's "Build shape" section point by point — it
already names every file and line range. In order:

1. `settings.js`: `finalizedChecksumEnabled` → `finalizedTiming`
   (`"off"|"after"|"during"`, default `"off"`). Migration in
   `normalize()`: valid `finalizedTiming` wins; else old
   `finalizedChecksumEnabled === true` maps to `"after"` (exact
   behavior preservation for existing users); else `"off"`. Update
   `module.exports` if needed. Do not touch `finalizedChecksumAlgo` or
   `finalizedAlgoFor()`.
2. `main.js:1374-1379`: gate on `finalizedTiming !== "off"` instead of
   the boolean. Thread `finalizedTiming` through to both
   `runCopyJob(...)` call sites alongside `finalizedAlgorithm`.
3. `copy-engine.js` `runCopyJob`: add `finalizedTiming = "off"` param.
   - `"after"`: keep `:840-862` as-is, just tag the resulting
     `finalized` object with `mode: "after"`.
   - `"during"`: skip the end-of-job `runFinalizedPass` call entirely.
     Instead, aggregate a `finalized` summary object (same shape:
     `algorithm`, `algorithmLabel`, `checked`, `verified`,
     `mismatches`, `errors`, `ok`, tag `mode: "during"`) from the
     per-file `finalCheck` results already collected during the legs
     (see step 4) — walk `nodesOut.flatMap(n => n.files)` and tally.
   - `"off"`: unchanged, no finalized block, exactly today's behavior.
4. `runLeg`: accept `finalizedAlgorithm`, `finalizedTiming`, and the
   original job `sourcePath` (thread it into EVERY `runLeg` call in
   `runCopyJob`, including cascaded legs — cascaded legs currently only
   receive `from`/`toRoots`, not the root `sourcePath`, and that has to
   change here). When `finalizedTiming === "during"` and
   `finalizedAlgorithm` and `entry.ok === true` (only re-check files
   whose live pass already succeeded — see §103's reasoning), after
   `:337` re-read `path.join(sourcePath, rel)` fresh from disk plus
   every `destFiles[i]` fresh, hash with `finalizedAlgorithm`, compare,
   and set `entry.finalCheck = { algorithm, sourceHash, destinations:
   [{destRoot, path, hash, bytes, ok}, ...], ok }` — mirror
   `entry.destinations`' shape, not `runFinalizedPass`'s per-node-split
   shape. **This must read from the original `sourcePath`, never from
   `from` — a cascaded leg re-checking against its own parent
   destination instead of the card would silently weaken "during"
   relative to "after" for cascades. This is the one thing in this
   build most likely to be gotten wrong quietly — treat it as the
   primary verification target, not an afterthought.** Include
   `entry.finalCheck` in the `file-done` event and propagate it into
   `n.files` at `:796-805`.
5. Settings UI (`settings-window.js`): replace the boolean
   checkbox with a 3-way control — Off / After transfer / During
   transfer. "During transfer" needs a visible (not tooltip-only) note
   that it runs slower, since it doubles disk reads during the copy
   itself rather than after. Update the IPC payload key from
   `finalizedChecksumEnabled` to `finalizedTiming` everywhere it's
   read/written (`:130-136`, `:347-350`, `:408-411`).
6. Job log (§84's readable section — find where the finalized block
   currently gets formatted for the log, likely near where
   `summary.finalized` is consumed): label it with which mode produced
   it, e.g. "Source & Destination verification — after transfer" vs.
   "— during transfer", not a bare "finalized" heading.

## Verification

Per CLAUDE.md §103's verification section: run one job on each of the
three settings and confirm behavior matches (off = no finalized block;
after = identical to pre-§103 behavior, log says "after transfer";
during = each file's recheck completes before the next file's copy
starts, measurably slower than "after" for the same files, log says
"during transfer"). Run a CASCADED job under "during" specifically and
confirm the inline recheck reads from the original source card for
every leg, not the immediate parent destination — this is the
highest-value test in this whole build. Inject a genuinely bad
destination write and confirm both "after" and "during" catch it
identically. Extend the existing §86 finalized-pass tests with cases
for the timing dimension. Run the full desktop test suite (the
Electron/e2e suite included, using `electron-harness.js`'s guaranteed
teardown per §62 — don't reintroduce a leaked-process risk) at the
end, per the standing full-test-suite policy — report pass/fail
counts, and flag anything that wasn't already a documented
pre-existing failure.
