# Claude Code prompt — Contact page: real form + admin config + 30-day count

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §47 — read it first.

## Current state (confirmed, don't re-investigate)

`apps/web/app/(dashboard)/settings/contact/page.tsx` is a static
directory of superadmins with `mailto:` links — not a form, nothing
submits anywhere. The only backend route touching Contact is
`GET /users/admins` (unrelated — just lists superadmins for that
directory). This is new feature work.

`apps/api/services/email_service.py`'s `EmailService.send_email(to_email,
subject, html_body, text_body=None)` already sends to any arbitrary
address via whichever provider is configured (SES/SMTP,
auto-detected) — reuse this directly for the send, don't build new
email plumbing.

No "count in the last N days" pattern exists anywhere in this codebase
today. Follow `ShareLinkActivity`'s shape
(`apps/api/models/share.py:183-196`) — a plain timestamped table with a
descending `created_at` index — for the new table.

## Build

1. **New model** (e.g. `ContactRequest`): sender (the authenticated
   user — this form lives inside logged-in Settings, no need to
   re-collect name/email), message body, `created_at`
   (`server_default=func.now()`, indexed descending like
   `ShareLinkActivity`), and which target email address it was
   actually sent to (so the 30-day count stays meaningful even if the
   target address changes later).
2. **Target email setting** — superadmin-configurable. Check where
   this app's other admin-configurable settings already live
   (`EmailSettings`/`SiteSettings` models) before adding a new table —
   prefer extending an existing settings model if one fits, only add a
   new one if neither does. No hardcoded default — until a superadmin
   sets it, the form should be visibly disabled ("not configured yet")
   rather than silently failing to deliver a message.
3. **`POST /contact` (or similar) endpoint**: requires an authenticated
   user, validates a target email is configured (400 if not), sends via
   `email_service.send_email()`, records a `ContactRequest` row on
   success, returns a clear result to the frontend either way.
4. **Frontend**: replace the static page with an actual form — a
   message textarea and a submit button, at minimum. Sender identity
   comes from the session, not re-entered. Keep the existing
   admin-directory list if it still adds value alongside the form, or
   drop it — your call, the user asked for the page to *also* be a
   working form, not necessarily for the directory to go away.
5. **Admin-only section, same page, superadmin-gated**:
   - An input to view/set the target email (PATCH to whatever settings
     model it lives on).
   - A count of `ContactRequest` rows created in the last 30 days
     (`created_at >= now() - interval '30 days'`).

## Verification

Submit a message as a regular (non-superadmin) user — confirm no admin
section is visible to them, the message sends to the currently
configured target, and a `ContactRequest` row is created. As
superadmin, change the target email and submit again — confirm the new
message goes to the new address. Seed a `ContactRequest` row with a
`created_at` older than 30 days and confirm the count excludes it.
Confirm submitting with no target email configured yet fails clearly
rather than silently.
