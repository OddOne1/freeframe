# Claude Code prompt — desktop: close eject button's subfolder gap

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §76's correction note — read it first. One-line change on
top of `7b06a66`. Do not run `npm test` or any e2e script other than
the one named below (see CLAUDE.md's standing rule about
`apps/desktop`'s test suite being unscoped and focus-stealing).

## Current state (confirmed, don't re-investigate)

- `7b06a66` shipped the eject button's role check as an exact path
  match: `const heldAsSource = sourcePath === entry.mountPoint;` /
  `const heldAsDest = destNodes.some((n) => n.path === entry.mountPoint);`
  (`index.html`, inside `makeTile()`'s new eject-button block, just
  after the `ejectVol`/`isNetwork`/`verb` lines).
- `makeTile()` already computes `derived = roleFor(entry.mountPoint)`
  a few lines above (`:2576` area, pre-existing, powers the tile's own
  source/dest outline via `deviceFor()`). `derived.isSource` /
  `derived.isDest` are exactly the values the visible outline uses.
- The gap this closes: assigning a SUBFOLDER of a drive (e.g. a card's
  `DCIM` directory) as Source or Destination makes the tile show a
  role outline (via `derived`) but left the eject button enabled (via
  the exact-match check), because the two used different signals.

## Build

Replace the eject button's `heldAsSource`/`heldAsDest` computation to
use `derived` instead of the exact-match pair:

```js
const heldAsSource = derived.isSource;
const heldAsDest = derived.isDest;
```

No other change needed — `busy`, the button's `title`/`disabled`
logic, and everything else in the block stays as shipped.

## Verification

Assign a card's subfolder (e.g. `DCIM`) as Source, not the drive root
— confirm the drive's own tile in the Volumes column now shows the
eject button disabled, with the same "remove this drive's Source role"
title as an exact-root assignment gets. Confirm ejecting from an
unrelated, unassigned drive still works. Confirm the mid-copy
(`isBusy`) gate still works unchanged. Re-run the original subfolder
case from the `7b06a66` report — confirm it no longer diverges from
what the tile's outline shows.
