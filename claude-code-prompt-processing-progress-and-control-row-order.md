# Claude Code prompt — real processing progress + fix uploads-panel losing
in-progress items on reload + compare control-row order

Run from `~/Claude/Projects/FreeFrame/Freeframe/repo`. Touches
`apps/api` and `apps/web`. Run backend tests and `npx vitest run` at
the end.

## Part A — trivial: compare control row renders below the scrubber

`apps/web/components/review/compare/compare-overlay.tsx`: inside the
column-flex container at line 504, JSX order is `CompareVideoStage`
(513-536) → `CompareScrubber` (537-557) → control row
(`data-testid="compare-control-row"`, 637-675). No `order-*` utilities
are used anywhere in this file, so plain source order determines visual
stacking — the control row is last, so it renders below the scrubber,
even though a comment directly above it (625-636) claims it's "directly
above the scrubber." Move the control-row `<div>` (637-675) to before
`<CompareScrubber .../>` (before line 537), so JSX order becomes: stage
→ control row → scrubber. No layout-class changes needed.

## Part B — the real bug: no persisted progress, panel loses track of in-progress assets after reload

### Confirmed current state

- Progress percent is never persisted anywhere in the database — only
  `AssetVersion.processing_status` (an enum: pending/processing/ready/
  failed etc.) is stored. The actual numeric percent exists only
  transiently: `packages/transcoder/ffmpeg_transcoder.py:101-109` parses
  ffmpeg's `-progress pipe:1` output into a percent and calls a
  callback; `apps/api/tasks/transcode_tasks.py:208-212` publishes it as
  a `transcode_progress` SSE event over Redis pub/sub
  (`apps/api/services/event_service.py:18-22,29-47`) — nothing writes it
  to Postgres. Once no client is subscribed to that specific SSE stream
  at the moment an event fires, the percent is gone forever, not just
  delayed.
- `process_image()` (`packages/transcoder/image_processor.py`) never
  calls a progress callback at all — images sit at a static 0% the
  entire (normally few-second) run, then should jump to complete via
  the same `transcode_complete` event / poll fallback as video. This is
  expected mid-flight behavior for images, not itself a bug, but it
  means images are just as exposed to the reload-loses-tracking bug
  below since they rely on the exact same discovery mechanism.
- Frontend list membership: `apps/web/components/layout/uploads-panel.tsx:228`
  renders `useUploadStore(s => s.files)` directly — this one array
  drives both which assets appear in the panel AND each item's
  `processingProgress`. New uploads are pushed into `files` directly
  (`stores/upload-store.ts:555,602`), session-only, in-memory.
- On reload: `persist`'s `partialize` (`stores/upload-store.ts:849-854`)
  deliberately keeps only `failed`/`cancelled` entries — a genuinely
  `processing` entry is dropped from persisted state (correct, since
  its `File` object can't survive a refresh). So after reload, a
  still-processing asset must be *rediscovered* via `fetchHistory`/
  `fetchMoreHistory` (`stores/upload-store.ts:694,712`), which call
  `GET /me/assets?skip=...&limit=20` and merge results via
  `mergeHistoryAssets` (`:496`) — but this only fires from a
  `useEffect` gated on the panel being open (`uploads-panel.tsx:234-238`)
  and further pages only load as the user scrolls
  (`IntersectionObserver`, `:241-256`), 20 assets per page. **If a
  still-processing asset isn't within whatever page has actually been
  fetched, it never re-enters `files` and is simply absent from the
  panel** — not stuck at 0%, just gone. Its own version-detail view
  (which queries that one asset directly by ID) is unaffected and
  correctly shows the real status, which is why the two views disagree.
- `refreshProcessingItems` (the 5s poll, `:760-783`) and the SSE
  handlers (`:730-758`) only update progress on items **already present**
  in `files` — none of them can discover or re-add an asset that fell
  outside the pagination window. They can't compensate for the gap
  above.

### Fix

1. **Persist a real progress value.** Add a numeric progress field to
   `AssetVersion` (or wherever makes sense given the existing
   `processing_status` enum — check whether a separate small table or a
   plain nullable int column on `AssetVersion` is the better fit given
   how the rest of this model is structured) and write to it from the
   same place `transcode_progress` SSE events are currently published
   (`transcode_tasks.py:208-212`), so progress survives independent of
   any live SSE subscriber. This does NOT need to be granular for
   images (they can just go straight from 0 to ready, matching current
   behavior, since they have no callback) — this is primarily to fix
   video, and to give the panel a real value to show on (re)discovery
   instead of the current hardcoded 0/100 binary
   (`stores/upload-store.ts:516,777`).
2. **Add a dedicated "currently processing" fetch**, separate from the
   paginated `/me/assets` history call, that the uploads panel uses to
   populate its list on open/reload — something like `GET
   /me/assets?processing_status=processing` (or reuse `/me/assets` with
   a status filter if that's cleaner given the existing endpoint) that
   returns ALL of the current user's in-progress assets regardless of
   recency/pagination position, and merge those into `files` on panel
   open (in addition to, not instead of, the existing recency-based
   history pagination). This directly closes the gap: a processing
   asset should always be discoverable by the panel regardless of how
   many more-recent assets exist.
3. Once #1 lands, use the persisted percent as the authoritative value
   when (re)discovering a processing asset via #2, rather than the
   current binary 0/100 guess at `stores/upload-store.ts:516,777`.

## Verification

Manual, real environment (this needs actual Celery/Postgres, not
mockable in isolation) — per past rounds in this project, confirm
before considering this done rather than relying on unit tests alone
where they can't reach the real bug:

- Upload a video, close the uploads panel or reload the page mid-
  transcode, reopen the panel: confirm the still-processing asset
  appears in the list (not just its progress value — its very presence)
  and shows a real, advancing percent, not stuck at 0.
- Same test for an image upload/new-version.
- Confirm an asset far outside the default 20-item history page (e.g.
  after uploading 25+ other assets more recently) still surfaces
  correctly if it's still processing.
- Confirm the compare-mode control row now renders above the scrubber
  in both side-by-side and wipe mode.
- Confirm existing SSE-live-progress behavior (panel open the whole
  time, no reload) still works exactly as before — this fix should be
  additive for the reload/rediscovery case, not a regression for the
  already-working live case.

Run backend tests and `npx vitest run` for the whole web app at the
end — report pass/fail counts, flag anything not already a documented
pre-existing failure.
