# Claude Code prompt — fix asset-card version badge: persistent + repositioned

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Small, targeted
fix to the badge shipped in the notifications work (commit 142e46c).
This is `apps/web`.

## Confirmed current bug (two issues, same component)

`components/projects/asset-card.tsx:180-194`:

```tsx
{asset.has_unseen_version && versionCount > 1 && (
  <span
    data-testid="unseen-version-badge"
    title={`New version (v${versionCount}) you have not opened yet`}
    className="absolute left-2 top-2 inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5 text-2xs font-semibold text-accent-foreground shadow-sm"
  >
    V{versionCount} · New Version
  </span>
)}
```

1. **Positioned top-left** (`absolute left-2 top-2`), same strip as the
   star rating (`top-2 right-2`, lines 162-178). On narrower cards the
   wide "V3 · New Version" text crowds/clips against the rating chip.
   User wants it at the bottom of the thumbnail instead.
2. **Disappears entirely once seen** — the whole `<span>` is gated on
   `asset.has_unseen_version`, so once a user opens the asset and
   `asset_views` marks it seen, there's no version indicator left on
   the card at all. User needs the plain version number to stay
   visible always (when `versionCount > 1`), with only the "New
   Version" emphasis (extra text, distinct styling/size) being
   conditional on unseen state. This was the original intent — a
   single badge that's small/plain when seen and bigger/labeled when
   unseen — not an all-or-nothing render; fix it to match that.

## Fix

1. Make it one persistent element, not a conditionally-mounted one:
   render whenever `versionCount > 1`, showing plain `V{versionCount}`
   by default. When `asset.has_unseen_version` is true, expand the same
   element to include `· New Version` and switch to the accent/bigger
   styling currently used — same size-varies-by-state approach as
   originally scoped, not two different components.
2. Move it to the bottom of the thumbnail. Check what's already there:
   duration badge is `absolute bottom-2 right-2` (~line 199), comment
   count is `absolute bottom-2 left-2` (~line 205). Decide a layout that
   fits all three without collision or clipping — options in rough
   preference order: (a) put the version chip in the same bottom-left
   corner as comment count, stacked or inline separated by a visual
   divider, since both are "read more inside" metadata, versus duration
   which is more like a title-bar fact; (b) a full-width thin bar along
   the bottom edge if three separate corner chips get too cramped on
   small card sizes (check the XS grid density mode, since this project
   supports multiple card sizes). Use your judgment on which reads
   cleanly at the smallest supported card size — that's the constraint
   that matters most here, not desktop/large cards.
3. Confirm the star-rating position (top-right) is untouched — this fix
   is about the version badge only.

## Verification

Manual, real browser — check appearance at every supported grid density
(XS/S/M/L, per the grid-size toggle) with: an asset that has multiple
versions and unseen state, an asset with multiple versions already
seen, and a single-version asset (badge should not render at all in
that case, confirm `versionCount > 1` guard still holds). Confirm the
"New Version" text is never clipped, confirm the plain version number
remains visible after opening the asset once. Run `npx vitest run` at
the end — report pass/fail counts, flag anything not already a
documented pre-existing failure.
