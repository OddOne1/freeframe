# Claude Code prompt — notifications: wire email preferences, add
new-version notification, add unseen-version badge

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Touches
`apps/api` and `apps/web`. Run backend tests and `npx vitest run` for
the whole web app at the end.

## Confirmed current state (don't re-investigate)

- **The email-preference UI is disconnected from the backend — this is
  the priority bug, fix it first.** `apps/web/app/(dashboard)/settings/notifications/page.tsx`
  (lines 8-63) offers real per-category controls — `general_comments`,
  `comment_replies`, `mentions`, `other_uploads`, `status_updates`,
  `assigned_to_you`, each with All On / In-App Only / All Off — plus a
  global `email_frequency`. It persists via `PATCH /auth/me/preferences`
  (line 93) into `user.preferences.notifications`. But grepping the
  whole API for `preferences.notifications`, `should_notify`, or
  `email_frequency` returns zero matches: no email-sending call site
  reads this back. Every configured email fires unconditionally
  regardless of what the user set. Users believe they've turned
  categories off and they have not.
- Notification creation happens via a `Notification(...)` constructor,
  called from: `routers/comments.py` (mentions/replies), `routers/approvals.py:81,114`
  (approve/reject), `routers/assets.py:611` (assignment change),
  `tasks/reminder_tasks.py:30` (due-soon). Email dispatch (e.g.
  `send_mention_email`, called from `routers/comments.py:185`) happens
  alongside notification creation at these same call sites, with no
  preference check.
- **New-version upload sends no notification of any kind, in-app or
  email.** `initiate_new_version` (`apps/api/routers/assets.py:467-526`)
  creates the `AssetVersion`/`MediaFile` rows and commits (line 519)
  with nothing else — confirmed absent from the grep above.
- The notification bell (`apps/web/components/layout/sidebar.tsx:153-160`)
  already has a working unread-count dot sourced from
  `useNotificationStore` — this part is not broken, do not rebuild it,
  just make sure any new notification type you add flows through the
  same store correctly.
- No "seen version" tracking exists anywhere in the schema — not on
  `Asset`, `AssetVersion`, or any join table. The asset-card component
  (`apps/web/components/projects/asset-card.tsx`) currently has a
  duration badge (line 182) and comment-count badge (line 189) only, no
  version/unseen indicator.
- `AssetVersion` model (`apps/api/models/asset.py`, ~line 68-78) has no
  color/identity field today — if a per-version color is wanted for the
  badge, that's new, not something to look up.

## Build, in priority order

### 1. Wire the existing preference settings to actual email dispatch

For each email-sending call site listed above (mentions/replies,
approve/reject, assignment change, due-soon reminder), look up the
recipient's `preferences.notifications[category]` value before sending
and skip the email (but still create the in-app `Notification` row,
which drives the bell) when the user has that category set to something
other than "All On" (i.e. "In-App Only" or "All Off" both suppress the
email; "All Off" — check whether that should suppress the in-app
notification too, or just the email; the UI copy in
`settings/notifications/page.tsx` should tell you which is intended).
Respect `email_frequency` if it means something beyond immediate-or-not
(check what values it currently supports — may just be immediate vs
digest, in which case digest batching is out of scope here unless it's
trivial; flag if it looks like a bigger job and stop rather than
half-build a digest system).

Map each existing email-send call site to the closest matching
preference category (`general_comments`, `comment_replies`, `mentions`,
`other_uploads`, `status_updates`, `assigned_to_you`) — if any existing
notification type doesn't cleanly map to one of these six categories,
flag it rather than guessing.

### 2. Add a new-version-upload notification

In `initiate_new_version` (or wherever version processing actually
completes — check whether notification should fire on upload-initiated
or on transcode-complete; probably the latter, since the version isn't
meaningfully "there" for a reviewer until processing finishes, but
verify against how other notifications in this codebase are timed),
create a `Notification` for whichever users are "assigned" to the asset
(reuse whatever assignment concept `routers/assets.py:611`'s existing
assignment-change notification already uses), and send the
corresponding email through the same preference-gated path built in
step 1, using the `other_uploads` category (or a new category if none
fits — check with the six-category list above before adding a seventh).

### 3. Add an unseen-new-version badge to the asset card

- Add a lightweight "seen" tracking mechanism: a join table (e.g.
  `user_id`, `asset_id`, `last_seen_version_id`/`last_seen_at`) updated
  whenever a user opens an asset's viewer. Keep this minimal — it only
  needs to answer "has this user seen the current latest version of
  this asset."
- On `asset-card.tsx`, render a small badge in the style shown in the
  reference screenshot (a compact colored box in the corner, roughly
  matching the "V2" pill styling already used elsewhere in this
  codebase for version chips, not a redesign — reuse existing version-chip
  visual language). If the asset's `AssetVersion` model has no per-version
  color today, don't invent a whole color-coding system from scratch —
  the simplest version is one badge color, sized/labeled differently for
  seen vs unseen (see next bullet). Confirm with the reference image's
  intent, but keep this to a single small addition rather than a new
  design system.
- When the user has NOT seen the asset's current latest version: badge
  is larger and/or carries a "New Version" text label. When they have
  seen it (or there's only one version): badge is smaller/absent
  entirely, matching current behavior.
- Wire "mark as seen" to fire when the user opens the asset in the
  review view (not just hover/thumbnail load).

## Verification

- Toggle each of the six preference categories to "In-App Only" and "All
  Off" for a test user, trigger the corresponding action from a second
  account, confirm no email is sent (check via logs/mocked email
  service) but the bell's unread count still updates when appropriate.
- Upload a new version, confirm the assigned user gets both an in-app
  notification and (if their preference allows it) an email.
- Confirm the asset-card badge appears correctly sized/labeled for an
  unseen new version, then shrinks/clears after opening that asset as
  that user.
- Confirm existing notification flows (comments, mentions, approvals,
  reminders) still work exactly as before for users who haven't touched
  their preferences (i.e. the default preference state must not
  silently start suppressing emails that worked before this change).

Run backend tests and `npx vitest run` for the whole web app at the
end — report pass/fail counts, flag anything not already a documented
pre-existing failure.
