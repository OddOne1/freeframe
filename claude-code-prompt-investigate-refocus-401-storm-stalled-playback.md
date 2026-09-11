# Claude Code prompt — investigate: 401 storm across two projects,
stalled HLS segments, sticky play/pause, and general intermittent
slowness that survives a hard reload

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is an
INVESTIGATE prompt, not a guessed fix — get a real repro and read the
actual code paths before proposing a fix. Do not present a code-reading
guess as a confirmed root cause; if you're not sure, say so and what
would confirm it.

**This is currently blocking a deploy.** There's a finished, unpushed
build from an earlier round sitting ready to ship — it's being held
back specifically until this is understood/fixed. Treat this as the
priority item, not a nice-to-have investigation.

## Second, broader symptom — general intermittent slowness (likely same root cause, wider trigger)

Independent of the specific incognito/share-link repro below, the app
"every now and then" goes generally slow — described as: the whole tab
freezes briefly, the UI itself feels laggy (clicks/scroll/play-pause
lag even before any network call would matter), and data takes a while
to load. **No corresponding CPU spike on the server** during these
episodes — whatever's happening, it isn't the backend doing expensive
work.

The critical diagnostic detail: **a hard browser refresh (Cmd+R) on
the clip/asset page you're currently on does NOT fix it. Navigating to
the homepage does.** A hard reload re-runs all JS from scratch and
re-fetches the document — so whatever's wrong survives that, which
rules out plain in-memory JS state (a stuck variable, a runaway timer,
an in-flight promise) as the sole cause. What survives a hard reload on
the same URL: `localStorage`/cookie-persisted state (an auth token,
a persisted client store), or a service worker serving stale/cached
responses for that specific route. Going to the homepage first —
a different route — apparently avoids or resets whatever that is,
after which going back into a clip works fine again.

This is a strong candidate for being the **same root cause** as the
401-storm-after-refocus bug documented below, just triggered more
generally (e.g. by a token nearing/past its natural expiry during
normal use) rather than only after backgrounding the tab. Investigate
both together — don't treat them as unrelated unless you find evidence
they are. Specifically check:

- Is there a service worker registered for `apps/web`? If so, what's
  its caching strategy, and does a hard reload on a client-side-routed
  URL actually bypass it, or does the SW intercept the navigation
  request regardless of cache-busting headers the browser sends on
  Cmd+R?
- What auth/session state lives in `localStorage`, cookies, or a
  persisted client store (e.g. Zustand `persist` middleware) that a
  hard reload would rehydrate as-is rather than reset? If a stale or
  invalid token is persisted there, reloading the same page just
  reloads the same broken token — explaining why reload-in-place
  doesn't help. Does the homepage route perform some check/refresh on
  load that the clip page doesn't (or does the clip page's own
  data-fetching hang/retry on the bad token in a way that never gets a
  chance to resolve, while the homepage's simpler data needs succeed
  and that success is what fixes the persisted state)?
- Whatever mechanism explains "frozen tab + laggy UI + slow data,
  no server CPU spike" — that symptom shape (client busy or blocked,
  server idle) points at the client stuck retrying, polling, or
  waiting on something that never resolves (a hung fetch, a stuck SSE
  reconnect loop, a retry loop with no backoff) rather than the server
  being slow to respond. Look for retry loops without backoff or
  without a max-attempts cutoff anywhere in the data-fetching or
  SSE-reconnect code.

## Exact repro sequence, from the live session that produced this

1. Opened `https://frame.yon.studio/projects/cacb63bf-75ff-4dfe-9b24-657eb3b684e1/assets/b91242e5-a167-45b0-bb1f-accef468fec2` (asset page, authenticated).
2. Hit play, scrubbed to a timecode, left a comment as the logged-in user.
3. Created a share link for the asset (`Share` button).
4. Opened a **separate incognito window**, pasted the share link, viewed
   it as an anonymous guest — this is where the already-documented
   `guest_name.charAt` crash reproduces (see
   `claude-code-prompt-share-link-guest-name-crash-and-double-api-thumbnail.md`,
   separate issue, already filed).
5. Closed the incognito window, returned to the original authenticated
   tab (which had sat backgrounded/inactive the whole time step 4 was
   happening).
6. Hit play/pause a few times in that tab — both felt noticeably slow
   to respond.
7. Opened DevTools console to see why — found the error pile described
   below.

The sluggish play/pause and the console/network errors were observed
**after refocusing this tab**, not during continuous foreground use.
That's the detail to preserve in any repro attempt — backgrounding the
tab (even via opening a new window, not just switching apps/tabs) for
the few minutes it takes to do steps 3–5, then coming back, appears to
be what triggers this.

