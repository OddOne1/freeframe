# Claude Code prompt — superadmin system heartbeat dashboard (view-only)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Touches
`apps/api` and `apps/web`. Queued behind the Celery lost-task-recovery
fix and the processing-progress/panel fix — those two land first, since
this dashboard's Celery section is more useful once that work is in.
Run backend tests and `npx vitest run` at the end.

**Explicitly decided, don't relitigate:** no restart capability, no
Docker socket access, no host-level helper process. This is read-only
status reporting via each service's own existing protocol — the API
already has network access to Redis, Postgres, and S3, so nothing new
needs to be granted for this to work.

## What to check confirmed available (don't re-investigate)

- **Celery workers** (`worker`, `email_worker`, `beat`, `transcribe_worker`):
  the API already imports/can import the Celery app
  (`apps.api.tasks.celery_app`). `celery_app.control.inspect().stats()`
  and `.ping()` give per-node uptime, pool concurrency, and liveness —
  confirmed working live via manual `celery inspect` during debugging
  this session, talks over the existing Redis broker connection, no
  Docker access involved. `beat` doesn't respond to worker-style
  inspect calls (it's a scheduler, not a worker) — check what signal is
  reasonable for it instead (e.g. whether its last scheduled tick
  timestamp is queryable, or whether liveness is the only thing worth
  reporting for it).
- **Postgres**: `SELECT pg_postmaster_start_time()` gives real uptime;
  the existing DB session/engine already used everywhere is sufficient,
  no new connection needed.
- **Redis**: `INFO server`'s `uptime_in_seconds` field, via the redis
  client already in use for Celery's broker/pub-sub.
- **S3/MinIO**: reuse the existing presigned/probe S3 client pattern
  (`_get_probe_client()` per project convention — check
  `apps/api/services/s3_service.py`) with a cheap call like
  `head_bucket` to confirm reachability; don't build a new S3 client
  path for this.
- **api/web**: `api` can trivially report its own process uptime.
  `web`'s health is more naturally reported from the browser side (it's
  rendering the page you're looking at) or skipped as "implicitly
  healthy if this page loaded" — use your judgment, don't over-build
  this one.

## Build

1. A new admin-only endpoint (e.g. `GET /admin/system-health`) that
   gathers the above into one response: per-service name, status
   (healthy / degraded / unreachable — pick clear tiers), uptime where
   available, and any error detail available cheaply (e.g. a caught
   exception message from a failed check, not a full log tail — this is
   a status dashboard, not a log viewer). Time-box each check with a
   short timeout so one hung dependency (e.g. Redis unreachable) doesn't
   make the whole endpoint hang — degrade that one entry to
   "unreachable" and still return the rest.
2. **This gets its own dedicated settings destination, not a section
   crammed into the existing admin page.** Check the current Settings
   sidebar/nav structure (how Users/Projects/Email/LUTs/Admin are
   currently listed as distinct entries — likely
   `apps/web/app/(dashboard)/settings/` has a nav component listing each
   as its own route/page) and add "System Health" (or similar clear
   label) as its own top-level entry in that same nav, superadmin-gated
   the same way the existing Admin entry is, with its own route (e.g.
   `settings/system-health/page.tsx`) — not a collapsible subsection
   inside `settings/admin/page.tsx`. It should be immediately visible
   and findable in the settings nav, not something a superadmin has to
   know to scroll for inside another page. Position it directly below
   the existing "Admin" and "Branding" nav rows, styled identically to
   every other entry in that nav list — same row height, spacing,
   icon-plus-label pattern, not a visually distinct or demoted entry. Reuse `CollapsibleSection`
   only for grouping content WITHIN this new page (e.g. grouping Celery
   services vs. data stores vs. storage), not as the mechanism for
   attaching it to an existing page.
3. Auto-refresh at a reasonable interval (e.g. every 30-60s) rather
   than requiring a manual reload, since the whole point is a live
   heartbeat — but don't hammer the endpoint faster than the checks
   themselves are cheap to run.
4. Surface the Celery `processing_status = processing` stale-task count
   (from the sweeper built in the lost-task-recovery fix, if that's
   landed by the time this is built) as one of the heartbeat's data
   points — it's exactly the kind of thing this dashboard exists to
   surface, and ties the two prompts together naturally.

## Verification

Manual, real environment: load the dashboard while everything is
healthy, confirm all services report correctly with plausible uptimes.
If feasible, deliberately make one dependency briefly unreachable (e.g.
a bad Redis call) and confirm the dashboard degrades that one entry
gracefully rather than the whole page erroring. Confirm this is
superadmin-gated, not visible to regular users or project admins. Run
backend tests and `npx vitest run` for the whole web app at the end —
report pass/fail counts, flag anything not already a documented
pre-existing failure.
