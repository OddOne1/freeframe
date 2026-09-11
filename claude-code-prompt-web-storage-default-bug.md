# Claude Code prompt — storage-limit default bug (200GB not reliably applying)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §37 — read it first, root cause already fully traced.

## Root cause (already found, don't re-investigate)

`apps/api/models/user.py:34`, `storage_limit_bytes`, has no Python-side
default. The 200GB default only exists as a DB-level `server_default`
added by the migration `apps/api/alembic/versions/add_user_global_role.py:35-38`.
All 4 user-creation paths (`routers/auth.py:63`, `routers/auth.py:194`,
`routers/users.py:131`, `routers/setup.py:113`) rely on that
server_default firing rather than setting the value themselves. A real
user (`info@tobiashuber.it`, created 2026-08-18) has a NULL
`storage_limit_bytes` — the server_default did not apply for that
INSERT. This is confirmed NOT a frontend bug — `settings/admin/page.tsx`'s
`UserStorageLimit` component correctly renders NULL as "Currently
unlimited"; the stored value really is NULL.

## Fix

1. Add the 200GB default directly on the SQLAlchemy model in
   `apps/api/models/user.py` (Python-side `default=` and/or
   `server_default=` on the `storage_limit_bytes` column) — don't rely
   solely on the migration's schema-level default, since it
   demonstrably didn't apply for at least one real row and there's no
   way to audit from code alone why. Belt-and-suspenders: guarantee this
   at the model layer so every future INSERT gets it regardless of
   migration history or which code path creates the row.
2. Add a real test (against actual Postgres, not a `MagicMock` DB like
   `test_admin_user_storage_limit.py` currently uses) that creates a
   `User` through each of the 4 creation code paths and asserts
   `storage_limit_bytes == 200 * 1024**3`. This is the gap that let the
   bug ship unnoticed — close it, don't just fix the symptom.
3. Once the fix is verified, remove the "200 GB default" helper text in
   `apps/web/app/(dashboard)/settings/admin/page.tsx` (`:838-844`, and
   the `DEFAULT_USER_STORAGE_GB` constant at `:771` if nothing else
   uses it) — the storage field will now correctly read "Currently 200
   GB" on its own; the secondary hint becomes redundant rather than
   informative.

## Explicitly out of scope for this commit

Existing rows already NULL (including `info@tobiashuber.it`) are NOT
retroactively fixed by this change — a code fix doesn't rewrite
existing data. Say this plainly in your report. The user will handle
correcting that specific row separately (either a manual DB update or
using the existing admin PATCH UI once this ships).

## Verification

Run the new creation-path tests against real Postgres and confirm all
4 paths produce 200GB. Confirm the admin Settings page no longer shows
"200 GB default" text anywhere. Confirm an admin can still explicitly
set a user to unlimited via the existing PATCH flow (this fix should
only affect the *default* at creation time, not remove the ability to
set NULL/unlimited deliberately afterward).
