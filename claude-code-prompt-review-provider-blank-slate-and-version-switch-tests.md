# Claude Code prompt — confirm/apply blank-slate fix for ReviewProvider
stale window, add version-switch regression tests

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`. Run `npx vitest run` at the end, and reconcile the total
test count against passed+failed+skipped+pending — don't trust the
summary line alone (a hung test file was recently found silently
reporting as skipped/exit-0 in this suite).

## Context

76c11f1 diagnosed a stale-window bug in `ReviewProvider`: `fetchAsset`
sets the new asset before the new version is resolved (there's a full
network round trip for `/assets/{id}/versions` in between), and during
that window the app holds the new asset paired with the OLD version.
Four consumers were found building requests off exactly that
mismatched pair: transcript, stream (including the version-scoped
fetch from §117), comments, and approvals.

## What to do

1. **Confirm what 76c11f1 actually did to fix this.** If it patched
   the mismatch per-consumer (four separate guards/fixes), that leaves
   the door open for a fifth consumer nobody's found yet hitting the
   same stale window later. Prefer and apply, if not already the
   approach: clear `currentVersion`/relevant state to a blank/loading
   slate FIRST when switching assets, then load the new asset and
   version together, so no consumer can ever observe a mismatched
   asset+version pair — not because it was specifically guarded, but
   because the mismatched state never exists. Report clearly which
   approach is now in place.
2. **Add explicit regression tests for switching between assets and
   between versions**, not just for transcript fetching. Cover at
   minimum: switching assets while a version-scoped request is in
   flight, switching versions within the same asset, and rapid
   back-to-back switches (the kind of thing a user double-clicking
   through a version list would trigger). These should fail on the old
   per-consumer-guard approach if that's what's currently shipped, to
   prove the blank-slate approach is actually stronger.
3. Re-examine Bug C from earlier today's urgent-playback prompt: asset
   `4876b3cf-b1d4-45f7-a253-6bce8e1134ad` was observed requesting a
   completely unrelated asset `2e166f20-bb5d-47af-855e-fdb2082699af`,
   repeatedly, never conclusively explained at the time. Check whether
   this stale-window bug is the actual root cause. Confirm or rule out
   explicitly — don't leave it ambiguous a second time.

## Verification

Real browser: rapidly switch between several versions of the same
asset, and between different assets, while watching the network tab.
Confirm no request is ever made with a mismatched asset/version pair
across transcript, stream, comments, and approvals. Confirm the UI
shows a clear loading/blank state during the switch rather than
briefly showing stale content from the previous asset/version. Run
`npx vitest run` for the whole app at the end, reconcile counts as
described above, and report pass/fail/skipped/pending numbers
explicitly rather than just the summary line.
