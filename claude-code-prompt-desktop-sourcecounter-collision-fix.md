# Claude Code prompt — desktop: fix auto-counter safety net exempting {sourcecounter}

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §74 — read it first. This is a ONE-LINE logic fix; do not
run `npm test` or any e2e script other than the one named below (see
the standing rule near the top of CLAUDE.md about `apps/desktop`'s
test suite being unscoped and focus-stealing).

## Current state (confirmed, don't re-investigate)

- Caught from a real failed job, not a test: `{sourcecounter}`
  (`naming.js:105`) renders one constant value for the whole job.
  `{counter}` (`naming.js:100`) is the only token that varies per
  file. The safety net at `naming.js:345-346` currently exempts a file
  pattern from auto-appending `_{counter}` if it contains EITHER
  token — it should only exempt on `{counter}`.
- `renderBaseFor()` (`naming.js:411-423`) is where the suffix actually
  gets appended, gated on `autoCounter && out`. No change needed there
  — it already does the right thing once `autoCounter` is computed
  correctly.

## Build

In `naming.js:345-346`, remove `"sourcecounter"` from the exemption
check:

```js
const autoCounter = Boolean(file)
    && !tokensIn(file).some((t) => t === "counter");
```

Update the comment above it (`:331-343`, the "§65.5 — the 'forgot
{counter}' safety net" block) to note explicitly that `{sourcecounter}`
does NOT exempt a pattern from this — it's constant per job, not
per-file, so a pattern using only it still needs the suffix.

## Verification

Build a file pattern using only constant-per-job fields (a couple of
custom fields, no `{counter}`) plus `{sourcecounter}` — e.g. the
pattern from the failing real job: `{cardnum}_{date}_{shootingtype}_
{operator}_{athlete1}{athlete2}` with `{sourcecounter}` folded into
`{cardnum}` or similar, whatever your actual field-to-token mapping
is. Run a copy job on a source folder with 2+ files (no need for a
real card — a scratch folder with a couple of dummy files works).
Confirm it succeeds instead of throwing `NAMING_COLLISION`, and that
the resulting file names carry a `_0001`/`_0002`/… suffix. Confirm the
naming-card preview (before Start is pressed) also shows the suffix,
matching what actually lands on disk — this is the same preview
`mapRel.autoCounter` already feeds per §65.9, so it should update for
free. Then build a pattern that DOES include `{counter}` alongside
`{sourcecounter}` — confirm no suffix is auto-appended (the pattern's
own `{counter}` already provides uniqueness, unchanged behavior).
