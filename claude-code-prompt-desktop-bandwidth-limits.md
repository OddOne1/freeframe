# Claude Code prompt — desktop: upload/download speed limits (§104)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §104's "Desktop" section — read it first. This is
`apps/desktop`. Per the standing policy in CLAUDE.md's hard rules, run
the full desktop test suite at the end.

## Current state (confirmed, don't re-investigate)

- `freeframe.js` `uploadFile()` (`:364-427`): reads the file in
  `PART_SIZE = 16MB` (`:361`) chunks, `CONCURRENT_PARTS = 3` (`:362`)
  workers each looping and PUTting a part via `fetch(presigned_url,
  {method:"PUT", body:buf})` at `:409`.
- `freeframe.js` `openAssetStream()` (`:262-…`): does `fetch(absolute)`
  then wraps `res.body` through a `Transform` stream already (comment
  at `:276` about every chunk being copied) before returning it to the
  caller in `main.js`'s `freeframeSource().open()` (`main.js:894-898`).
- `settings.js` `DEFAULTS` (`:19-43`) is where per-job settings live;
  `main.js:1374-1379` shows the existing pattern for reading a setting
  once at job start and threading it through, using §86's
  `finalizedAlgorithm` as the precedent to follow.

## Build

1. New `main/bandwidth-throttle.js`: a token-bucket rate limiter.
   `createLimiter(bytesPerSecond)` returns `{ acquire(bytes):
   Promise<void> }` — refills a budget continuously over time and
   resolves `acquire` once enough budget exists for the requested byte
   count, awaiting otherwise. `bytesPerSecond <= 0` (or `null`/
   `undefined`) means unlimited — `acquire` resolves immediately,
   always, with no bucket bookkeeping at all (this must be a true
   no-op path, not a bucket with an absurdly high ceiling — a job with
   no limit set must not pay any throttling overhead).
2. `settings.js`: add `uploadLimitMbps: 0` and `downloadLimitMbps: 0`
   to `DEFAULTS`. Normalize as non-negative numbers (reject/clamp
   negative or non-numeric input to `0`). Convert Mbps → bytes/sec
   only at the point a limiter is actually created (e.g. `mbps * 1024
   * 1024 / 8`), not in storage.
3. Thread both settings from `main.js` into whichever call creates
   `freeframeSource()` and calls `freeframe.uploadFile(...)` — same
   "read once at job start, don't retune a running job" pattern as
   `finalizedAlgorithm`. Create ONE limiter per job per direction (not
   per file, not per part) so the cap applies to the job's aggregate
   throughput, not per-file.
4. `freeframe.uploadFile()`: accept an optional upload limiter. Before
   each part's `fetch(...)` PUT (`:409`), `await limiter.acquire(buf
   .length)`.
5. `freeframe.openAssetStream()`: accept an optional download limiter.
   Pipe the returned stream through an additional `Transform` (or fold
   the pacing into the existing one at `:276`) that calls `await
   limiter.acquire(chunk.length)` before passing each chunk through —
   this one gets true byte-level pacing since it's already a stream,
   unlike the upload's part-boundary granularity.
6. Settings UI (`settings-window.js`, follow the existing checksum
   wiring pattern at `:59`, `:90-92`, `:130-136`, `:347-350`,
   `:408-411`): two number inputs, "Upload speed limit (Mbps)" and
   "Download speed limit (Mbps)", blank or `0` = unlimited. Wire to
   `setSettings`/read on load, same as the existing algorithm
   dropdowns.

## Verification

Set an upload limit, run an upload job with a file large enough to
span several parts, confirm actual measured throughput stays at or
below the configured limit (allow reasonable burst slop at part
boundaries — exact byte-level precision isn't the bar, "clearly
respects the cap" is). Set a download limit, pull a FreeFrame asset as
a source, confirm throughput is capped and — since this path IS
byte-level — tighter to the target than the upload path. Set BOTH to 0
and confirm a job runs at full speed with no measurable overhead from
the throttle machinery being present but inert. Set only one direction
and confirm the other is genuinely unaffected. Run the full desktop
test suite (Electron/e2e included, via `electron-harness.js`'s
teardown per §62) at the end — report pass/fail counts, flag anything
not already a documented pre-existing failure.