## Confirmed evidence, from live screenshots — not a guess

**1. 401s across two different, unrelated project IDs in the same burst.**

The tab was only ever on project `cacb63bf-75ff-4dfe-9b24-657eb3b684e1`
(the Riverside Test project from the repro). But the console shows
repeated 401s for a *second* project's full data tree:
`0b8b044b-862f-463e-880e-31c3a9d67bfb` — `/folder-tree`, `/members`,
`/share-links`, `/luts`, `/metadata-fields`, `/assets`, `/trash`,
`/folders?parent_id=root`, `/assets?folder_id=root`, plus the project
object itself. Also present, same burst: `/api/projects` (list) and
`/api/users?ids=...` calls, all 401.

Endpoints for the *actual* current project (`cacb63bf...`) are also
401ing in the same burst: `/share-links`, `/assets`, `/folder-tree`,
`/luts`, `/members`, `/metadata-fields`, the project itself,
`/assets/{id}/transcript`, `/assets/{id}/metadata`.

Some of these same URL sets appear to fire **twice** in immediate
succession in the log (visible duplication of the same
`0b8b044b.../folder-tree`, `/members`, `/share-links` etc. requests).

Find out:
- Where does `0b8b044b-862f-463e-880e-31c3a9d67bfb` come from — is it
  a project the user has access to but never navigated to in this
  session? Check if there's a background poll (project list refresh,
  notifications, a "recent projects" prefetch, or something tied to
  the share-link creation flow) that fetches full detail for a project
  other than the one currently open. This should not happen regardless
  of the 401s — fetching another project's entire data tree from an
  asset page for one specific other project is the more interesting
  bug here, independent of why it 401'd.
- Why do some request sets appear to fire twice — is something
  double-mounting a data-fetching hook/effect (e.g. on visibility
  change firing twice, or a retry-on-401 path that re-issues the exact
  same request set instead of a targeted retry)?
- What auth token is used for these requests — check the app's token
  refresh logic (wherever `apps/web` handles access token expiry —
  refresh-on-401 interceptor, a scheduled refresh timer, etc.). Does
  refresh happen on `visibilitychange`/tab focus, or only lazily on the
  next request? If a token expired while the tab was backgrounded and
  nothing proactively refreshed it on focus, the first wave of
  requests after refocus would all use a stale token and 401
  simultaneously — check whether that's actually what's happening, and
  whether there's then a *correct* automatic retry after refresh (there
  should be, if the pattern is meant to be resilient) or whether the
  user is just left with a broken page until manual reload.

**2. Double `/api/api` thumbnail 404, cached client-side for 4 hours.**

```
GET https://frame.yon.studio/api/api/stream/hls/thumbnail.jpg?token=...
Status: 404
Source: Disk Cache
Cache-Control: max-age=14400
Content-Type: application/json
Content-Length: 22
```

The double-`/api` prefix itself is the already-filed #139 (see the
other prompt file). The new finding here: the 404 response carries
`Cache-Control: max-age=14400` (4 hours) and the browser is honoring it
— `Source: Disk Cache` on a repeat load. That means once #139 is fixed
server-side, any browser that already hit the broken URL keeps
replaying the cached 404 from local disk cache for up to 4 hours,
independent of the server fix. Find where this response's cache
headers get set (a global middleware/reverse-proxy setting
`Cache-Control` on all responses regardless of status? An explicit
setting on the thumbnail endpoint that doesn't account for error
paths?) and fix it so 4xx/5xx responses are never cache-control'd as
cacheable — `no-store` or `no-cache` on error responses is the correct
default here, not inherited from whatever the success-path caching
policy is.

**3. HLS segment requests stuck with no status and no response.**

Example, from the Network tab:

```
GET https://frame.yon.studio/api/stream/hls/1/seg_069.ts?token=...
Status: —
Source: —
Response: No response headers
```

Same pattern on `seg_067.ts` for a different rendition (`/hls/0/`).
Not a 404, not a 5xx — the browser shows no status at all, meaning
either the request never got a response or DevTools captured it
mid-flight with no resolution. Check:
- Does the video player (whatever HLS client is in use — hls.js or
  native) ever recover from this, or does the buffer just stall
  waiting on a segment that never arrives, which would directly
  explain "play/pause feels sticky" — a stuck buffer means play/pause
  UI state and actual playback state are out of sync.
- Is there a fetch/XHR timeout configured for segment requests at all?
  If not, a segment request that started while the tab was
  backgrounded and got stalled by Safari's background-tab network
  deprioritization would sit forever with no timeout to abandon and
  retry it.
