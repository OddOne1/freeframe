# Claude Code prompt — web: branding settings draft/preview before applying (§106)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §106 — read it first. This is `apps/web`. Run `npx vitest
run` for the whole app at the end.

## Current state (confirmed, don't re-investigate)

- `app/(dashboard)/settings/branding/page.tsx` — every control (name
  Save button `:332-345`, logo upload/remove `:226-243`, favicon
  upload/remove `:245-262`, every color swatch's `onChange`
  `:264-270`) calls straight through to `use-site-settings.ts`'s hook
  functions, which `api.patch`/upload immediately (`:33`, `:46-56`,
  `:57`, `:71`, `:84`, `:100`). `SiteSettings` is global/instance-wide
  — every change is live for every user the instant it's made.
- The "Preview" section (`:457-479`) currently derives `activeLogo`
  from the COMMITTED store values (`logoLightUrl`/`logoDarkUrl` from
  `useSiteSettings()`), not from anything staged — it's a mirror of
  what already saved, not a look-before-committing step.
- `useSiteSettings()` (`hooks/use-site-settings.ts:26-`) returns both
  the committed values and the update functions (`updateOrgName`,
  `uploadLogo`, `removeLogo`, `uploadFavicon`, `removeFavicon`,
  `updateThemeColors`, `resetThemeColors`, `resetAll`).

## Build

1. In `BrandingPage`, introduce local draft state seeded from the
   committed values on mount/whenever they change externally: draft
   org name, draft logo state per slot (`dark`/`light`/`login` — each
   either "unchanged", a picked `File`, or "removed"), draft favicon
   (same three states), draft theme colors (per theme, same shape as
   `themeColors`).
2. Rewire every control's `onChange`/`onClick` to write to draft state
   only — no calls to `updateOrgName`/`uploadLogo`/`removeLogo`/
   `uploadFavicon`/`removeFavicon`/`updateThemeColors` from these
   handlers anymore.
3. For picked logo/favicon files: do NOT upload on pick. Hold the
   `File` in draft state, create a preview via
   `URL.createObjectURL(file)`, and revoke the previous object URL
   whenever it's replaced or the component unmounts (avoid leaking
   blob URLs — track the current object URL in a ref or state so it
   can be revoked deterministically).
4. Preview section (`:457-479`): compute `activeLogo` (and the org
   name shown) from DRAFT state, not committed state, so it reflects
   whatever is currently staged, unsaved or not.
5. Add a page-level "Save changes" button, disabled/hidden when the
   draft equals the committed values (diff org name, per-slot
   logo/favicon state, and both themes' color objects). On click:
   - For each logo/favicon slot whose draft differs from committed:
     call the real `uploadLogo`/`removeLogo` or `uploadFavicon`/
     `removeFavicon`.
   - If org name changed, call `updateOrgName`.
   - If theme colors changed, call `updateThemeColors` for whichever
     theme(s) actually changed.
   - After all committed successfully, re-seed draft state from the
     now-updated committed values (so the "unsaved changes" indicator
     clears correctly).
6. Add a "Discard changes" action: resets draft state back to the
   current committed values, revokes any pending object URLs, no
   network calls.
7. "Reset to defaults" (`:481-495`, currently calls `resetAll()`
   immediately): change this to stage "clear everything" into the
   draft instead of calling `resetAll()` directly — it should flow
   through the same Save/Discard mechanism as any other edit, so a
   user can back out of a reset via Discard before it's committed.
   `resetAll()` itself only gets called from the Save flow now, when
   the draft represents "everything cleared."
8. Handle the case where a color `<input type="color">` fires many
   `onChange` events while dragging (some browsers do this) — since
   these now only update local draft state (cheap), this should be
   fine without additional debouncing, but confirm it doesn't cause
   visible jank in the preview section during a drag.

## Verification

Change name/logo/color without saving — confirm Preview reflects the
draft and confirm (via network tab or mocking `api.patch`/`uploadLogo`
etc.) that NO request fires. Navigate away and back (or reload) with
unsaved changes present — confirm the draft is gone and only the
still-unchanged committed values show; an abandoned draft must not
persist across navigation. Discard after changes — confirm the form
reverts and nothing was sent. Save — confirm exactly the
changed fields get PATCHed/uploaded. Confirm Reset to defaults now
stages rather than applies instantly and can be discarded before
taking effect. Confirm existing branding tests (if any — check for a
`branding` test file) still pass, and extend coverage for the new
draft/save/discard behavior specifically. Run `npx vitest run` for the
whole app at the end — report pass/fail counts, flag anything not
already a documented pre-existing failure.
