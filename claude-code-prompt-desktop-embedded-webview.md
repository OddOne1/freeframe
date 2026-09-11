# Claude Code prompt — desktop: second page, embedded live FreeFrame web view with SSO

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §60b (desktop) — read it first. This is the bigger of the
two §60 items — build `claude-code-prompt-desktop-hide-items-settings.md`
first or independently, no dependency either direction.

## Current state (confirmed, don't re-investigate)

**SSO is genuinely feasible — both auth systems already share the
same shape against the same backend:**
- Desktop: `apps/desktop/src/main/freeframe.js` stores
  `accessToken`/`refreshToken` from `POST /auth/login`
  (`:169-177`), refreshes via `POST /auth/refresh` with
  `refresh_token` in the body (`:121, 141-142`), persisted via
  Electron's `safeStorage` (OS keychain-backed, `:16, 40, 54, 56`).
- Web: `apps/web/lib/auth.ts` stores the SAME token shape —
  `ff_access_token`/`ff_refresh_token` — in `localStorage`, plus
  matching cookies set by `setTokens()` (`:16-23`), refreshed via the
  identical `POST /auth/refresh` endpoint.
- This means: the desktop app can hand its already-stored tokens to
  an embedded view of the real web app, and the web app's own
  client-side auth check will find a valid session — no second login
  flow to build.

## Build

1. **Page/mode switcher**: add a toggle in the main window between
   today's existing copy-tool view ("Offload") and a new "FreeFrame"
   page. Check the app's existing header/control-row structure
   before picking where this lives — match the existing style, don't
   invent a new control pattern.
2. **Embedded view**: host an Electron `<webview>` (or `BrowserView`
   swapped into the window — pick whichever fits this Electron
   version/app's existing window architecture better, and say which
   you chose and why in the build report) pointed at the production
   web app URL. Find wherever this app already stores/configures its
   API base URL (near `freeframe.js`'s `baseUrl` handling) and derive
   the web app's URL from the same source rather than hardcoding a
   second copy of it.
3. **Token injection for SSO**: before or immediately after the
   embedded view loads (a `did-finish-load`-equivalent event), inject
   the desktop app's currently-stored `accessToken`/`refreshToken`
   into the embedded view's `localStorage` under the EXACT keys
   `apps/web/lib/auth.ts` expects (`ff_access_token`,
   `ff_refresh_token`), and set the matching cookies the same way
   `setTokens()` does (`path=/`, appropriate `max-age`, `SameSite=Lax`)
   so the web app's own middleware/client auth check passes
   immediately. If the desktop app has no stored token (user never
   logged in for project-browsing), let the embedded view load its
   own login page normally — do not build a second login UI.
4. **Logout behavior**: decide and document explicitly whether
   logging out from inside the embedded web view should also clear
   the desktop app's own stored token (keeping both in sync) or
   whether they're allowed to diverge (user stays logged into the
   copy-tool's project-browsing but logged out of the full web view,
   or vice versa) — pick one, state the reasoning in the build
   report, don't leave this as an unconsidered side effect.
5. **State persistence across page switches**: switching from
   FreeFrame back to Offload and back again should not force a full
   reload/re-login of the embedded view each time, unless there's a
   concrete reason it must (e.g. memory reclamation for a
   long-backgrounded view) — state which behavior you built and why.

## Verification

With the desktop app already logged in via the existing
project-browsing flow, switch to the FreeFrame page — confirm it
loads directly into the signed-in web app, no login prompt shown.
With no prior login, switch to FreeFrame — confirm the web app's own
login page appears normally, and logging in there works. Log out from
wherever the desktop app's logout lives — confirm the FreeFrame
page's behavior matches whatever was decided in step 4, and that
behavior is documented in the build report. Switch Offload → FreeFrame
→ Offload → FreeFrame — confirm the embedded view doesn't unnecessarily
reload/re-authenticate on every switch.
