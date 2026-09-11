# Claude Code prompt — desktop: Live Sync (continuous folder mirroring, stable-files-only)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §26 — read it first, it has the competitive research (.Lab's
Sync feature) and the Movie Recorder growing-file research behind the
scope decision below.

This is a large, genuinely new subsystem — not a bug fix, not an
extension of the existing offload job-queue. Feel free to report back
with a plan before writing code if the phases below raise questions the
spec doesn't answer; better to check than guess on something this size.

## What this is

A second, separate window (or a clearly separate top-level mode — your
call on the exact mechanism, but it must not share UI or state with the
main Sources/Volumes/Destinations offload window) that does one thing:
continuously mirrors one or more folder pairs, local drive to local
drive. No FreeFrame upload, no renaming, no naming presets, no filters,
no job-queue coexistence logic. Reachable only when a user deliberately
opens it — it should not run by default or affect the main window's
behavior at all.

**Explicitly deferred, do not build**: incremental copying of a file
that is still actively growing (e.g. a Movie Recorder capture still
mid-recording). Per §26, this needs format-aware handling (safe for
some destination types, unsafe for others) and is scoped as a separate
future task. This pass only ever copies a file once it has stopped
changing.

## Phase 1 — the watcher and stability detection

1. Add `chokidar` as a new dependency (not currently used anywhere in
   this app — check `package.json` before assuming otherwise). Use it
   to recursively watch one or more source folders for file
   add/change events.
2. Track `(size, mtimeMs)` per watched file. A file is only eligible to
   be copied once both have been unchanged for a short debounce window
   (a few seconds — pick a sensible default, this doesn't need to be
   user-configurable in the first pass). This is the mechanism that
   guarantees a file still being written by another program is never
   copied half-finished — the same principle .Lab's own Sync uses.
3. A file that's still changing should show as "waiting"/"in progress
   elsewhere" in the UI, not silently ignored — the user should be able
   to tell Live Sync knows about a file and just hasn't copied it yet.

## Phase 2 — copy + verify

1. Once a file is stable, copy it to the paired destination and verify
   it by re-reading and hashing the destination, reusing
   `hashFileOnDisk` (`apps/desktop/src/main/copy-engine.js`, exported
   already — its own comment says it's exported for exactly this kind
   of reuse by future tiers). Don't write a second hashing
   implementation.
2. Skip files whose destination copy already matches (same size +
   hash, or size + mtime if a full hash on every sweep is too
   expensive for large trees — your call, but be explicit in the report
   about which was chosen and why).
3. On a real mismatch (destination exists but doesn't verify), re-copy
   rather than silently trusting what's there.

## Phase 3 — multiple pairs, one window

1. **Pairs are arbitrary many-to-many, not a single-source fan-out.**
   Support any number of fully independent source→destination pairs
   running at once in one Live Sync window — unrelated sources, unrelated
   destinations, e.g. three different folders on three different drives
   each syncing to their own destination simultaneously. Each pair shows
   its own status (syncing / idle+waiting for next sweep / error) —
   matching how the user described wanting to see "which is working,
   which is waiting."
2. Adding, removing, or editing a pair should not disturb any other
   pair's progress.
3. Each pair must be individually pausable by the user, without
   affecting any other pair.

## Phase 3b — automatic drive-contention detection (user decision
   2026-08-16: build this now, not deferred)

The concrete scenario: a folder actively receiving a live recording
(Movie Recorder, etc.) likely isn't even configured as a Live Sync
source — the user would deliberately leave it out. So detecting
contention can't rely only on Phase 1's per-pair watchers, which only
see folders explicitly added as pairs.

1. Add a separate, lighter-weight monitor **per volume**, not per
   configured pair — it needs to notice any file anywhere on that volume
   whose size is currently changing, independent of whether that file's
   folder is a Live Sync source. Reuse whatever volume-identification
   logic the main window already has for grouping paths by physical
   drive (check `main.js`/the renderer for how drives are enumerated and
   how a path is resolved to its volume today — don't invent a second
   way to do this).
2. Expose this as a simple busy/not-busy signal per volume. Any sync
   pair whose source or destination lives on a busy volume should
   throttle or pause its own copy activity (your call on throttle vs.
   full pause — report which was chosen and why) until that volume's
   signal clears.
3. **This will produce false positives** — an unrelated large file being
   written to the same drive from something else entirely looks
   identical to this heuristic. That's acceptable over-caution, not a
   bug: throttling against an unrelated write is still safe, just
   possibly more conservative than strictly necessary. Don't try to
   distinguish "this growing file is a live recording" from "this
   growing file is something else" — treat any sustained growth on the
   volume as a reason to be cautious.
4. Surface which volumes are currently flagged busy in the UI, so the
   user understands why a pair is paused/throttled rather than it
   looking stuck or broken.

## Phase 4 — persistence across restarts

Sync pairs (source path, destination path, and enough state to resume
without re-copying everything already verified) need to survive quitting
and relaunching the app. Persist to a small JSON file under
`app.getPath("userData")`, following the same pattern `presets.js` and
the recent-folders store already use — don't invent a new persistence
convention. On relaunch, pairs should pick back up rather than starting
from scratch.

## Phase 5 — opt-in "mirror exactly" deletion, off by default

1. A separate, explicitly-opt-in mode per pair: when a source file is
   deleted, remove the corresponding destination file too. This must
   default to **off** — a pair with this not explicitly enabled should
   only ever add/update files at the destination, never remove
   anything, matching this app's established default-safe pattern
   (§23c's filtering, off by default).
2. Per the user's stated requirement: this must never trigger
   automatically on app launch, on reconnecting a drive, or on
   re-adding a pair that already existed — only ever as a direct
   consequence of the user explicitly starting/enabling it for that
   pair.

## Not in scope for this pass

- Incremental copying of actively-growing files (see above).
- Anything involving `naming.js`, `presets.js`, `filters.js`, or the
  FreeFrame upload/API path.
- ASC MHL export, PDF reports, or other reporting — not requested here.
- Card auto-detection or reel-name suggestion — this window only deals
  in folders the user has explicitly chosen, not camera cards.

## Verification

Create a sync pair, write a large file into the source slowly (e.g. via
a script that appends in chunks with delays) and confirm Live Sync does
NOT copy it until writing stops. Confirm it then copies and verifies
correctly. Confirm two independent pairs run without interfering with
each other. Quit and relaunch the app with pairs configured and confirm
they resume rather than re-copying everything. Confirm a pair without
"mirror exactly" enabled never deletes anything at the destination, even
when files are removed from the source — and confirm enabling it deletes
correctly, but only after the user has actually turned it on.

For Phase 3b: with two pairs whose sources are on the same volume, write
a growing file into a folder on that volume that is *not* configured as
either pair's source, and confirm both pairs throttle/pause while it's
growing, then resume once it stops. Confirm a pair on an unrelated,
otherwise-idle volume is unaffected.
