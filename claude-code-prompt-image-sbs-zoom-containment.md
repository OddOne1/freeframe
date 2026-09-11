# Claude Code prompt — fix image side-by-side zoom containment/sizing

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web`, fixing a gap that was explicitly flagged as unverified in
the prior video zoom-containment fix (commit fe8cc1b): "the image
branch shares the transform but has its own pane markup... it's the
most likely place a similar overflow still hides." Confirmed by the
user with a screenshot — at 200% zoom in side-by-side image compare,
both images render letterboxed inside a smaller vertically-centered box
within their panes, with black bars above and below, rather than
filling/scaling correctly. Wipe mode and video side-by-side are
unaffected — this is specific to the image side-by-side branch.

Run `npx vitest run` at the end.

## Investigate first — this needs a real diagnosis, not an assumed fix

Don't assume this is the identical bug to the earlier video overflow
fix (missing `overflow-hidden`) — the visual symptom is different
(letterboxing/under-filling vs. the earlier bug's overflow/bleeding), so
the mechanism may differ too. Compare the image side-by-side pane markup
against the video side-by-side pane markup (`compare-video-stage.tsx`,
already fixed) to find where they diverge — likely candidates: the
image branch's pane container isn't stretching to fill available
height (a flex/sizing property difference), the image element itself
uses different sizing classes than the fixed video element (check for
`object-contain`/`object-fit` differences, or a fixed/max height
constraint left over from before the object-contain fix that video
received), or the shared zoom transform (`use-shared-transform.ts`) is
being applied against a different baseline measurement for images vs.
video (e.g. `metrics.boxWidth/boxHeight` sourced from a different/stale
element for the image path). Get an actual repro in a real browser
(zoom to 200% on an image pair in side-by-side) and inspect the actual
rendered box dimensions before writing a fix, per this project's
existing diagnosis-confidence standard — report what you actually found
different between the two branches, not a guess.

## Fix

Once the actual divergence is identified, bring the image side-by-side
branch in line with the now-correct video side-by-side behavior: same
sizing approach (`object-contain`/full pane fill), same zoom
containment, same shared-transform baseline behavior. The two branches
should converge on identical sizing/zoom logic wherever the underlying
difference between "it's a `<video>` vs `<img>`" doesn't actually
require different handling — don't leave two parallel
almost-but-not-quite-identical implementations if this can reasonably
be unified, since that's exactly what caused this gap to exist in the
first place (a fix landing on one branch without an equivalent path to
apply it to the other).

## Verification

Manual, real browser: zoom an image pair to several of the fixed steps
(50%, 100%, 150%, 200%) in side-by-side mode, confirm no letterboxing
and correct containment within each pane at every step. Repeat in wipe
mode for images to confirm no regression there. Repeat for video in
both modes to confirm the already-fixed behavior isn't disturbed by
whatever unification happens here. Run `npx vitest run` for the whole
app at the end — report pass/fail counts, flag anything not already a
documented pre-existing failure.
