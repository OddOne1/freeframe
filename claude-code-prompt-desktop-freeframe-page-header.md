# Claude Code prompt — desktop: FreeFrame page header scoping + login moves into Settings

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §64 (desktop) — read it first, including the addendum at
the bottom about login-gating the FreeFrame tab itself.

## Current state (confirmed, don't re-investigate)

- `#refresh`'s handler (`index.html`, `refresh()` near `:2716`) only
  calls `window.freeframe.listVolumes()` — no FreeFrame-page
  awareness.
- `setPage()` (`:3960-3977`) toggles a `page-web` body class that
  only hides `.workspace`/`#jobs-panel`/`#progress` (CSS at
  `index.html:71-73`). `#settings-btn`, `#clear`, `#start` (Copy &
  Verify) stay visible and clickable on the FreeFrame page today.
- `#account` (`index.html:886`, "Sign in to FreeFrame") is the only
  login entry point, opens `openLogin()`/`#login-backdrop`.
- **Confirmed: one login already serves both surfaces.**
  `refreshAccount()` drives Offload's project-browsing;
  `main.js:380-387` (`webview:show` handler) calls
  `freeframe.webSession()` — reading the SAME stored session — to
  inject SSO tokens into the embedded FreeFrame webview. No new auth
  plumbing needed for the relocation.

## Build

0. **Login-gate the FreeFrame tab itself.** Confirmed not built yet:
   `#page-offload`/`#page-freeframe` (`index.html:869-870`) render
   unconditionally regardless of `ffStatus.loggedIn` (`:1228`), and
   `setPage()`'s click wiring (`:3980-3981`) has no login check. Hide
   the `#page-freeframe` tab entirely while `ffStatus.loggedIn` is
   false; show it once login succeeds. Drive this off the same
   `ffStatus` refresh that already updates the account button's label
   (near `:3618-3621`) — one source of truth, not a second check.
   Keep the existing logout behavior as-is: logging out while already
   on the FreeFrame page already switches back to Offload
   automatically (`:3663-3669`) — don't rebuild this, just make sure
   it still fires correctly once the tab itself becomes hide-able.
1. **Refresh works on the FreeFrame page too**: when that page is
   active, `#refresh`'s click should also reload the embedded
   webview. Find whatever reload capability `main.js`'s `webview:show`
   handler / `webview.js` (§60b) already exposes and call that,
   rather than building a new one.
2. **Hide Offload-only header buttons on the FreeFrame page**: extend
   `page-web`'s CSS/logic so `#settings-btn`, `#clear`, and `#start`
   are hidden while that class is active — not just `.workspace`/
   `#jobs-panel`/`#progress` as today.
3. **Move login into Settings, delete the header button**: relocate
   the existing login modal/trigger (`openLogin()`/`#login-backdrop`)
   into a tab inside the Settings window (General, or its own tab —
   pick whichever reads better once built). Delete `#account` from
   `index.html`'s header entirely. No changes needed to
   `freeframe.js`'s login/token logic — this is a UI relocation only.

## Verification

While logged out, confirm the FreeFrame tab is not visible at all —
not disabled, not present. Log in via Settings — confirm the tab
appears and switching to it loads the signed-in embedded view
directly. Log out while on the FreeFrame page — confirm it switches
back to Offload and the tab disappears again. Switch to the FreeFrame page — Settings, Clear, and Copy & Verify
are gone from the header; Refresh remains and now reloads the
embedded view (confirm it actually reloads, not just re-lists
Offload volumes silently). Switch back to Offload — all three
buttons reappear, Refresh goes back to refreshing volumes. Log in via
the relocated Settings control — confirm BOTH Offload's
project-browsing AND the FreeFrame embedded page show signed-in state
with no second login prompt anywhere. Confirm `#account` no longer
exists in the header.
