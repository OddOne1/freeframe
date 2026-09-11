# Claude Code prompt — web: share-link toggle lag

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §31 — root cause fully diagnosed there, this is a build
prompt.

## Root cause

`apps/web/components/projects/share-link-detail.tsx:80-90`,
`immediateUpdate` (used by the "Allow download" and "Show all versions"
switches, `:944-954`) and `debouncedUpdate` (`:65-78`, used elsewhere in
the same file) both `await` the PATCH request, then call `mutate()` to
refetch. The switches' `checked` state is bound directly to server data
(`shareLink.allow_download`/`shareLink.show_versions`) with nothing
updating locally first — so a click waits through a full PATCH
round-trip *and then* a full refetch round-trip before the switch
visually moves.

## Fix

Add an optimistic update to both `immediateUpdate` and
`debouncedUpdate`: either local component state that flips the switch
immediately and reconciles once the server responds, or SWR's own
`mutate(updatedData, { optimisticData, rollbackOnError: true })`
pattern so a failed PATCH visually rolls the switch back rather than
leaving it in a state that doesn't match the server. Check every call
site of both functions in this file — there may be more toggles/fields
affected than just download/versions, apply the fix consistently rather
than special-casing those two.

## Verification

Click a toggle and confirm it moves immediately, before the network
request resolves. Simulate a failed PATCH (e.g. temporarily break the
endpoint or throttle/fail the request in devtools) and confirm the
switch rolls back to its prior state rather than staying in the
optimistic-but-wrong position. Confirm rapid repeated toggling
(clicking a switch several times quickly) doesn't produce a
flicker/race where an in-flight earlier request's response overwrites a
later click's state.
