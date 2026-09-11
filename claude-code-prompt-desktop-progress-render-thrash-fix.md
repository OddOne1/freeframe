# Claude Code prompt — desktop: stop rebuilding the whole Volumes column on every progress byte tick (URGENT)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §85 — read it first. This is the highest-priority item in
the current queue — it breaks basic interaction (clicks, drag-and-drop)
for the ENTIRE duration of every running copy job. Do not run
`npm test` or any e2e script other than the one named below (see
CLAUDE.md's standing rule about `apps/desktop`'s test suite being
unscoped and focus-stealing).

## Current state (confirmed, don't re-investigate)

- `onProgress(p)` (`index.html:2944-2964`) has three branches:
  `"node-status"`, `"bytes"`, `"source-released"`. All three currently
  call the full `render()`.
- `"bytes"` fires at the highest frequency by far — many times per
  second during an active copy — and is the one causing the problem.
  The other two are real, infrequent state transitions and are fine as
  full renders.
- `render()` (`index.html:~2739` onward) does
  `zoneVolumes.replaceChildren()` then rebuilds every tile in the
  Volumes column from scratch via `makeTile()` — including every
  kebab button (`:2694-2705`) and eject button (§76, `:2734-2758`
  area). This is what's being needlessly destroyed/recreated on every
  byte tick.
- Each destination tile's progress bar: `makeTile()` appends `el("div",
  { class: "node-bar" }, [el("div", { class: status-class, style:
  \`width:${pct}%\` })])` when `node` is present. The outer tile
  carries `dataset.destId = node.id` (see the `dataset:` object a few
  lines above the `node-bar` append).
- Confirmed via a real screen recording
  (`Screen Recording 2026-08-28 at 15.04.18.mov`): during a running
  LUMIX→ReShuffle job, right-clicking/kebab-clicking a Volumes tile
  repeatedly produced no menu at all — consistent with the click
  landing on an element that gets replaced mid-gesture.

## Build

1. In `onProgress()`'s `"bytes"` branch (`:2950-2956`), replace the
   `render()` call with a surgical update: for each `id` in
   `p.nodeIds || []`, update `nodeStatus` (unchanged, keep this part)
   AND find the existing DOM node for that destination
   (`document.querySelector('[data-dest-id="${id}"] .node-bar > div')`
   or equivalent — match whatever selector actually works against the
   markup `makeTile()` produces) and set its `style.width` directly to
   `${p.percent}%`. Do not touch anything else in the tile.
2. If the DOM node isn't found for a given ID (e.g. a render happened
   for an unrelated reason since the last tick and the tile doesn't
   exist under the expected selector), fall back to a full `render()`
   for that tick rather than silently dropping the update.
3. Leave `"node-status"` and `"source-released"` calling full
   `render()`, unchanged — they're infrequent, real state transitions
   that need the whole UI to reflect the new state.
4. Do NOT touch `add("Remove", ...)` (`:2522-2529`). It must stay
   unguarded — no `isBusy()`/disabled argument. This is deliberate:
   Remove is the menu equivalent of dragging a card out of Source/
   Destination, and it must never block or be affected by an
   already-running job. The user queues sequential jobs by clearing/
   reassigning Source or Destination immediately after starting a
   job, while the previous job keeps running in the background. Only
   "Eject" (`:2470-2486`) should stay gated on `isBusy()` — that's
   about not physically ejecting a volume mid-transfer, a different
   concern from Remove.

## Verification

Start a real (or scratch) copy job. While it's running, repeatedly
right-click and kebab-click Volumes tiles — confirm the context menu
opens reliably every time, not intermittently. Try dragging a
different card onto Source or Destination while the job runs — confirm
the drag isn't interrupted or blocked. Watch the Volumes column
visually during the run — confirm no flashing/flicker. Confirm the
progress bar for the running destination still updates smoothly and
accurately (this must not regress — it's the whole reason `"bytes"`
events exist). Right-click the SOURCE tile of a job that's actively
running and choose "Remove" — confirm it still works exactly as
before (clears the source tile, the running job is unaffected and
keeps copying/verifying to completion). This is intentional, not a
regression — do not gate it on `isBusy()`.
