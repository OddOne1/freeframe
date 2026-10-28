'use client'

import * as React from 'react'
import { useUploadStore } from '@/stores/upload-store'
import type { AssetVersion } from '@/types'

/**
 * §242 — the version list of the asset on screen, kept true to the server,
 * plus "a new version arrived while you were looking at this".
 *
 * WHY THIS EXISTS. The provider fetches `/assets/{id}/versions` exactly once
 * (on mount, inside `fetchAsset`) and nothing ever re-read it. Every piece of
 * realtime the app already has — `transcode_progress`, `transcode_complete`,
 * `transcode_failed` on the project channel — was consumed by the UPLOADS
 * panel (`upload-sse-bridge.tsx`) and by the transcript, never by the version
 * switcher. So a version that was `uploading` when the page opened stayed
 * "Uploading" in the dropdown, greyed and undeletable, until a reload: the
 * data was stale, not wrong.
 *
 * Three ways in, because none of them alone is enough:
 *
 *  1. SSE (`onVersionEvent`) — instant, but Redis pub/sub has no replay, so
 *     an event published while the connection was down is gone for good;
 *  2. the 5s poll — only while this asset actually has a version in flight,
 *     only while the tab is visible, and it stops by itself;
 *  3. this tab's own upload reaching `/upload/complete` (the upload store) —
 *     free, and it covers the uploader before any event arrives.
 *
 * WHAT COUNTS AS NEW. Diffed against what THIS page instance already knew,
 * not against a server flag: a version whose id was not in the list when the
 * page opened, that is not this user's own upload, and that is `ready`.
 * Opening an asset an hour after v9 landed shows nothing — the dot answers
 * "something changed while you were reading", which is a question only the
 * open page can answer. The grid's `has_unseen_version` badge is the other,
 * persistent half of §108 and is untouched here.
 */

/** At most one version-list fetch per this window, however many events land. */
export const VERSION_REFETCH_WINDOW_MS = 1500

/** Fallback poll, while (and only while) a version of this asset is in flight. */
export const VERSION_POLL_INTERVAL_MS = 5000

/** Uploading or transcoding: a status that is going to change by itself. */
export function versionInFlight(
  version: Pick<AssetVersion, 'processing_status'>,
): boolean {
  return (
    version.processing_status === 'uploading' ||
    version.processing_status === 'processing'
  )
}

export interface UseLiveVersionsOptions {
  /** The asset on screen. Null/undefined while it is still loading. */
  assetId: string | null | undefined
  /** The list as the provider currently holds it. */
  versions: AssetVersion[]
  /** The provider's re-read of `/assets/{id}/versions`. */
  refetchVersions: () => Promise<void> | void
  /** The signed-in user, so their own uploads do not raise the dot. */
  currentUserId?: string | null
  /** The selected version's number — selecting a new version clears it. */
  currentVersionNumber?: number | null
  /**
   * Called once each time a selection clears the indicator, so the page can
   * re-POST `/assets/{id}/seen` and keep the grid badge consistent with what
   * the user has actually opened.
   */
  onNewVersionSeen?: () => void
  enabled?: boolean
}

export interface UseLiveVersionsResult {
  /**
   * A version's status changed (created, finished, failed). Debounced, so a
   * burst costs one fetch. Takes the event's `asset_id` — events arrive for
   * the whole PROJECT and most of them are about other assets.
   */
  onVersionEvent: (eventAssetId: string | null | undefined) => void
  /**
   * `transcode_progress`, which carries only `{asset_id, percent}`. The
   * dropdown shows no percentage, so this is NOT a refetch trigger — except
   * for the one case the percentage is the only evidence of: a version this
   * page has never heard of has started processing. Once the list holds
   * something in flight, the 5s poll owns it and further ticks are ignored.
   */
  onVersionProgress: (eventAssetId: string | null | undefined) => void
  /** Versions that arrived while this page was open, by someone else, ready. */
  newVersionIds: ReadonlySet<string>
}

const EMPTY_SET: ReadonlySet<string> = new Set()

