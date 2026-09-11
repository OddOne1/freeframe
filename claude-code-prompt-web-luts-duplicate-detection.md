# Claude Code prompt — prevent duplicate LUT uploads (content hash)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §44 — read it first. Mostly independent of §41/§42/§45 —
can be built in any order relative to them, but §42 (folder upload)
benefits from this existing first.

**Scope already decided with the user, don't re-litigate**: per-owner
uniqueness for personal LUTs (different users may own identical
content, that's fine), AND platform-wide uniqueness for Platform LUTs
(no two platform entries may have identical content, checked
separately from the per-owner rule).

## Backend

- Add a content-hash column to `Lut` (`apps/api/models/lut.py`) —
  hash the actual `.cube` file bytes (or its parsed data, your call
  which is more robust to incidental byte differences like trailing
  whitespace in an otherwise-identical file; state which you picked
  and why) at upload time. Migration + backfill for existing rows
  (compute the hash for every existing `Lut` — needs to read each
  file from storage; if that's impractical in this environment, backfill
  as NULL and only enforce going forward, stating that tradeoff
  plainly).
- On upload (`luts.py`'s `upload_lut`): before accepting, check for an
  existing match:
  - Personal upload: same hash AND same `owner_id`.
  - If the upload is happening in a platform-management context (or
    on promotion — see below): same hash AND `is_platform_wide=true`,
    regardless of owner.
- On promotion to platform-wide (whatever endpoint/action flips
  `is_platform_wide`, including §41's whole-group-drag if that's been
  built): also run the platform-wide duplicate check at that point,
  since a LUT that passed its per-owner check on upload could still
  collide with something already on the platform list.
- **Reject with a clear, specific message** naming the existing LUT
  (its name, and its group if it's in one) — "already found here,"
  not just "duplicate rejected." The user asked for this explicitly.

## Frontend

Surface the rejection message from the multi-upload flow (§34's
per-file error reporting, `handleFiles`/`uploadErrors` in
`page.tsx`) — a duplicate should report as its own distinct,
informative failure per file, not a generic upload error.

## Verification

Upload the same `.cube` twice as the same user — second one rejected,
message names the first. Upload the same `.cube` as two different
users — both succeed (per-owner scope confirmed). Promote one of those
to platform-wide, then have the other user attempt the same promotion
— second promotion rejected with a message pointing at the first
user's now-platform-wide copy. Confirm a completely different `.cube`
with the same *filename* as an existing one is NOT rejected (this is a
content check, not a filename check).
