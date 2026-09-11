# Claude Code prompt — desktop: concurrency labels match OffShoot + real Single Transfer mode

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §63 (desktop) — read it first. Not a pure relabel — one
of the four target labels needs new logic.

## Current state (confirmed, don't re-investigate)

Concurrency picker: `index.html:3435-3452` (dropdown), header button
`#conc-btn`/`#conc-label` at `:877-880`. Three modes today: `free`
("Alongside anything" / "Runs with anything"), `source` ("Only
alongside jobs from the same source" / "Runs alone", current
default), `destination` ("Only alongside jobs to the same
destination" / "Shares destination"). Coexistence logic lives in
`job-queue.js` (the `canCoexist`/`tolerates` pair referenced from the
original job-queue build).

**Target labels (OffShoot's own naming, use verbatim)**: Off / Single
Source / Single Destination / Single Transfer.

Mapping: `free` → "Off", `source` → "Single Source", `destination` →
"Single Destination" — these three are pure relabels. **"Single
Transfer" has no current equivalent** — it means fully serial, one
job running at a time, period, stricter than any existing mode (all
three current modes still permit some concurrency).

## Build

1. Relabel the three existing modes' text (button-face label and
   dropdown entry text) to "Off"/"Single Source"/"Single Destination"
   — pure copy change, no behavior change for these three.
2. Add a fourth coexistence mode to `job-queue.js`: "Single Transfer"
   — its `tolerates()` must return false against every other job
   regardless of mode, and every other job's `tolerates()` against it
   must also refuse (check `canCoexist`'s actual both-directions
   logic before assuming a one-sided change is sufficient — the
   existing code comment describes `canCoexist(a,b) = tolerates(a,b) && tolerates(b,a)`).
3. Add "Single Transfer" as a fourth option in the dropdown and
   button-label map.

## Verification

Confirm exact label text: Off, Single Source, Single Destination,
Single Transfer. Start a job under "Single Transfer" — attempt a
second job (same source, same destination, and fully unrelated
source+destination) — confirm all three cases queue and wait rather
than running concurrently. Confirm "Off" still behaves exactly like
today's "Alongside anything" (no regression on the pure-rename case).
Confirm "Single Source"/"Single Destination" behavior is unchanged
from today's `source`/`destination` modes — only the label changed
for these two.
