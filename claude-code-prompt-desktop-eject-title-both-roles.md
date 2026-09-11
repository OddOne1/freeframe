# Claude Code prompt — desktop: eject button title should name both roles when both are held

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §76's second correction note — read it first. Trivial
text-only change on top of `b5a35aa`. Do not run `npm test` or any
e2e script other than the one named below (see CLAUDE.md's standing
rule about `apps/desktop`'s test suite being unscoped and
focus-stealing).

## Current state (confirmed, don't re-investigate)

`index.html:2756`, the eject button's disabled title:

```js
: `Remove this drive's ${heldAsSource ? "Source" : "Destination"} role before ejecting`
```

Only ever names one role, even when `heldAsSource && heldAsDest` are
both true (§59's role-both case — two folders on one RAID, one as
Source, one as Destination — now more reachable since `b5a35aa` moved
the check to device-level `derived`).

## Build

Change that line so both-held names both roles, singular otherwise:

```js
: `Remove this drive's ${
    heldAsSource && heldAsDest
      ? "Source and Destination roles"
      : heldAsSource ? "Source role" : "Destination role"
  } before ejecting`
```

(Adjust wording/formatting to match this file's existing style if the
above doesn't fit cleanly — the only requirement is that both-held
names both roles.)

## Verification

Assign one folder on a drive as Source and a different folder on the
SAME drive as Destination (§59's role-both workflow). Hover the
drive's eject button — confirm the title now names both roles, not
just Source. Confirm the single-role case (only Source, or only
Destination) still reads as before.
