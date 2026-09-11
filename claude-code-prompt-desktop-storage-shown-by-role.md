# Claude Code prompt — desktop: show used or free storage based on tile role

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §66 — read it first.

## Current state (confirmed, don't re-investigate)

- `index.html:2497-2513` — the tile-meta text, generic branch shows only
  `${formatBytes(entry.freeBytes)} free`.
- `makeTile(entry, { role, node })` (`:2418`) already receives `role`:
  `"source"` (`:2575`), `"dest"` (`:2631`, `:2641`), or `undefined` (middle
  Volumes column, `:2609`).
- `entry.totalBytes` and `entry.freeBytes` both already exist on every
  volume entry (`volumes.js`) — no backend/IPC change needed.

## Build

In the generic (non-FreeFrame, non-fileList) branch of the tile-meta
text at `index.html:2509-2511`:
- `role === "source"`: show used storage — `formatBytes(entry.totalBytes - entry.freeBytes)` (guard for either being `null`, matching the existing `entry.freeBytes == null` guard already there).
- `role === "dest"`: show free storage, exactly as today — no change for this case.
- No role (undefined, middle Volumes column): show both, e.g.
  `"${formatBytes(used)} used · ${formatBytes(entry.freeBytes)} free"` —
  exact wording/separator is your call, just show both figures.

## Verification

Drag a drive into Source — confirm its tile now shows how much data it
currently holds, not free space. Drag a drive into Destination — confirm
it still shows free space, unchanged from today. A drive sitting
unassigned in the middle Volumes column — confirm it shows both figures.
Confirm FreeFrame-kind tiles and file-list tiles are unaffected.
