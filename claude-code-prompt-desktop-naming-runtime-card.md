# Claude Code prompt — desktop: compact naming card, button relocation, side-by-side Transfers

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §65, points 10-14 — read it first. Assumes the Choice field
type from `claude-code-prompt-desktop-naming-choice-field-engine.md`
already exists; build that one first if doing both today.

## Current state (confirmed, don't re-investigate)

- Header today: Refresh, Settings, Clear, Copy & Verify all live in the
  top-right header row.
- `#refresh`/`#settings-btn` should NOT move — only Clear and Copy &
  Verify are being relocated out of the header.
- The naming-values-before-copy panel exists in some form, referenced
  from prior work around `index.html:3186-3356` — re-verify current
  line numbers and structure before editing, do not assume it matches
  descriptions from earlier CLAUDE.md sections.
- `presets.js:177-181` (`setSourceCounter`) already supports editing
  `{sourcecounter}` directly — this is backend-only today, no UI
  surfaces it as an inline editable field in a job-start panel.
- Whatever "suspend naming without losing preset selection" mechanism
  task #65 originally called for — locate it (search for anything
  toggling naming on/off independent of preset selection) and confirm
  it still exists before starting; if it was never built, flag that
  gap in the build report rather than silently skipping it.

## Build

1. **Naming card**: rebuild the job-start naming-values panel as a
   compact, content-sized floating card — NOT a full-height column
   matching Volumes/Destination width. It must not overlap or cover the
   Destination drop zone at any point; pick an anchor (e.g. a popover
   anchored to wherever the naming-preset selector or Copy & Verify
   button ends up, or a right-edge drawer that pushes rather than
   overlays Destination) and get the actual layout right in the running
   app — do not just replicate an overlapping absolute-position sketch.
2. **Inline editable numbering**: add an editable field for
   `{sourcecounter}` directly in this card, wired to the existing
   `setSourceCounter`/`claimSourceCounter` (`presets.js:177-181`,
   `index.html:1418-1430`) — no new backend logic needed, this is
   exposing what already exists.
3. **Clear button**: remove from the header entirely. Add it ONLY
   inside the naming card (visible only when a naming preset with
   fields is active). Its only job is resetting field selections/typed
   values back to blank/unset — it must NOT touch
   `{sourcecounter}`/numbering, which keeps advancing regardless. When
   no naming preset is active, there is no Clear button anywhere.
4. **Copy & Verify relocation**: remove from the header. Place it
   centered below the naming card when one is open, centered below the
   three-column Sources/Volumes/Destination area when no preset is
   active (i.e. it needs to reposition based on whether the card is
   showing). Slightly larger than its current header size.
5. **Preserve the suspend-toggle**: whatever currently lets a user
   temporarily disable naming without losing the preset selection must
   keep working after this resize — test it explicitly, don't assume it
   survives untouched.
6. **Transfers panel**: change Progress and Log from stacked to
   side-by-side (two columns), still inside the existing collapsible
   "Transfers" section at the bottom of the window — no new panel, no
   new tab, same collapse/expand and Clear/Detach controls it has today.

## Verification

Start a job with no naming preset active — confirm Copy & Verify sits
centered below the three columns, no Clear button anywhere, header has
only Refresh/Settings. Select a naming preset with fields — confirm a
compact card appears that does NOT cover the Destination drop zone, with
Copy & Verify now centered below the card instead, and a Clear button
inside the card. Click Clear — confirm field selections reset but the
Card #/`{sourcecounter}` value is untouched. Edit the Card # field
directly — confirm it changes what the next job's `{sourcecounter}`
renders as. Toggle naming off via the suspend-toggle — confirm the
preset selection itself isn't lost (re-enabling shows the same preset
still selected). Resize the main window — confirm the naming card still
doesn't overlap Destination at various widths. Confirm Transfers shows
Progress and Log as two side-by-side columns, not stacked.
