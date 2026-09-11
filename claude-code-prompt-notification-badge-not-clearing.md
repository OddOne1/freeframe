# Claude Code prompt — notification dot doesn't clear on view, only on
reload or page switch

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. This is
`apps/web` (likely also touches `apps/api` if read-state is
server-persisted). Run `npx vitest run` at the end.

## Confirmed symptom, not yet diagnosed

The notification bell shows an unread-count dot. Opening the
notifications panel and actually looking at/reading a notification does
not clear the dot. It only disappears after the user reloads the page,
or navigates away and back (a full page/route switch). This means
whatever marks a notification "read" either isn't firing when the
panel is opened/an item is viewed, or is firing but not updating the
client-side badge state that actually controls the dot — and a reload
happens to re-fetch fresh state from the server, which is why that
"fixes" it.

Don't assume which half is broken — find out:

- Does opening the panel or viewing a notification actually call a
  mark-as-read endpoint/mutation at all? Check the network tab during
  a live repro, not just the code, to confirm whether the request even
  fires.
- If it fires: does it correctly update the read state server-side
  (check the notification record after) but the client-side store/
  badge count doesn't get updated in response (stale local state,
  missing cache invalidation, a count that's only refetched on
  full-page load)?
- If it doesn't fire: find where "user viewed this" should trigger the
  mark-as-read call and why it isn't wired up — a missing onClick/
  onOpen handler, a component that renders the notification without
  the intended read-tracking side effect, etc.

This is the same family of bug as the uploads-panel reload issue fixed
earlier this session (§117 B2/B3) — client state not reflecting real
server state until a hard refetch — so the fix shape is likely similar:
make the badge count/read state update immediately and locally on the
actual read action, not rely on the next full reload to reconcile it.

## Verification

Manual, real browser: trigger a new notification, confirm the dot
appears. Open the notification panel and view/click the notification.
Confirm the dot clears immediately, without reloading or navigating
away. Confirm it stays cleared after a subsequent reload (i.e. the fix
is real state, not just an optimistic UI flag that reverts on refetch).
Confirm multiple unread notifications and partial read (viewing one of
several) update the count correctly rather than clearing everything at
once, unless that's already the intended behavior — confirm with
existing code/tests what the intended semantics are before assuming.
Run `npx vitest run` for the whole app at the end — report pass/fail
counts, flag anything not already a documented pre-existing failure.