export function useLiveVersions({
  assetId,
  versions,
  refetchVersions,
  currentUserId,
  currentVersionNumber,
  onNewVersionSeen,
  enabled = true,
}: UseLiveVersionsOptions): UseLiveVersionsResult {
  // Everything the callbacks below read lives in a ref: they are handed to
  // `useSSE`, which keeps them for the life of a connection, and to a
  // setInterval. A callback rebuilt per render would be a dependency that
  // tears the SSE connection down and mints a new ticket on every render.
  const assetIdRef = React.useRef(assetId)
  assetIdRef.current = assetId
  const refetchRef = React.useRef(refetchVersions)
  refetchRef.current = refetchVersions
  const enabledRef = React.useRef(enabled)
  enabledRef.current = enabled
  const seenCallbackRef = React.useRef(onNewVersionSeen)
  seenCallbackRef.current = onNewVersionSeen

  const anyInFlight = versions.some(versionInFlight)
  const inFlightRef = React.useRef(anyInFlight)
  inFlightRef.current = anyInFlight

  // ── The debounced fetch ─────────────────────────────────────────────────
  //
  // Leading edge AND trailing edge. The leading edge is why the uploader's
  // own list updates the instant their upload completes; the trailing edge
  // is what makes a burst safe to drop into — without it, the LAST event of
  // a burst (v9 finishing 300ms after v8) would be swallowed, and if the
  // list that came back holds nothing in flight the poll is not running to
  // find it either. So a burst costs two fetches 1.5s apart, never one per
  // event.
  const lastFetchAtRef = React.useRef(0)
  const trailingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The upload rows this asset was last seen with — see "Way in 3" below. */
  const previousOwnUploadSignal = React.useRef<string | null>(null)

  const runFetch = React.useCallback(() => {
    lastFetchAtRef.current = Date.now()
    void refetchRef.current?.()
  }, [])

  const scheduleRefetch = React.useCallback(() => {
    if (!enabledRef.current || !assetIdRef.current) return
    // A trailing fetch is already booked: it will see everything that has
    // landed by the time it runs.
    if (trailingTimerRef.current !== null) return
    const since = Date.now() - lastFetchAtRef.current
    if (since >= VERSION_REFETCH_WINDOW_MS) {
      runFetch()
      return
    }
    trailingTimerRef.current = setTimeout(() => {
      trailingTimerRef.current = null
      runFetch()
    }, VERSION_REFETCH_WINDOW_MS - since)
  }, [runFetch])

  React.useEffect(
    () => () => {
      if (trailingTimerRef.current !== null) {
        clearTimeout(trailingTimerRef.current)
        trailingTimerRef.current = null
      }
    },
    [],
  )

  // A different asset means a different list: forget when the last fetch was
  // so the first event about the NEW asset is not debounced against it, and
  // forget the upload rows watched below, whose change from one asset's rows
  // to another's is not an upload finishing.
  React.useEffect(() => {
    lastFetchAtRef.current = 0
    previousOwnUploadSignal.current = null
  }, [assetId])

  // ── Way in 1: the project's SSE channel ─────────────────────────────────

  const onVersionEvent = React.useCallback(
    (eventAssetId: string | null | undefined) => {
      if (!eventAssetId || eventAssetId !== assetIdRef.current) return
      scheduleRefetch()
    },
    [scheduleRefetch],
  )

  const onVersionProgress = React.useCallback(
    (eventAssetId: string | null | undefined) => {
      if (!eventAssetId || eventAssetId !== assetIdRef.current) return
      if (inFlightRef.current) return
      scheduleRefetch()
    },
    [scheduleRefetch],
  )

  // ── Way in 2: the poll, while something is in flight ────────────────────
  //
  // Volume: one GET every 5s per open asset page, and ONLY while a version
  // of that asset is uploading or transcoding — 12 requests per minute for
  // the duration of a transcode, zero for an idle asset, zero while the tab
  // is in the background. The request is the same indexed read the page
  // already makes once on mount.
  React.useEffect(() => {
    if (!enabled || !assetId || !anyInFlight) return
    if (typeof document === 'undefined') return

    let timer: ReturnType<typeof setInterval> | null = null

    const start = () => {
      if (timer === null) timer = setInterval(scheduleRefetch, VERSION_POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      // Coming back: one catch-up read first, then resume the interval.
      // Whatever finished while the tab was hidden is shown immediately
      // rather than up to 5s later.
      scheduleRefetch()
      start()
    }

    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled, assetId, anyInFlight, scheduleRefetch])

  // ── Way in 3: this tab's own upload ─────────────────────────────────────
  //
  // Both halves of an upload's tail: `/upload/complete` returning moves the
  // row to `processing` (`complete` for a non-media file), and the store's
  // own SSE/poll bridge moves it to `complete` when the transcode finishes.
  // Each is a moment the version list changed, and reading the store costs
  // nothing — no new subscription, no new request.
  const ownUploadProgressSignal = useUploadStore((s) =>
    s.files
      .filter(
        (f) =>
          f.assetId === assetId &&
          (f.status === 'processing' || f.status === 'complete'),
      )
      .map((f) => `${f.id}:${f.status}`)
      .sort()
      .join('|'),
  )
  React.useEffect(() => {
    if (!assetId) return
    // The first value is the state at mount, not a transition: an upload
    // that finished before this page opened must not provoke a fetch.
    if (previousOwnUploadSignal.current === null) {
      previousOwnUploadSignal.current = ownUploadProgressSignal
      return
    }
    if (previousOwnUploadSignal.current === ownUploadProgressSignal) return
    previousOwnUploadSignal.current = ownUploadProgressSignal
    scheduleRefetch()
  }, [assetId, ownUploadProgressSignal, scheduleRefetch])

  /**
   * Version ids THIS TAB uploaded, from the upload store.
   *
   * The fallback for attribution, and the reason it is needed: no event on
   * the channel carries a `created_by` — `transcode_complete` is
   * `{asset_id, version_id}` and `transcode_failed` is `{asset_id, error}`.
   * Attribution therefore comes from the version row itself
   * (`AssetVersionResponse.created_by`, which `/assets/{id}/versions`
   * already returns), and this set covers the one case that row cannot: a
   * `created_by` that is null (an older row, or a version created by a
   * service rather than a person). A version this tab is uploading is
   * certainly not news to the person doing it.
   *
   * With neither — null `created_by`, no local upload row — the version is
   * treated as someone else's and does raise the dot. A redundant dot the
   * user clicks away costs a click; a missed one is the bug being fixed.
   */
  const ownUploadVersionIdsSignal = useUploadStore((s) =>
    s.files
      .filter((f) => f.assetId === assetId && f.versionId)
      .map((f) => f.versionId as string)
      .sort()
      .join('|'),
  )
  const ownUploadVersionIds = React.useMemo(
    () => new Set(ownUploadVersionIdsSignal.split('|').filter(Boolean)),
    [ownUploadVersionIdsSignal],
  )
  const ownUploadVersionIdsRef = React.useRef(ownUploadVersionIds)
  ownUploadVersionIdsRef.current = ownUploadVersionIds

  // ── The diff: what arrived while this page was open ─────────────────────

  const [newVersionIds, setNewVersionIds] = React.useState<ReadonlySet<string>>(EMPTY_SET)
  // Mirrored, because the two effects below have to KNOW whether they changed
  // anything: a `useState` updater runs during the next render, so a flag set
  // inside one is still false on the line after it — and whether a selection
  // actually cleared something is what decides if `/seen` is re-POSTed.
  const newVersionIdsRef = React.useRef(newVersionIds)
  newVersionIdsRef.current = newVersionIds

  const publish = React.useCallback((next: ReadonlySet<string>) => {
    const prev = newVersionIdsRef.current
    if (next.size === prev.size && Array.from(next).every((id) => prev.has(id))) {
      return false
    }
    newVersionIdsRef.current = next
    setNewVersionIds(next)
    return true
  }, [])

  /** The ids the page STARTED with. Nothing in here can ever be "new". */
  const baselineRef = React.useRef<{ assetId: string | null | undefined; established: boolean }>({
    assetId,
    established: false,
  })
  /** Every id seen so far, with the status it was last seen in. */
  const seenRef = React.useRef(new Map<string, AssetVersion['processing_status']>())
  /** Arrived while open, by someone else — but not yet `ready`. */
  const pendingRef = React.useRef(new Set<string>())
  /** id → version_number, for clearing "everything up to the one selected". */
  const numbersRef = React.useRef(new Map<string, number>())

  React.useEffect(() => {
    if (!assetId) return

    if (baselineRef.current.assetId !== assetId) {
      baselineRef.current = { assetId, established: false }
      seenRef.current = new Map()
      pendingRef.current = new Set()
      numbersRef.current = new Map()
      publish(EMPTY_SET)
    }

    for (const v of versions) numbersRef.current.set(v.id, v.version_number)

    // The page opens with `versions: []` and fills it one round trip later,
    // so the baseline is the FIRST list that has anything in it — not the
    // empty array this effect sees first, which would make every existing
    // version look like an arrival (and light the dot on page load).
    if (!baselineRef.current.established) {
      for (const v of versions) seenRef.current.set(v.id, v.processing_status)
      if (versions.length > 0) baselineRef.current.established = true
      return
    }

    const seen = seenRef.current
    const pending = pendingRef.current
    const live = new Set(versions.map((v) => v.id))
    const ready = new Set<string>()

    for (const v of versions) {
      const firstSight = !seen.has(v.id)
      seen.set(v.id, v.processing_status)

      if (firstSight) {
        const own =
          (currentUserId != null && v.created_by === currentUserId) ||
          ownUploadVersionIdsRef.current.has(v.id)
        if (!own) pending.add(v.id)
      }
      if (!pending.has(v.id)) continue

      // Only once it is usable. While it uploads or transcodes the row
      // shows its live status (that is part A's job) and the dot stays off,
      // because there is nothing yet to go and look at.
      if (v.processing_status === 'ready') {
        ready.add(v.id)
      } else if (v.processing_status === 'failed') {
        // Including §238's "Upload incomplete". Never news: nothing to see,
        // and the version may well be deleted again. Dropped for good, so a
        // later retry does not resurrect the dot either.
        pending.delete(v.id)
      }
    }

    // A version deleted elsewhere stops being news.
    for (const id of Array.from(pending)) if (!live.has(id)) pending.delete(id)

    const next = new Set(
      Array.from(newVersionIdsRef.current).filter((id) => live.has(id)),
    )
    for (const id of Array.from(ready)) next.add(id)
    publish(next)
  }, [assetId, versions, currentUserId, publish])

  // ── Selecting a version acknowledges it ─────────────────────────────────
  //
  // Watching the SELECTION rather than taking a click handler: the switcher
  // sets `currentVersion` in the store directly, and so do the compare
  // overlay and the delete flow. One place to notice it, and nothing for
  // §241's edits to the switcher's rows to collide with.
  //
  // Opening the dropdown is deliberately NOT this. Looking at a list of
  // versions is not reading the new one.
  React.useEffect(() => {
    if (currentVersionNumber == null) return

    // Everything up to the selected version, including versions still
    // uploading: selecting v9 acknowledges v8 too, and a v10 that lands
    // afterwards raises the dot again on its own.
    for (const id of Array.from(pendingRef.current)) {
      if ((numbersRef.current.get(id) ?? 0) <= currentVersionNumber) {
        pendingRef.current.delete(id)
      }
    }

    const next = new Set(
      Array.from(newVersionIdsRef.current).filter(
        (id) => (numbersRef.current.get(id) ?? 0) > currentVersionNumber,
      ),
    )
    // `/seen` only when a selection really did acknowledge something — the
    // page already POSTs it once on open, and re-posting it on every click
    // through the switcher would be a request per version browsed.
    if (publish(next)) seenCallbackRef.current?.()
  }, [currentVersionNumber, publish])

  return { onVersionEvent, onVersionProgress, newVersionIds }
}
