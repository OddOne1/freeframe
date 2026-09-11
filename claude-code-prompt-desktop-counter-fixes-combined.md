# Claude Code prompt — desktop: two counter fixes, one build (§74 + §75)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §74 AND §75 — read both first. They touch adjacent code
(the naming engine's safety net, and the renderer's job-start claim
logic) and are combined here into one build so there's only one
round-trip. Build in the order below — §75 is easier to reason about
once §74's collision fix is in place, since §75's own manual retry
test depends on being able to reproduce a failed job in the first
place.

This replaces `claude-code-prompt-desktop-sourcecounter-collision-fix.md`
and `claude-code-prompt-desktop-reuse-claimed-counter-on-retry.md` as
separate builds — their content is unchanged, just merged here. Do not
run `npm test` or any e2e script other than the ONE named in
Verification below (see CLAUDE.md's standing rule about
`apps/desktop`'s test suite being unscoped and focus-stealing).

## Part A — §74: auto-counter safety net wrongly exempts `{sourcecounter}`

### Current state (confirmed, don't re-investigate)

- `naming.js:105`, `{sourcecounter}` renders one constant value for
  the whole job. `naming.js:100`, `{counter}` is the only token that
  varies per file.
- The safety net at `naming.js:345-346` currently exempts a file
  pattern from auto-appending `_{counter}` if it contains EITHER
  token — it should only exempt on `{counter}`.
- `renderBaseFor()` (`naming.js:411-423`) is where the suffix actually
  gets appended, gated on `autoCounter && out`. No change needed there.

### Build

In `naming.js:345-346`, remove `"sourcecounter"` from the exemption
check:

```js
const autoCounter = Boolean(file)
    && !tokensIn(file).some((t) => t === "counter");
```

Update the comment above it (`:331-343`) to note explicitly that
`{sourcecounter}` does NOT exempt a pattern from this — it's constant
per job, not per-file, so a pattern using only it still needs the
suffix.

## Part B — §75: a retried job for the same card reuses its claimed number

### Current state (confirmed, don't re-investigate)

- `claimSourceCounter()` (`index.html:1581-1587`) always calls
  `window.freeframe.bumpSourceCounter()` — no memory of prior claims.
- Its only caller is `startCopy()` (`index.html:2859-2875`): asks
  main's `renamesFiles()` predicate, and if true, unconditionally
  claims.
- `setSource(p)` (`index.html:1589` onward) is the only place
  `sourcePath` changes.
- `sourceCounter` (`:1576`) and its surrounding comment currently
  assert nothing is remembered per path — that assertion is what this
  build corrects. This is a deliberate, acknowledged walk-back of part
  of §71's own stated reasoning, prompted by hitting the §74 failure
  live: retrying the same still-assigned card after a failed start
  must not burn a second number.

### Build

1. Add `let claimedForPath = null;` near `sourceCounter` (`:1576`).
   Rewrite the comment block above it (`:1560-1575`) to explain: a
   claim is remembered for the CURRENT source path only, so a retried
   job on the same still-assigned card reuses its number instead of
   burning a new one; a genuinely reassigned source (even to the same
   physical card, re-picked) clears the memory.
2. In `startCopy()`'s claim block (`:2859-2875`), change:
   ```js
   if (renames) await claimSourceCounter();
   ```
   to:
   ```js
   if (renames && claimedForPath !== sourcePath) {
     await claimSourceCounter();
     claimedForPath = sourcePath;
   }
   ```
   When `claimedForPath === sourcePath`, the job's payload uses the
   existing `sourceCounter` value as-is — no other change needed.
3. In `setSource(p)`, wherever it actually commits the reassignment
   (the line(s) doing `sourcePath = p`), reset `claimedForPath = null`
   whenever the new value differs from the previous `sourcePath`
   (including a clear to `null`). Only after confirming the
   reassignment actually happens — some early returns in `setSource`
   refuse the change entirely; don't clear the claim on a refused
   assignment.

## Verification

Use the user's real, already-configured "TEST" naming preset as-is —
it IS the real use case (constant-per-job fields plus `{sourcecounter}`,
no `{counter}`), not a stand-in. Do not invent a second pattern to test
against; there's no need to cover other naming schemes here.

The user's real LUMIX card and ODDONE_01 drive may be used as the live
source/destination for this verification, exactly as in the original
failing run (`LUMIX → ODDONE_01/01_Projects/ReShuffle`) — that's real
hardware, not disposable scratch storage, so **whatever gets written to
ODDONE_01 during this verification must be deleted afterward**, leaving
the drive as it was found.

1. Run the copy job with the TEST preset, LUMIX as source, that same
   ODDONE_01 destination. Confirm it succeeds instead of throwing
   `NAMING_COLLISION`, the resulting file names carry a
   `_0001`/`_0002`/… suffix, and the naming-card preview showed the
   suffix before Start was even pressed.
2. On that same still-assigned LUMIX source: note the claimed card
   number, force a second failure (temporarily break the pattern again
   or use any other guaranteed early failure), retry Start — confirm
   the number does NOT advance a second time and the retried job uses
   the same number as the first attempt.
3. Eject the source and reassign the exact same LUMIX path, start a
   renaming job — confirm the number DOES advance this time.
4. If a second card/volume is available, assign it and start a
   renaming job — confirm it claims its own next number, unaffected by
   LUMIX's reuse. If not available, this step can be skipped rather
   than substituting a fabricated source.
5. Confirm a plain copy with no renaming still never claims at all.
6. Manually edit the Card # field between a failed attempt and its
   retry — confirm the retry uses the edited value, not the one from
   the failed attempt.
7. **Clean up**: delete everything this verification wrote to
   `ODDONE_01` before finishing, and confirm the drive's prior contents
   (`ReShuffle`'s existing data, if any) are untouched.
