# Claude Code prompt — desktop: remove the redundant naming-panel "Hide" button

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §70 — read it first.

## Current state (confirmed, don't re-investigate)

- `#fields-collapse` (`index.html:938`, "Hide the naming fields panel")
  → `on("fields-collapse", "click", () => setFieldsPanel(true))`
  (`:3062`).
- `setFieldsPanel`/`fieldsPanelHidden` (`:3374-3377`) only toggle
  display — confirmed no interaction with required-field validation.
  Whatever gates Copy & Verify on missing required fields
  (`missingRequired()`) is completely unaffected by this flag.
- The header preset-pill toggle (§62/§65 closeout) already fully
  suspends naming — clearing `activePresetId` removes both the panel
  AND the requirement together, correctly.

## Build

Remove entirely: `#fields-collapse` (markup), its click wiring
(`:3062`), `setFieldsPanel`, `fieldsPanelHidden`, and
`applyFieldsPanelVisibility` if nothing else references it — check
before deleting. The naming card should always be visible whenever a
preset with fields is active; there is no longer a way to visually hide
it while leaving it functionally active. The ONLY way to make it go
away is the existing header toggle.

## Verification

With a naming preset active, confirm there's no "Hide" control on the
card anymore. Confirm the card stays visible at all times a preset with
fields is active. Confirm the header toggle still fully suspends naming
(card disappears AND required fields are no longer enforced) — this
path must be completely unaffected by the removal.
