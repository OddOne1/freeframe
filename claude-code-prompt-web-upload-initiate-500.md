# Claude Code prompt — web: batch uploads 500 on /upload/initiate (urgent, live production affected)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §27 — read it first.

**This is currently blocking a live production project (RB_ReShuffle)
from uploading footage.** Prioritize accordingly.

## What's known, from browser console evidence (not a server-side repro
   — pull the actual server logs/traceback first if you can, that will
   confirm the exact failure mechanism faster than reasoning about it)

Dropping a batch of files into the uploader produces one successful
upload (real `asset_id`/`version_id`, parts uploading fine to S3) and
many repeated `POST /upload/initiate` calls failing with 500.

Two things compound:
1. `apps/web/app/(dashboard)/projects/[id]/page.tsx:517-522` —
   `media.forEach((file) => { ... startUpload(file, ...) })` starts every
   file in a dropped batch in the same synchronous loop, no concurrency
   cap between files.
2. `apps/api/services/storage_prefix.py:155-189` —
   `lock_storage_prefix()`, called from `upload.py:113` on every
   initiate, takes `Project.query(...).with_for_update()` to serialize
   the *first* prefix assignment for a project (added in `d16102a`).
   Correct for two near-simultaneous requests; not written with N-wide
   concurrency (a full multi-file batch) in mind.

## Step 1 — confirm the actual server-side failure before fixing anything

Reproduce locally: drop 5+ files at once into a project that has never
had a prefix locked (`storage_slug`/`storage_date_prefix` both NULL), and
capture the real exception/traceback from the API logs. Don't guess
between "DB lock timeout," "connection pool exhaustion," or something
else — confirm which one it actually is. This determines how urgent/
targeted the server-side fix needs to be.

## Step 2 — client-side mitigation (do this regardless of what step 1
   finds; it's cheap and reduces the blast radius either way)

Serialize or cap concurrent `/upload/initiate` calls across a batch in
`page.tsx`'s `handleStartUpload`. Simplest version: let the first file's
`startUpload` actually reach and complete its `initiate` call before
firing the rest — since after that, the project's prefix is already
locked in the DB and every subsequent initiate in the batch just reads
committed values instead of contending for the write lock. A small
concurrency limit (matching the existing pattern at
`upload-store.ts:20`, `CONCURRENT_PARTS`) is also acceptable if a strict
first-then-rest ordering is awkward to wire in — just don't leave it
fully unbounded.

## Step 3 — server-side robustness fix

`lock_storage_prefix` should not surface a 500 to a waiter just because
it contended on the row lock. Once the first writer commits, a waiter's
own `with_for_update()` query returns the already-committed row — it
doesn't need to re-derive anything, just read what's there. If the
current failure is a lock/statement timeout, catch that specific
exception and retry the read (not the full slug-generation path) rather
than letting it bubble up as an unhandled 500. If it turns out to be
connection-pool exhaustion instead, the fix is different (pool sizing,
or bounding how many initiate requests are in flight server-side) — go
where step 1's actual evidence points, don't assume it's the lock
specifically if the traceback says otherwise.

## Not in scope

The 401s on `projects`/`me`/`notifications` visible in the same console
dump look like a separate, likely-unrelated expired-session issue — don't
fold that into this fix unless investigation shows it's actually caused
by the same thing.

## Verification

Reproduce the original failure first (confirm it's real on the current
deployed code, not just in this report). Then confirm: dropping 10+
files at once into a project with no prefix yet locked succeeds for all
of them, not just the first. Confirm the existing single-file and
small-batch upload paths are unaffected. Confirm concurrent uploads to
*different* projects (which don't contend on the same row) aren't
slowed down by whatever serialization you add.
