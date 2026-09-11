# Claude Code prompt — desktop: reuse a card's claimed counter on retry instead of burning a new one

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §75 — read it first, including why this walks back part of
§71's own reasoning. Build `claude-code-prompt-desktop-sourcecounter-collision-fix.md`
(§74) first if it hasn't landed yet — not a hard dependency, but they
touch the same job-start path and are easiest to reason about in
order. Do not run `npm test` or any e2e script other than the one
named below (see CLAUDE.md's standing rule about `apps/desktop`'s test
suite being unscoped and focus-stealing).

## Current state (confirmed, don't re-investigate)

- `claimSourceCounter()` (`index.html:1581-1587`) always calls
  `window.freeframe.bumpSourceCounter()` — no memory of prior claims.
- Its only caller is `startCopy()` (`index.html:2859-2875`): asks
  main's `renamesFiles()` predicate, and if true, unconditionally
  claims.
- `setSource(p)` (`index.html:1589` onward) is the only place
  `sourcePath` changes.
- `sourceCounter` (`:1576`) and its surrounding comment currently
  assert that nothing is remembered per path — that assertion is what
  this build corrects.

## Build

1. Add `let claimedForPath = null;` near `sourceCounter` (`:1576`).
   Rewrite the comment block above it (`:1560-1575`) to explain the
   new behavior: a claim is remembered for the CURRENT source path
   only, so a retried job on the same still-assigned card reuses its
   number instead of burning a new one; a genuinely reassigned source
   (even to the same physical card, re-picked) clears the memory.
2. In `startCopy()`'s claim block (`:2859-2875`), change:
   ```js
   if (renames) await claimSourceCounter();
   ```
   to only claim when this path hasn't already claimed one:
   ```js
   if (renames && claimedForPath !== sourcePath) {
     await claimSourceCounter();
     claimedForPath = sourcePath;
   }
   ```
   When `claimedForPath === sourcePath`, the job's payload should use
   the existing `sourceCounter` value as-is — no other change needed,
   since `sourceCounter` already holds the last claimed value.
3. In `setSource(p)`, wherever it actually commits the reassignment
   (find the line(s) that do `sourcePath = p`), reset
   `claimedForPath = null` whenever the new value differs from the
   previous `sourcePath` — including when `p` is `null` (source
   cleared/ejected). Do this AFTER confirming the reassignment
   actually happens (some early returns in `setSource` refuse the
   change entirely — don't clear the claim on a refused assignment).

## Verification

Assign a card to Source, start a renaming job that fails immediately
(e.g. reproduce §74's original collision, or any other guaranteed
early failure) — confirm the claimed number advances once. Retry
Start on the SAME still-assigned card without touching Source —
confirm the number does NOT advance again, and the job runs with the
same claimed number as the failed attempt. Eject the card (clear
Source) and reassign the exact same path again, then start a renaming
job — confirm the number DOES advance this time (a fresh `setSource`
call, even to the same path, is treated as a new card per §75). Assign
a genuinely different card and start a renaming job — confirm it
claims its own next number, unaffected by the first card's reuse.
Confirm a plain copy with no renaming still never claims at all
(§71's original rule, unchanged). Manually edit the Card # field
between the failed attempt and the retry — confirm the retry uses the
edited value, not the one from the failed attempt (manual edits still
win, same as §71).
