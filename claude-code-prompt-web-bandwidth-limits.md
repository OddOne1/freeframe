# Claude Code prompt — web: upload/download speed limits (§104)

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Full spec:
`CLAUDE.md` §104's "Web" section — read it first. This is `apps/web`.
Per the standing policy in CLAUDE.md's hard rules, run `npx vitest
run` for the whole app at the end.

## Current state (confirmed, don't re-investigate)

- Upload: `stores/upload-store.ts` chunks at `CHUNK_SIZE = 10MB`
  (`:6`), PUTting each part via `fetch` at `:158-159`, driven from the
  chunk loop starting `:372`.
- Download: `components/share/download-menu.tsx` — `trigger()`
  (`:31-37`) creates a hidden `<iframe>` pointed at a presigned S3 URL.
  This is the browser's OWN download mechanism; no JS ever touches the
  bytes, so nothing here is throttleable without replacing it. This is
  the one non-trivial part of this build — read §104's full reasoning
  on why, and the required mitigation, before starting.
- `downloadRaw()` (`:39-47`) and `downloadRendered()` (`:49-…`) both
  end by calling `trigger(url)`.
- Settings nav: `app/(dashboard)/settings/layout.tsx` — `/settings
  /profile` (`:30`) is the likely home for this, but check its current
  content before adding two more fields; a dedicated small section is
  fine if profile is already dense.

## Build

1. New `lib/bandwidth-throttle.ts`: a token-bucket rate limiter,
   same shape as the desktop one — `createLimiter(bytesPerSecond):
   { acquire(bytes): Promise<void> }`, `bytesPerSecond <= 0` = true
   no-op (no bucket bookkeeping at all when unlimited).
2. Setting storage: client-side only (localStorage, or fold into
   whatever local preferences store already exists if one does —
   check first) — `uploadLimitMbps`, `downloadLimitMbps`, both
   default `0`/unset = unlimited. This is NOT a server-side setting;
   the server has no role in pacing one browser's request rate.
3. Add the two number inputs to Settings (see location note above).
4. Upload throttle: in `upload-store.ts`, before each chunk's PUT
   (`:158-159`), `await limiter.acquire(chunkBytes)`, using ONE
   limiter per upload session/job (not per chunk, not re-created per
   file) so the cap applies to aggregate throughput.
5. Download rebuild (`download-menu.tsx`): replace the
   `trigger()`/iframe approach with a real fetch-and-stream:
   - Get the presigned/direct URL the same way `downloadRaw`/
     `downloadRendered` already do (their existing API calls are
     unchanged — only the final "now actually fetch the bytes" step
     changes).
   - `fetch()` that URL, read `res.body` as a `ReadableStream`, loop
     `reader.read()`, and before accepting each chunk `await limiter
     .acquire(chunk.byteLength)`.
   - **Required, not optional:** feature-detect `window
     .showSaveFilePicker` (File System Access API) first. When
     available, stream chunks directly into a writable via
     `showSaveFilePicker()` + `createWritable()` — never buffers the
     full file in memory.
   - When File System Access API is NOT available (Safari, Firefox):
     do not silently fall back to buffering arbitrarily large files
     into a `Blob` in memory — that is a real tab-crash risk for large
     RAW downloads (§30/§30b's raw variant can be many GB). Either (a)
     ask for confirmation before starting a throttled Blob-buffered
     download above a size threshold you pick and document (e.g.
     >1-2GB), clearly warning it may be memory-heavy, or (b) for those
     browsers, skip the throttled path entirely and fall back to the
     OLD unthrottled iframe/native download, clearly indicating in the
     UI that speed limiting isn't available in this browser for this
     download. Pick one, document which, and do not ship the
     Blob-buffering path unguarded for large files regardless of which
     you pick.
   - Confirm the export-polling flow in `downloadRendered()` (`:49-…`)
     is otherwise untouched — only the final trigger/fetch step at the
     end changes, not the export-start/poll logic before it.

## Verification

Set an upload limit, upload a multi-chunk file, confirm measured
throughput respects it. Set a download limit and download a raw asset
in a Chromium browser (File System Access API path) — confirm it's
throttled AND never buffers the whole file (check memory doesn't scale
with file size, e.g. via devtools). In a browser without File System
Access API, confirm whichever mitigation was chosen actually triggers
(size-threshold warning, or the documented fallback to native
unthrottled download) rather than silently attempting to buffer a
large file. Set both limits to 0 and confirm full-speed behavior with
no observable throttle overhead. Run `npx vitest run` for the whole
app at the end — report pass/fail counts, flag anything not already a
documented pre-existing failure (the `api.test.ts`/
`notification-store.test.ts` five, per the last verified run).