- Does the player abandon and re-request stale in-flight segments on
  visibility change (tab regaining focus), or just leave them hanging?

**4. `/events` (SSE) connection dropped, "The network connection was lost."**

```
GET https://frame.yon.studio/api/events/{project_id}?token=...
Failed to load resource: The network connection was lost.
```

Seen for both project IDs. This is presumably the real-time
update channel (comments, status changes, etc.). Check:
- Does the client auto-reconnect this EventSource/SSE connection after
  a drop, and does reconnection re-authenticate with a fresh token
  (relevant given point 1 above), or does it retry with the same
  now-possibly-stale token and just fail again silently?
- Is there any user-visible indication when this channel is down (e.g.
  comments/notifications going stale without the user knowing), or
  does it fail silently — which would be its own bug worth flagging
  even if out of scope for this fix.

## What to actually check, in order

0. Check whether `apps/web` registers a service worker at all (search
   for `serviceWorker`, `next-pwa`, or similar). If yes, inspect its
   caching strategy for API calls and for the app shell/route bundles,
   and confirm whether a hard reload on a given URL actually forces it
   to bypass cache (`skipWaiting`/`clients.claim` behavior, or a
   `Cache-Control: no-cache` set on navigation requests) or not. Also
   inventory what's kept in `localStorage`/cookies for auth (access
   token, refresh token, expiry) and any persisted client store, and
   check whether any of it could go stale/invalid in a way that a page
   reload wouldn't clear but a navigation to a different route would
   (e.g. the homepage triggering a refresh-token call that the clip
   page's code path doesn't).
1. Reproduce the exact sequence above (open asset page authenticated →
   play → comment → create share link → open share link in a new
   incognito window → close it → return to original tab → play/pause)
   in both Safari and Chrome, with DevTools Network tab recording from
   before backgrounding starts. Confirm whether this reproduces
   reliably, and whether it's Safari-specific (Safari is known to
   aggressively throttle/defer network activity and timers in
   backgrounded tabs and windows) or happens in Chrome too — that
   determines whether this is primarily a client resilience issue
   (needs to handle any browser's background throttling gracefully) or
   something narrower.
2. Read the token refresh implementation in `apps/web` — find where
   401s are intercepted/retried and where token refresh is scheduled,
   and check it against what you observe in the repro.
3. Find where the `0b8b044b...` second-project fetch is triggered from
   — grep for that pattern of calls (folder-tree + members + luts +
   metadata-fields + assets + trash all fetched together) to find the
   shared data-loading hook, then trace what triggers it for a project
   the user never opened.
4. Check the HLS/video player's handling of stalled segment requests
   and tab visibility changes.
5. Check the SSE/`/events` client's reconnect-with-fresh-token
   behavior.
6. Fix the Cache-Control-on-error-responses issue (item 2 above) —
   this one's unambiguous, no further investigation needed, just fix
   it.

Do not propose fixes for items 1, 3, or 4 until you have a real repro
and have actually read the relevant code — report back what you find
first if the cause turns out to be different from what's hypothesized
above.

- Try to reproduce the general slowness independent of the
  incognito/share-link sequence: leave a clip page open and idle (not
  backgrounded, just sitting) long enough for an access token to
  approach/pass its normal expiry (check the token's actual TTL in the
  auth code rather than guessing a wait time), then interact with it
  and check for the same frozen-tab/laggy-UI symptoms and the same
  no-server-CPU-spike signature. Then test: does Cmd+R on that same
  clip URL fix it? Does navigating to the homepage and back fix it?
  This isolates whether time-based token expiry alone (no backgrounding
  needed) reproduces the broader symptom.

## Verification

- Reproduce the exact sequence in a fresh browser profile with Network
  tab recording, confirm you can see the same 401 burst / stalled
  segments / dropped SSE connection.
- After whatever fix is applied, run the same sequence again and
  confirm: no 401s on refocus, no fetch of any project other than the
  one open, HLS segments resolve normally after tab refocus, SSE
  reconnects and stays connected, play/pause responds immediately.
- Also re-test the general-slowness repro (idle-until-near-expiry, then
  interact) and confirm a hard reload on the clip page now actually
  fixes it, not just navigating home first — that's the sign the real
  persisted-state/service-worker cause was found and fixed, not just
  the incognito-specific trigger.
- Confirm the Cache-Control fix by checking response headers on a
  deliberately-triggered 4xx from the API — should be `no-store` or
  equivalent, not `max-age=...`.

Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.

## CONFIRMED by controlled repro (2026-09-08, Claude's own browser session)

Two things below are no longer hypotheses — both were reproduced directly
in a live browser session against production, with full network traces,
and then cleaned up (fetch/XHR patches removed; the corrupted token was
never restored, so this session is simply logged out now, no other
impact — it was an isolated browser session, not the user's real
device).

**Confirmed: the 401-burst-then-recover mechanism is real and self-heals
fast when the refresh call succeeds.** Corrupting the access token in
`localStorage`/cookies and dispatching a `focus`/`visibilitychange`
event produced this exact real trace: 9 endpoints (`project`,
`members`, `metadata-fields`, `assets`, `luts`, `folder-tree`, asset
`metadata`, `users`, `transcript`, `share-links`) all 401 in the same
tick, followed by one `POST /api/auth/refresh → 200`, followed by all 9
being automatically retried and returning 200. Total recovery time was
sub-second. So: the 401 burst itself, when refresh succeeds, is noisy
in the console but not actually a user-facing problem — it resolves
before a person would notice.

**Confirmed: `_doRefresh`'s `catch { clearTokens() }` treats an
unreachable refresh endpoint as a rejected refresh.** Same corrupted
access token, but this time `/api/auth/refresh` was made to fail with a
network-level error (not a 4xx response — genuinely unreachable, via a
patched `fetch`/`XMLHttpRequest` that throws instead of completing).
Result: the tab was redirected to `/login`, and both `ff_access_token`
and `ff_refresh_token` were wiped from `localStorage` and cookies —
including the refresh token, which had ~7 days of validity left. This
is exactly the bug flagged as "[Likely, not confirmed]" in the last
round — it's now confirmed, not likely.

**What this does NOT confirm:** the original user-reported symptom was
general slowness (frozen tab, laggy UI, slow data) that a hard reload
didn't fix but the homepage did — with no mention of being bounced to
a login screen. This confirmed bug produces a hard logout + redirect to
`/login`, not silent slowness. So while this is a real, serious,
independently-worth-fixing bug (a network blip during refresh should
never destroy a valid session), don't assume without further evidence
that it's *the* explanation for the original slowness report — it may
be a second, related-but-distinct bug. Fix it regardless of that open
question; the fix (scope `clearTokens()` to only 401/403 responses from
the refresh endpoint itself, not network errors or 5xx — leave tokens
alone and back off/retry on those) stands on its own merits.

**Still not reproduced/explained by any of this:** the second,
unrelated project (`0b8b044b-862f-463e-880e-31c3a9d67bfb`) being
fetched in the original incident. The controlled repro above only ever
touched the current project's endpoints — no second project appeared.
That mystery is unchanged; keep investigating it separately, still
without guessing.

## Decision (2026-09-08): user wants both fixes before deploying anything

`git status` shows the no-store fix is sitting **uncommitted**
(`apps/api/middleware/no_cache_errors.py` untracked, `apps/api/main.py`
modified, not staged) — `main` is still at `e889ebe`, nothing from
today has reached GitHub. The user was asked directly whether to (a)
ship `e889ebe` now with none of today's fixes, (b) commit just the
no-store fix first, or (c) wait for both the no-store fix and a scoped
token-refresh fix. They chose **(c) — wait for both.**

Do this now:

1. Commit and push the already-written, already-tested no-store fix
   (`apps/api/middleware/no_cache_errors.py` + the `main.py` wiring +
   its test file). No further work needed on this one, it's done.
2. Write the scoped `clearTokens()` fix: only clear tokens on a 401/403
   response from the refresh endpoint itself (an actual rejection).
   On a network error or 5xx from the refresh call, leave the tokens
   alone and back off/retry instead of destroying the session — this
   is now a CONFIRMED bug (see the "CONFIRMED by controlled repro"
   section above), not a hypothesis, so it should ship. Write tests
   that cover both branches: refresh endpoint returns 401/403 → tokens
   cleared (existing behavior preserved); refresh call fails at the
   network level → tokens preserved, no clear, some retry/backoff
   instead.
3. Run the full test suite, report pass/fail counts reconciled per
   assertion (not just exit code — this project has had hung workers
   silently report as passing before).
4. Report back before anyone pushes the "update the server" button —
   the user wants both fixes in before the next deploy, not just one.

Note for context: independent live testing (Claude, via its own
browser session against production) also retracted the earlier "second
unrelated project fetch = Next.js Link prefetch" theory — tested
directly from the asset page, no such prefetch fires there. That
theory only held from the Projects grid page, which isn't where the
original incident happened. Item 3 (the `0b8b044b` project) is back to
fully unresolved — don't rely on that explanation.
