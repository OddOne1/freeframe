import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, ApiError } from '@/lib/api'
import {
  deleteSession,
  fileMatchesSession,
  listSessions,
  saveSession,
  canStoreFileHandles,
  type UploadSession,
} from '@/lib/upload-sessions'
import type { AssetResponse } from '@/types'

/**
 * §213 — a FALLBACK, not the part size.
 *
 * The server decides how a file is split (`part_size` on the initiate
 * response, from apps/api/services/upload_policy.py) because the ceiling
 * depends on it: 10 MiB parts cap a single file at 10,000 x 10 MiB =
 * 97.66 GiB, and a 100 GB file needs more parts than S3 allows. This
 * constant now only covers one case — a rolling deploy where a rebuilt web
 * container is talking to an api that predates §213 and sends no
 * `part_size` at all. Keeping the old value there is correct: it is what
 * that server expects, just with the old ceiling.
 */
const CHUNK_SIZE = 10 * 1024 * 1024 // 10 MB
const HISTORY_PAGE_SIZE = 20
// Backoff schedule for transient part failures (dropped wifi, locked screen,
// brief S3 hiccups). Caps at 15s and keeps retrying indefinitely as long as
// the tab stays open — a genuinely dead connection just keeps showing
// "retrying" rather than failing the whole upload outright.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000]
// Parts are uploaded through a small worker pool instead of one at a time —
// a single sequential fetch-per-10MB-chunk (the old behavior) round-trips
// through /upload/presign-part before every PUT and never uses more than one
// TCP stream, so it badly underuses available bandwidth on anything but a
// near-zero-latency path. 4 concurrent parts is a modest default: enough to
// actually use the pipe without opening so many connections at once that a
// single flaky part's retry backoff makes the whole upload look stalled.
const CONCURRENT_PARTS = 4
// Speed is computed from a trailing window of (time, bytesUploaded) samples
// rather than a lifetime average, so it reflects "how fast is this going
// right now" instead of converging slowly and hiding a recent slowdown.
const SPEED_WINDOW_MS = 5000
const SPEED_SAMPLE_INTERVAL_MS = 500

export type UploadStatus = 'pending' | 'uploading' | 'paused' | 'processing' | 'complete' | 'failed' | 'cancelled'

/**
 * How long an item may sit in 'processing' before this client stops polling
 * it and calls it failed (§117).
 *
 * Generous on purpose: a long 4K transcode legitimately takes a while, and
 * calling a running job failed is worse than polling it a few more times.
 * Six hours is far beyond any real transcode here while still being a floor.
 */
const PROCESSING_POLL_MAX_MS = 6 * 60 * 60 * 1000

export interface UploadFile {
  id: string
  fileName: string
  fileSize: number
  fileType: string
  projectId: string
  projectName?: string
  assetName: string
  progress: number
  processingProgress: number
  status: UploadStatus
  error?: string
  // Why the upload is currently paused — 'manual' means the user clicked
  // Pause and it stays paused until they click Resume; 'retrying' means a
  // part failed transiently and it will keep auto-retrying in the
  // background without any action needed.
  pauseReason?: 'manual' | 'retrying'
  assetId?: string
  versionId?: string
  uploadId?: string
  /**
   * §238 — the key this upload is writing to, remembered so a DISMISS can
   * ask the server to clean up an upload that never finished.
   *
   * `/upload/abort` binds the key to the version and refuses a request
   * whose key is not that version's (§236), so the client has to send the
   * one the server gave it.
   */
  s3Key?: string
  /**
   * §238 — did THIS upload create its asset?
   *
   * The whole of why `removeFile` may delete an asset at all: a first
   * upload's asset is created by `/upload/initiate`, so an asset left
   * behind by one that failed is litter and dismissing the row is the
   * only way to clear it. A NEW-VERSION upload's asset existed before and
   * has every other version, comment and approval on it — deleting that
   * is destroying someone's file, which is what this flag stops.
   *
   * OPTIONAL on purpose, and `undefined` is NOT `false` by accident: rows
   * persisted by an older build have no flag at all, and the safe reading
   * of "we do not know" is "do not delete anything". See `removeFile`.
   */
  createdAsset?: boolean
  createdAt: number // timestamp for grouping
  // Recent-window transfer rate and estimated time remaining, in bytes/sec
  // and seconds. Both undefined until enough samples exist to compute a rate
  // (see SPEED_WINDOW_MS) and only meaningful while status === 'uploading'.
  speedBps?: number
  etaSeconds?: number
}

interface InitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
  // §213 — optional, so an older api still parses. See CHUNK_SIZE.
  part_size?: number | null
  total_parts?: number | null
}

interface VersionInitiateResponse extends InitiateResponse {}

interface UploadedPart {
  PartNumber: number
  ETag: string
  Size: number
}

// AbortControllers for cancellation
const abortControllers: Record<string, AbortController> = {}

// Manual pause/resume signalling — module-level so it survives independent
// of any single React render, same pattern as abortControllers above.
const manualPauseFlags: Record<string, boolean> = {}
const manualPauseWaiters: Record<string, (() => void) | undefined> = {}

// Speed tracking — module-level for the same reason as the maps above.
// bytesUploadedMap is the running total of *committed* bytes (a part only
// counts once its PUT actually succeeds, not while it's in flight), updated
// concurrently by however many part-workers are active at once.
const bytesUploadedMap: Record<string, number> = {}
const speedSamples: Record<string, Array<{ t: number; bytes: number }>> = {}
const speedIntervals: Record<string, ReturnType<typeof setInterval>> = {}

/**
 * §213 — the browser says it is offline.
 *
 * Module-level for the same reason `manualPauseFlags` is: it has to
 * outlive any single React render, and every in-flight part shares it.
 *
 * `navigator.onLine` is only a hint — it is true on a network that cannot
 * reach anything — so this is NOT the primary mechanism. The retry loop is
 * already indefinite; this just stops it burning attempts against a
 * connection the browser knows is down, and gives the row an honest
 * reason. A false negative costs nothing: the retry carries on.
 */
const offlineWaiters: Array<() => void> = []
let connectivityWired = false

function wireConnectivity(): void {
  if (connectivityWired || typeof window === 'undefined') return
  connectivityWired = true
  window.addEventListener('online', () => {
    const waiting = offlineWaiters.splice(0, offlineWaiters.length)
    for (const w of waiting) w()
  })
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/** Resolves as soon as the browser reports a connection again. */
function waitWhileOffline(signal: AbortSignal): Promise<void> {
  if (!isOffline()) return Promise.resolve()
  wireConnectivity()
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }
    const done = () => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      const i = offlineWaiters.indexOf(done)
      if (i >= 0) offlineWaiters.splice(i, 1)
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    offlineWaiters.push(done)
  })
}

/** §213 — does this error mean the multipart session itself is gone? */
function isGoneSession(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'no_such_upload' || err.status === 404)
}

/**
 * §236 — the server completed nothing because the store does not hold the
 * whole file yet.
 *
 * `/upload/complete` builds the completion list from storage now, and
 * answers 409 `parts_incomplete` when the part numbers are not 1..N or the
 * sizes do not add up to the declared size. The upload is LEFT OPEN by
 * that answer, which is what makes it resumable rather than fatal: the
 * right move is to go back for the missing parts, not to fail the file.
 *
 * On the code, never on the status: 409 alone also covers `upload_failed`
 * (a version something already resolved as broken) and `parts_rejected`
 * (a list the store looked at and refused), and re-sending parts is the
 * wrong answer to both.
 */
function isPartsIncomplete(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'parts_incomplete'
}

/**
 * How many bytes `held` accounts for, given the part layout.
 *
 * One expression rather than four copies of it: the progress bar, the
 * saved session's `uploadedBytes` and §236's re-list all need it, and a
 * copy that drifted would show a resumed 97 GiB upload at the wrong
 * percentage.
 */
function bytesHeld(
  held: Map<number, string>,
  totalChunks: number,
  partSize: number,
  fileSize: number,
): number {
  return Array.from(held.keys()).reduce(
    (sum, n) => sum + (n < totalChunks ? partSize : fileSize - (totalChunks - 1) * partSize),
    0,
  )
}

/**
 * The parts from a `GET /upload/parts` listing that may be REUSED.
 *
 * A PART IS NEVER TRUSTED ON ITS NUMBER ALONE. A short part is a partial
 * write, and completing an upload around one produces a corrupt object
 * that passes every other check there is — so anything whose `Size` is not
 * exactly what this layout expects, and anything without an ETag, is
 * dropped here and re-sent.
 *
 * Shared by the §213 resume path and §236's re-list after a
 * `parts_incomplete`, because the two must agree about what counts as a
 * usable part: a stricter resume than re-list would re-send parts the
 * other had just accepted, and the looser of the two decides whether a
 * corrupt object is possible.
 */
function usablePartsFromListing(
  listed: UploadedPart[],
  fileSize: number,
  partSize: number,
): Map<number, string> {
  const held = new Map<number, string>()
  const total = Math.max(1, Math.ceil(fileSize / partSize))
  for (const part of listed) {
    const n = Number(part.PartNumber)
    if (!(n >= 1 && n <= total)) continue
    const expected = n < total ? partSize : fileSize - (total - 1) * partSize
    if (Number(part.Size) !== expected) continue
    if (!part.ETag) continue
    held.set(n, part.ETag)
  }
  return held
}

/**
 * §236 — how many times a `parts_incomplete` may send us back for more
 * parts before the upload is reported as failed.
 *
 * Bounded, unlike the per-part retry loop, and deliberately small. A part
 * that will not stick is not weather: each round here is a full re-list
 * plus however many parts are missing, and a server that keeps saying
 * "still short" after two honest attempts is telling us something the user
 * needs to see rather than something to grind on. The parts that did land
 * are kept and the session stays resumable either way, so stopping costs
 * nothing but a message.
 */
const COMPLETE_RESUME_ROUNDS = 2

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]
}

// Like a normal sleep, but rejects immediately if the upload is cancelled
// mid-wait instead of finishing the delay first.
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

// Blocks until resumeUpload() is called for this id, or the upload is
// cancelled. Re-checked in a loop so a pause -> resume -> pause sequence
// during the same await is handled correctly.
async function waitWhileManuallyPaused(id: string, signal: AbortSignal): Promise<void> {
  while (manualPauseFlags[id]) {
    if (signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        manualPauseWaiters[id] = undefined
        reject(new DOMException('Upload cancelled', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      manualPauseWaiters[id] = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
    })
  }
}

// Checkpoint called between parts and between retry attempts. If a manual
// pause is active it reflects that in the store, blocks until resumed, then
// flips the status back to 'uploading'. A no-op (returns immediately) when
// nothing is paused.
async function checkAndWaitManualPause(
  id: string,
  controller: AbortController,
  updateFile: (fileId: string, patch: Partial<UploadFile>) => void,
): Promise<void> {
  if (!manualPauseFlags[id]) return
  updateFile(id, { status: 'paused', pauseReason: 'manual', error: undefined })
  await waitWhileManuallyPaused(id, controller.signal)
  updateFile(id, { status: 'uploading', pauseReason: undefined })
}

async function uploadOnePart(
  s3_key: string,
  upload_id: string,
  partNumber: number,
  chunk: Blob,
  signal: AbortSignal,
): Promise<string> {
  const { presigned_url } = await api.post<{ presigned_url: string }>('/upload/presign-part', {
    s3_key,
    upload_id,
    part_number: partNumber,
  })
  const putResponse = await fetch(presigned_url, {
    method: 'PUT',
    body: chunk,
    signal,
  })
  if (!putResponse.ok) {
    throw new Error(`Part ${partNumber} failed: ${putResponse.statusText}`)
  }
  return putResponse.headers.get('ETag') ?? ''
}

// Wraps a single part's upload with the existing pause/retry-with-backoff
// behavior, unchanged in substance from before — just pulled out so multiple
// of these can run concurrently under a worker pool instead of one at a time.
// Note: with several of these in flight together, the shared per-upload
// status/error fields on the store entry can get written by more than one
// part around the same moment (e.g. one part hits a transient failure right
// as another succeeds) — status may flicker briefly rather than transition
// cleanly. Acceptable trade for real throughput; revisit with a proper
// per-upload status reducer if the flicker turns out to be more than cosmetic.
async function uploadPartWithRetry(
  id: string,
  s3_key: string,
  upload_id: string,
  partNumber: number,
  chunk: Blob,
  controller: AbortController,
  updateFile: (fileId: string, patch: Partial<UploadFile>) => void,
): Promise<{ PartNumber: number; ETag: string }> {
  let etag: string | null = null
  let attempt = 0
  while (etag === null) {
    await checkAndWaitManualPause(id, controller, updateFile)
    if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')

    try {
      etag = await uploadOnePart(s3_key, upload_id, partNumber, chunk, controller.signal)
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        throw err
      }
      // §213 — the session is gone. Nothing here can be retried: the file
      // needs a NEW upload, which is the caller's decision, not this
      // loop's. Rethrown unchanged so it can make it.
      if (isGoneSession(err)) throw err
      attempt++
      updateFile(id, {
        status: 'paused',
        pauseReason: 'retrying',
        // §213 — names the reason rather than just counting. An attempt
        // number alone cannot tell "this one part hiccupped" from "you
        // have no network", which is the thing a user needs to know.
        error: isOffline()
          ? `Offline — part ${partNumber} will continue when the connection is back`
          : `Part ${partNumber} interrupted — retrying (attempt ${attempt})…`,
      })
      // Waits only while the browser reports no connection; otherwise it
      // resolves at once and the ordinary backoff applies.
      await waitWhileOffline(controller.signal)
      await abortableSleep(retryDelay(attempt), controller.signal)
      await checkAndWaitManualPause(id, controller, updateFile)
      updateFile(id, { status: 'uploading', pauseReason: undefined, error: undefined })
    }
  }
  return { PartNumber: partNumber, ETag: etag }
}

// Starts a periodic sampler that turns bytesUploadedMap[id]'s running total
// into a trailing-window speed (bytes/sec) and a rough ETA, written into the
// store so the UI can show live throughput. Caller is responsible for
// clearing the returned interval when the upload ends (success, failure, or
// cancel) — see the `finally` block in runChunkedUpload.
function startSpeedSampler(
  id: string,
  fileSize: number,
  updateFile: (fileId: string, patch: Partial<UploadFile>) => void,
): ReturnType<typeof setInterval> {
  speedSamples[id] = []
  return setInterval(() => {
    const samples = speedSamples[id]
    if (!samples) return
    const now = Date.now()
    const bytes = bytesUploadedMap[id] ?? 0
    samples.push({ t: now, bytes })
    while (samples.length > 1 && now - samples[0].t > SPEED_WINDOW_MS) {
      samples.shift()
    }
    if (samples.length < 2) return
    const oldest = samples[0]
    const elapsedSec = (now - oldest.t) / 1000
    if (elapsedSec <= 0) return
    const speedBps = (bytes - oldest.bytes) / elapsedSec
    const etaSeconds = speedBps > 0 ? (fileSize - bytes) / speedBps : undefined
    updateFile(id, { speedBps: speedBps > 0 ? speedBps : undefined, etaSeconds })
  }, SPEED_SAMPLE_INTERVAL_MS)
}

/** Extensions that identify a sidecar rather than a new asset.
 *  Kept in sync with SIDECAR_EXTENSIONS in
 *  apps/api/services/sidecar_parsers.py.
 *
 *  `.srt` is here because DJI writes per-frame flight telemetry into a file
 *  that merely borrows SubRip syntax — it is not a caption track (§23b). A
 *  genuine subtitle file dropped here is rejected by the parser with an
 *  explanation rather than stored as an empty one. */
const SIDECAR_EXTENSION_RE = /\.(cdl|cc|ccc|ale|xml|srt|cpi|nksc|rmd|bim|cif)$/i

export function isSidecarFile(file: File): boolean {
  return SIDECAR_EXTENSION_RE.test(file.name)
}

/**
 * Camera-card housekeeping files: regenerable indexes and thumbnails that
 * carry nothing a post workflow can use (§23a).
 *
 * Dragging a card folder in bypasses the file picker's `accept=` filter
 * entirely, so before this every one of these reached /upload/initiate and
 * came back as its own 400. They are dropped from the batch instead — not
 * uploaded, not reported per-file.
 *
 * Two things deliberately absent:
 *  - **GoPro `.LRV`** is a ready-made offline-edit proxy, not junk, even
 *    though it sits beside the real junk on a GoPro card.
 *  - AVCHD's empty bundle folders can't appear here at all — a browser hands
 *    over files, never directory entries.
 *
 * `.bmp` is treated as junk (Panasonic writes thumbnails as BMP) even though
 * a BMP could in principle be a real asset: `image/bmp` is not in the API's
 * ALLOWED_MIME_TYPES, so uploading one is a guaranteed 400 today either way.
 * Skipping it loses nothing that currently works.
 */
const JUNK_EXTENSION_RE = /\.(ppn|smi|thm|rtn|bmp)$/i
const JUNK_FILENAMES = new Set([
  'index.mif',      // Canon card index
  'lastclip.txt',   // Panasonic card index
  '.ds_store',      // macOS, not a camera format but identical in effect
  'thumbs.db',      // Windows, same
])

export function isCameraJunkFile(file: File): boolean {
  const name = (file.name.split('/').pop() ?? file.name).toLowerCase()
  if (JUNK_FILENAMES.has(name)) return true
  // AppleDouble resource forks, written whenever a card is touched on a Mac.
  if (name.startsWith('._')) return true
  return JUNK_EXTENSION_RE.test(name)
}

/**
 * Upload sidecars to the filename-matching endpoint instead of creating an
 * asset for them. Returns per-file results so the caller can report the
 * no-match case, which is a real outcome (the clip may simply not be
 * uploaded yet) rather than an error to swallow.
 */
export async function uploadSidecars(
  files: File[],
  projectId: string,
): Promise<Array<{ file: string; ok: boolean; detail: string }>> {
  const results: Array<{ file: string; ok: boolean; detail: string }> = []
  for (const file of files) {
    try {
      const form = new FormData()
      form.append('file', file)
      await api.upload(`/projects/${projectId}/sidecars/match`, form)
      results.push({ file: file.name, ok: true, detail: 'Attached' })
    } catch (err: unknown) {
      const detail =
        err && typeof err === 'object' && 'detail' in err
          ? String((err as { detail: unknown }).detail)
          : err instanceof Error
            ? err.message
            : 'Could not attach sidecar'
      results.push({ file: file.name, ok: false, detail })
    }
  }
  return results
}

export function isMediaFile(file: File): boolean {
  return (
    file.type.startsWith('video/') ||
    file.type.startsWith('audio/') ||
    file.type.startsWith('image/') ||
    file.type === 'movie/x-braw' ||
    file.type === 'movie/x-r3d' ||
    file.type === 'movie/x-arriraw' ||
    file.type === 'application/mxf' ||
    file.type === 'application/octet-stream' ||
    file.type === 'application/x-matroska' ||
    file.type === '' ||
    file.name.match(/\.(mxf|mov|mts|m2ts|braw|r3d|ari|dng|cine|dpx|exr|mkv|prores)$/i) !== null
  )
}

// Shared chunked-upload driver used by both startUpload and
// startVersionUpload. Handles: part-by-part upload with progress, manual
// pause/resume (via manualPauseFlags), and automatic retry-with-backoff on
// transient part failures (dropped wifi, locked screen, brief S3 hiccups) —
// none of which aborts the underlying S3 multipart upload, so already
// uploaded parts are never thrown away for anything short of an explicit
// cancel.
async function runChunkedUpload(params: {
  id: string
  file: File
  controller: AbortController
  updateFile: (fileId: string, patch: Partial<UploadFile>) => void
  initiate: () => Promise<InitiateResponse | VersionInitiateResponse>
  /** §213 — what a previous, interrupted run got to. See `resumeUpload`
   *  on the store: the file has already been matched against it. */
  resumeFrom?: UploadSession | null
  /** §213 — remembered so a resume can go back to the same project and,
   *  for a version upload, the same asset. */
  describe?: {
    projectId: string
    folderId: string | null
    versionOf: string | null
    assetName: string
    handle?: FileSystemFileHandle
  }
}): Promise<void> {
  const { id, file, controller, updateFile, initiate, describe } = params
  let resumeFrom = params.resumeFrom ?? null

  let upload_id: string | undefined
  let s3_key: string | undefined
  let version_id: string | undefined
  let asset_id: string | undefined
  let speedInterval: ReturnType<typeof setInterval> | undefined

  try {
    updateFile(id, { status: 'uploading' })

    // §213 — parts the server already holds, when this is a resume.
    //
    // THE SERVER'S LIST, never a note this app kept about requests it
    // made: a tab that closed mid-upload loses the note without losing the
    // bytes, and re-sending 5,000 parts that are already there is exactly
    // the cost resume exists to avoid.
    const existing = new Map<number, string>()
    let partSize = CHUNK_SIZE

    if (resumeFrom) {
      try {
        const listed = await api.get<{ parts: UploadedPart[] }>(
          `/upload/parts?s3_key=${encodeURIComponent(resumeFrom.s3Key)}` +
            `&upload_id=${encodeURIComponent(resumeFrom.uploadId)}`,
        )
        upload_id = resumeFrom.uploadId
        s3_key = resumeFrom.s3Key
        asset_id = resumeFrom.assetId
        version_id = resumeFrom.versionId
        // The part size the ORIGINAL run used, not a freshly planned one:
        // the server's answer can legitimately change between runs, and
        // re-planning would renumber every remaining part against bytes
        // already stored under the old numbering.
        partSize = resumeFrom.partSize > 0 ? resumeFrom.partSize : CHUNK_SIZE
        // §236 — the same validator the re-list after a `parts_incomplete`
        // uses. See `usablePartsFromListing`: a short part is a partial
        // write and is never trusted on its number alone.
        // `Array.from` rather than iterating the Map directly: this
        // project's tsconfig target predates for..of over a Map.
        for (const [n, etag] of Array.from(
          usablePartsFromListing(listed?.parts ?? [], file.size, partSize).entries(),
        )) {
          existing.set(n, etag)
        }
      } catch (err) {
        if (!isGoneSession(err)) throw err
        // The session is gone, so this is an ordinary first upload of this
        // file. Not a failure: the bytes are right here.
        await deleteSession(resumeFrom.uploadId)
        resumeFrom = null
      }
    }

    if (!upload_id) {
      const initRes = await initiate()
      upload_id = initRes.upload_id
      s3_key = initRes.s3_key
      version_id = initRes.version_id
      asset_id = initRes.asset_id
      // §213 — the server's choice. CHUNK_SIZE only if it is too old to
      // have one.
      partSize = Number(initRes.part_size) > 0 ? Number(initRes.part_size) : CHUNK_SIZE
    }

    // §238 — `s3Key` too. A dismiss of an upload that never finished sends
    // these three to `/upload/abort` so the server can clear the empty
    // version it created, and the key is the one the server chose.
    updateFile(id, {
      uploadId: upload_id,
      assetId: asset_id,
      versionId: version_id,
      s3Key: s3_key,
    })

    const totalChunks = Math.max(1, Math.ceil(file.size / partSize))
    const parts: Array<{ PartNumber: number; ETag: string }> = new Array(totalChunks)
    for (const [n, etag] of Array.from(existing.entries())) {
      parts[n - 1] = { PartNumber: n, ETag: etag }
    }

    // Written BEFORE the first part goes out. A tab closed one second
    // later otherwise leaves a multipart upload nothing can ever find
    // again — and on the web, "find again" is the only way back to it.
    if (describe) {
      const alreadyBytes = bytesHeld(existing, totalChunks, partSize, file.size)
      void saveSession({
        uploadId: upload_id,
        s3Key: s3_key!,
        assetId: asset_id!,
        versionId: version_id!,
        partSize,
        projectId: describe.projectId,
        folderId: describe.folderId,
        versionOf: describe.versionOf,
        assetName: describe.assetName,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        fileType: file.type,
        handle: describe.handle,
        createdAt: resumeFrom?.createdAt ?? Date.now(),
        uploadedBytes: alreadyBytes,
      }).catch(() => {})
    }

    // Progress starts at the bytes already present, not at 0%: a resumed
    // 97 GiB upload that reports 0% is indistinguishable from one that
    // threw everything away.
    bytesUploadedMap[id] = bytesHeld(existing, totalChunks, partSize, file.size)
    updateFile(id, {
      progress: Math.min(95, Math.round((bytesUploadedMap[id] / Math.max(1, file.size)) * 95)),
    })
    speedInterval = startSpeedSampler(id, file.size, updateFile)

    // Small worker pool instead of one part at a time — see CONCURRENT_PARTS
    // above for why. Workers pull the next part number off a shared counter
    // until none are left; each part still goes through the same
    // pause/retry-with-backoff path as before, just several at once.
    //
    // §213 — the counter walks only the MISSING parts.
    // §236 — and it is a function now, because `parts_incomplete` sends us
    // back through it with a second, smaller set.
    const sendParts = async (missing: number[]): Promise<void> => {
      if (!missing.length) return
      let nextIndex = 0
      const claimNextPart = (): number | null => {
        if (nextIndex >= missing.length) return null
        return missing[nextIndex++]
      }

      const partWorker = async (): Promise<void> => {
        let partNumber = claimNextPart()
        while (partNumber !== null) {
          if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')

          const start = (partNumber - 1) * partSize
          const end = Math.min(start + partSize, file.size)
          // A lazy view, not a copy: `Blob.slice` does not read the bytes, so
          // CONCURRENT_PARTS x part_size is not resident even at a 512 MiB
          // part size. (The desktop uploader has to allocate real Buffers and
          // bounds its concurrency accordingly — see workerCountFor there.)
          const chunk = file.slice(start, end)

          const result = await uploadPartWithRetry(id, s3_key!, upload_id!, partNumber, chunk, controller, updateFile)
          parts[result.PartNumber - 1] = result

          bytesUploadedMap[id] = (bytesUploadedMap[id] ?? 0) + chunk.size
          updateFile(id, { progress: Math.min(95, Math.round((bytesUploadedMap[id] / file.size) * 95)) })

          partNumber = claimNextPart()
        }
      }

      const workerCount = Math.max(1, Math.min(CONCURRENT_PARTS, missing.length))
      await Promise.all(Array.from({ length: workerCount }, () => partWorker()))
    }

    const missingNow = (held: Map<number, string>): number[] => {
      const out: number[] = []
      for (let n = 1; n <= totalChunks; n++) if (!held.has(n)) out.push(n)
      return out
    }

    await sendParts(missingNow(existing))

    // §236 — complete, and if the SERVER says the store does not hold the
    // whole file, go back for what it is missing instead of failing.
    //
    // `/upload/complete` builds its part list from storage now, so a 409
    // `parts_incomplete` is the one honest answer this client could not
    // previously act on: every PUT in this tab returned 200 and the parts
    // array here is full, yet the store is short. That happens — a part
    // that a proxy acknowledged and the store never kept, a resumed
    // session whose listing was stale, a part overwritten by a retry that
    // landed short. Re-listing is the only way to find out which, and it
    // is exactly what the §213 resume path already does, so this re-enters
    // it rather than inventing a second mechanism.
    //
    // Deliberately NOT an abort and NOT a failure: the server left the
    // upload open precisely so this can happen, and the bytes already
    // there can be hours of transfer.
    for (let round = 0; ; round++) {
      try {
        await api.post('/upload/complete', {
          s3_key,
          upload_id,
          asset_id,
          version_id,
          // Holes filtered out: a sparse array serialises its gaps as
          // `null`, which a server that still READS this field (one that
          // predates §236, during a rolling deploy) would reject as a
          // validation error instead of completing the upload.
          parts: parts.filter(Boolean),
        })
        break
      } catch (err) {
        if (!isPartsIncomplete(err) || round >= COMPLETE_RESUME_ROUNDS) throw err

        updateFile(id, { status: 'uploading', pauseReason: undefined, error: undefined })

        // THE SERVER'S LIST, again — not the `missing` the 409 named. The
        // response's part numbers are a convenience for a human reading a
        // log; `GET /upload/parts` is the same source of truth /complete
        // itself used, and going back to it means the two cannot disagree
        // about what is already there.
        const listed = await api.get<{ parts: UploadedPart[] }>(
          `/upload/parts?s3_key=${encodeURIComponent(s3_key!)}` +
            `&upload_id=${encodeURIComponent(upload_id!)}`,
        )
        const held = usablePartsFromListing(listed?.parts ?? [], file.size, partSize)
        for (const [n, etag] of Array.from(held.entries())) {
          parts[n - 1] = { PartNumber: n, ETag: etag }
        }

        const stillMissing = missingNow(held)
        if (!stillMissing.length) {
          // Every part is there and the right size, and the server still
          // refuses: re-sending nothing would loop. Surface the server's
          // own message instead.
          throw err
        }

        // Progress goes BACK to what the store actually holds. Leaving it
        // at 100% while parts are re-sent is how a stalled upload looks
        // finished.
        bytesUploadedMap[id] = bytesHeld(held, totalChunks, partSize, file.size)
        updateFile(id, {
          progress: Math.min(95, Math.round((bytesUploadedMap[id] / Math.max(1, file.size)) * 95)),
        })
        await sendParts(stillMissing)
      }
    }
    // Completed, so there is nothing left to resume.
    if (upload_id) void deleteSession(upload_id).catch(() => {})

    if (isMediaFile(file)) {
      updateFile(id, { progress: 100, status: 'processing', processingProgress: 0, speedBps: undefined, etaSeconds: undefined })
    } else {
      updateFile(id, { progress: 100, status: 'complete', speedBps: undefined, etaSeconds: undefined })
    }
  } catch (err) {
    const cancelled = err instanceof DOMException && err.name === 'AbortError'
    if (cancelled) {
      updateFile(id, { status: 'cancelled', progress: 0, pauseReason: undefined, speedBps: undefined, etaSeconds: undefined })
      // §213 — CANCEL is one of the only three things that may end an
      // upload, so this is where the multipart upload is aborted: the
      // parts are freed, the version is marked failed rather than left
      // stuck at `uploading`, and nothing is offered for resume.
      if (upload_id && s3_key && version_id) {
        api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
      }
      if (upload_id) void deleteSession(upload_id).catch(() => {})
    } else {
      const message = err instanceof Error ? err.message : 'Upload failed'
      const resumable = Boolean(upload_id && s3_key && version_id)
      updateFile(id, {
        status: 'failed',
        error: resumable
          ? `${message} — the parts already uploaded are kept; reopen this file to continue`
          : message,
        pauseReason: undefined,
        speedBps: undefined,
        etaSeconds: undefined,
      })
      // §213 — NO ABORT. This used to abort on every failure, which threw
      // away every byte already transferred to make the history page read
      // tidily. The session and its parts are kept instead, and the
      // uploads panel offers it for resume; the version stays
      // `uploading`, which is the truth — it is unfinished, not failed.
      //
      // The cost is explicit: a session nobody ever resumes holds its
      // parts until something reaps them (§215).
    }
  } finally {
    if (speedInterval) clearInterval(speedInterval)
    delete bytesUploadedMap[id]
    delete speedSamples[id]
    delete abortControllers[id]
    delete manualPauseFlags[id]
    delete manualPauseWaiters[id]
  }
}

interface UploadStore {
  files: UploadFile[]
  panelOpen: boolean
  historyLoaded: boolean
  historyHasMore: boolean
  historyLoading: boolean
  historySkip: number
  // asset ids the user has explicitly dismissed from the panel - persisted
  // so a ready/complete upload doesn't reappear on the next fetchHistory()
  // call (e.g. after a reload). The underlying asset is never touched —
  // it's still a real, finished file the user kept, just no longer shown here.
  dismissedHistoryIds: string[]
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  /** §213 — interrupted uploads this browser can still continue. */
  interrupted: UploadSession[]
  startUpload: (file: File, projectId: string, assetName: string, projectName?: string, folderId?: string | null, handle?: FileSystemFileHandle) => string
  startVersionUpload: (file: File, assetId: string, assetName: string, projectId: string) => string
  /** §213 — read the persisted sessions back (any page load). */
  loadInterrupted: () => Promise<void>
  /** §213 — continue one, with the file the user re-selected. Rejects with
   *  a human-readable message if it is not the same file. */
  resumeInterrupted: (uploadId: string, file: File) => Promise<string>
  /** §213 — the user does not want to finish this one. Aborts the
   *  multipart upload so the parts are not left behind, then forgets it. */
  discardInterrupted: (uploadId: string) => Promise<void>
  cancelUpload: (fileId: string) => void
  pauseUpload: (fileId: string) => void
  resumeUpload: (fileId: string) => void
  removeFile: (fileId: string) => void
  clearCompleted: () => void
  fetchHistory: () => Promise<void>
  fetchMoreHistory: () => Promise<void>
  /** §113 — discover in-flight assets outside the recency window. */
  fetchProcessing: () => Promise<void>
  // SSE-driven processing updates
  updateProcessingProgress: (assetId: string, percent: number) => void
  markProcessingComplete: (assetId: string) => void
  markProcessingFailed: (assetId: string, error: string) => void
  // Fallback poll: re-check processing items from backend (catches missed SSE events)
  refreshProcessingItems: () => Promise<void>
}

function mapProcessingStatus(status: string): UploadStatus {
  switch (status) {
    case 'uploading': return 'uploading'
    case 'processing': return 'processing'
    case 'ready': return 'complete'
    case 'failed': return 'failed'
    default: return 'complete'
  }
}

function mimeFromAssetType(assetType: string): string {
  switch (assetType) {
    case 'video': return 'video/mp4'
    case 'audio': return 'audio/mpeg'
    case 'image':
    case 'image_carousel': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

function mergeHistoryAssets(
  existing: UploadFile[],
  assets: AssetResponse[],
  dismissedIds: string[],
): UploadFile[] {
  const existingAssetIds = new Set(existing.map((f) => f.assetId).filter(Boolean))
  const dismissed = new Set(dismissedIds)
  const newFiles: UploadFile[] = assets
    .filter((a) => a.latest_version && !existingAssetIds.has(a.id) && !dismissed.has(a.id))
    .map((a) => {
      const v = a.latest_version!
      const file = v.files?.[0]
      return {
        id: `history-${a.id}`,
        fileName: file?.original_filename ?? a.name,
        fileSize: file?.file_size_bytes ?? 0,
        fileType: file?.mime_type ?? mimeFromAssetType(a.asset_type),
        projectId: a.project_id,
        assetName: a.name,
        // §238 — 100 is right for everything this list discovers EXCEPT a
        // version still at `uploading`, which `/me/assets?processing=true`
        // returns too (its `in_flight` set is uploading + processing).
        // A hardcoded 100 on one of those is where the uploads panel's
        // "Uploading 100%" row came from: an upload abandoned the day
        // before, with no transfer happening and no way for this tab to
        // continue it (the File is gone), reading as a finished one.
        //
        // 0 rather than a guess: this browser has no idea how many bytes
        // of someone else's interrupted upload are at the store, and the
        // only thing that does know is `GET /upload/parts` — which belongs
        // to the resume path (§213), not to a history row. See the §238
        // report for the rest of that entry's story.
        progress: v.processing_status === 'uploading' ? 0 : 100,
        // §113 — the real, persisted percent when the server has one. It used
        // to be a 0/100 guess from the status alone, so a rediscovered job
        // always read 0% however far along it actually was. `?? ` and not
        // `||`: 0 is a real percent and must survive.
        processingProgress: v.processing_status === 'ready'
          ? 100
          : (v.processing_progress ?? 0),
        status: mapProcessingStatus(v.processing_status),
        assetId: a.id,
        versionId: v.id,
        createdAt: new Date(v.created_at).getTime(),
      }
    })
  return [...existing, ...newFiles]
}

const storeCreator: StateCreator<UploadStore, [['zustand/persist', unknown]]> = (set, get) => ({
  files: [],
  panelOpen: false,
  historyLoaded: false,
  historyHasMore: true,
  historyLoading: false,
  historySkip: 0,
  dismissedHistoryIds: [],
  interrupted: [],

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  startUpload: (file, projectId, assetName, projectName, folderId, handle) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const entry: UploadFile = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      projectId,
      projectName,
      assetName,
      progress: 0,
      processingProgress: 0,
      status: 'pending',
      // §238 — this upload creates the asset (`/upload/initiate` does),
      // so dismissing it later may clean that asset up. The new-version
      // path below sets this to false for the opposite reason.
      createdAsset: true,
      createdAt: Date.now(),
    }

    set((s) => ({ files: [entry, ...s.files], panelOpen: true }))

    const updateFile = (fileId: string, patch: Partial<UploadFile>) => {
      set((s) => ({
        files: s.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)),
      }))
    }

    const controller = new AbortController()
    abortControllers[id] = controller

    void runChunkedUpload({
      id,
      file,
      controller,
      updateFile,
      // §213 — what a resume needs that the File object cannot tell us:
      // where this was going.
      describe: {
        projectId,
        folderId: folderId ?? null,
        versionOf: null,
        assetName,
        // §213 — present only where the browser gave one (Chromium, loose
        // dropped file). Everywhere else a resume is a file picker, which
        // is why `canStoreFileHandles` exists and nothing depends on this.
        handle,
      },
      initiate: () =>
        withInitiateSlot(projectId, () =>
          api.post<InitiateResponse>('/upload/initiate', {
            project_id: projectId,
            asset_name: assetName,
            original_filename: file.name,
            file_size_bytes: file.size,
            mime_type: file.type,
            folder_id: folderId ?? null,
          }),
        ),
    }).finally(() => { void get().loadInterrupted() })

    return id
  },

  startVersionUpload: (file, assetId, assetName, projectId) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: UploadFile = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      projectId,
      assetName,
      progress: 0,
      processingProgress: 0,
      status: 'pending',
      assetId,
      // §238 — the asset already existed and this is one more version of
      // it. Dismissing this row must never delete it: that asset carries
      // every other version, comment and approval of the file.
      createdAsset: false,
      createdAt: Date.now(),
    }
    set((s) => ({ files: [entry, ...s.files], panelOpen: true }))

    const updateFile = (fileId: string, patch: Partial<UploadFile>) => {
      set((s) => ({ files: s.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }))
    }

    const controller = new AbortController()
    abortControllers[id] = controller

    void runChunkedUpload({
      id,
      file,
      controller,
      updateFile,
      describe: {
        projectId,
        folderId: null,
        // A resumed version upload must land on the SAME asset. Without
        // this it would come back as a brand new asset with the same
        // name, which is a different file as far as the app is concerned.
        versionOf: assetId,
        assetName,
      },
      initiate: () =>
        api.post<VersionInitiateResponse>(`/assets/${assetId}/versions`, {
          project_id: projectId,
          asset_name: assetName,
          original_filename: file.name,
          file_size_bytes: file.size,
          mime_type: file.type,
        }),
    }).finally(() => { void get().loadInterrupted() })

    return id
  },

  /**
   * §213 — the interrupted uploads this browser remembers.
   *
   * Read on any page load, by the uploads panel. A session whose file the
   * user never re-selects simply sits here; it is not an error state and
   * it is not shown as a failure.
   */
  loadInterrupted: async () => {
    // In-flight uploads have a session too (it is written before the first
    // part), and offering to "resume" something that is running would be
    // nonsense. Filtered against what this tab is doing right now.
    const live = new Set(
      get()
        .files.filter((f) => f.status === 'uploading' || f.status === 'paused' || f.status === 'pending')
        .map((f) => f.uploadId)
        .filter(Boolean) as string[],
    )
    const all = await listSessions()
    set({ interrupted: all.filter((x) => !live.has(x.uploadId)) })
  },

  resumeInterrupted: async (uploadId, file) => {
    const session = (await listSessions()).find((x) => x.uploadId === uploadId)
    if (!session) throw new Error('That upload is no longer available to resume.')
    // §213 — the file is checked BEFORE a byte is sent. Resuming the wrong
    // file into a half-finished session splices two different files into
    // one object and then completes it as if it were whole: a corrupt
    // asset that passes every check the app has.
    if (!fileMatchesSession(file, session)) {
      throw new Error(
        `That is not the same file. This upload was "${session.fileName}" ` +
          `(${session.fileSize.toLocaleString()} bytes). Choose that exact file to continue, ` +
          'or discard the interrupted upload and start a new one.',
      )
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const entry: UploadFile = {
      id,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || session.fileType,
      projectId: session.projectId,
      assetName: session.assetName,
      progress: 0,
      processingProgress: 0,
      status: 'pending',
      assetId: session.assetId,
      versionId: session.versionId,
      uploadId: session.uploadId,
      s3Key: session.s3Key,
      // §238 — the session remembers which kind of upload this was, and
      // `versionOf` is exactly that question: set means "a new version of
      // an existing asset", null means this upload created the asset.
      createdAsset: !session.versionOf,
      createdAt: Date.now(),
    }
    set((st) => ({ files: [entry, ...st.files], panelOpen: true }))

    const updateFile = (fileId: string, patch: Partial<UploadFile>) => {
      set((st) => ({ files: st.files.map((f) => (f.id === fileId ? { ...f, ...patch } : f)) }))
    }

    const controller = new AbortController()
    abortControllers[id] = controller

    void runChunkedUpload({
      id,
      file,
      controller,
      updateFile,
      resumeFrom: session,
      describe: {
        projectId: session.projectId,
        folderId: session.folderId,
        versionOf: session.versionOf,
        assetName: session.assetName,
        handle: session.handle,
      },
      // Only reached if the session turned out to be gone, in which case
      // this is an ordinary first upload of the same file to the same
      // place — including, for a version upload, the same asset.
      initiate: () =>
        session.versionOf
          ? api.post<VersionInitiateResponse>(`/assets/${session.versionOf}/versions`, {
              project_id: session.projectId,
              asset_name: session.assetName,
              original_filename: file.name,
              file_size_bytes: file.size,
              mime_type: file.type,
            })
          : withInitiateSlot(session.projectId, () =>
              api.post<InitiateResponse>('/upload/initiate', {
                project_id: session.projectId,
                asset_name: session.assetName,
                original_filename: file.name,
                file_size_bytes: file.size,
                mime_type: file.type,
                folder_id: session.folderId,
              }),
            ),
    }).finally(() => { void get().loadInterrupted() })

    set((st) => ({ interrupted: st.interrupted.filter((x) => x.uploadId !== uploadId) }))
    return id
  },

  discardInterrupted: async (uploadId) => {
    const session = (await listSessions()).find((x) => x.uploadId === uploadId)
    if (session) {
      // Aborted, not merely forgotten. §213 keeps sessions alive precisely
      // so they can be resumed, which means a session nobody will resume
      // holds its parts in the bucket until §215 reaps it — so when the
      // user says they are done with it, say so to the server.
      await api
        .post('/upload/abort', {
          s3_key: session.s3Key,
          upload_id: session.uploadId,
          version_id: session.versionId,
        })
        .catch(() => {})
      await deleteSession(uploadId)
    }
    set((st) => ({ interrupted: st.interrupted.filter((x) => x.uploadId !== uploadId) }))
  },

  cancelUpload: (fileId) => {
    abortControllers[fileId]?.abort()
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId ? { ...f, status: 'cancelled' as const, progress: 0, pauseReason: undefined } : f,
      ),
    }))
  },

  pauseUpload: (fileId) => {
    manualPauseFlags[fileId] = true
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId && (f.status === 'uploading' || (f.status === 'paused' && f.pauseReason === 'retrying'))
          ? { ...f, status: 'paused' as const, pauseReason: 'manual' as const, error: undefined }
          : f,
      ),
    }))
  },

  resumeUpload: (fileId) => {
    manualPauseFlags[fileId] = false
    const wake = manualPauseWaiters[fileId]
    manualPauseWaiters[fileId] = undefined
    wake?.()
    set((s) => ({
      files: s.files.map((f) =>
        f.id === fileId && f.status === 'paused' && f.pauseReason === 'manual'
          ? { ...f, status: 'uploading' as const, pauseReason: undefined }
          : f,
      ),
    }))
  },

  removeFile: (fileId) => {
    const target = get().files.find((f) => f.id === fileId)
    set((s) => ({ files: s.files.filter((f) => f.id !== fileId) }))
    const dead = target?.status === 'failed' || target?.status === 'cancelled'
    // §238 — WHOSE asset is it?
    //
    // A failed/cancelled upload already has a real asset+version row on the
    // backend (created by /upload/initiate before any bytes transfer), so
    // just dropping it from local state isn't enough — fetchHistory() would
    // fetch it right back from /me/assets on the next panel open or page
    // reload.
    //
    // For a FIRST upload that asset is this upload's own leftover, and
    // soft-deleting it (the same way the asset browser's own delete does)
    // is the only way the user can clear it. That is what this did for
    // every dismissal — including a new-version upload, whose `assetId` is
    // the EXISTING asset. Dismissing a cancelled new version therefore
    // deleted the whole file: every other version, every comment, every
    // approval. Reported from production, and the reason `createdAsset`
    // exists.
    if (dead && target?.assetId && target.createdAsset === true) {
      api.delete(`/assets/${target.assetId}`).catch(() => {})
    } else if (dead && target?.assetId) {
      // A new-version upload — or a row persisted by a build that predates
      // `createdAsset`, where the honest answer is "we do not know" and
      // the safe one is the same: NEVER delete the asset.
      //
      // The empty version the upload left behind is still worth clearing,
      // and `/upload/abort` is what does it: for a version of an asset
      // that has others, the server removes the row and frees its number
      // (§238). Only when this row still carries the three ids the server
      // binds together — a persisted row from before this change has no
      // `s3Key`, and then there is nothing safe to send. The version list
      // shows such a version as "Upload incomplete" with a Delete, which
      // is the way back.
      if (target.versionId && target.s3Key && target.uploadId) {
        api
          .post('/upload/abort', {
            s3_key: target.s3Key,
            upload_id: target.uploadId,
            version_id: target.versionId,
          })
          .catch(() => {})
        void deleteSession(target.uploadId).catch(() => {})
      }
      // Remembered as dismissed, so the dismissal sticks across a reload
      // without anything being deleted — the same mechanism a finished
      // upload's dismissal uses below.
      set((s) => ({
        dismissedHistoryIds: s.dismissedHistoryIds.includes(target.assetId!)
          ? s.dismissedHistoryIds
          : [...s.dismissedHistoryIds, target.assetId!],
      }))
    } else if (target?.assetId && target.status === 'complete') {
      // Ready/finished upload — the asset itself stays untouched (the user
      // still wants the file), but remember it was dismissed so fetchHistory()
      // doesn't pull it right back in on the next panel open or page reload.
      set((s) => ({
        dismissedHistoryIds: s.dismissedHistoryIds.includes(target.assetId!)
          ? s.dismissedHistoryIds
          : [...s.dismissedHistoryIds, target.assetId!],
      }))
    }
  },

  clearCompleted: () => {
    const completedIds = get().files.filter((f) => f.status === 'complete' && f.assetId).map((f) => f.assetId!)
    set((s) => ({
      files: s.files.filter((f) => f.status !== 'complete'),
      dismissedHistoryIds: Array.from(new Set([...s.dismissedHistoryIds, ...completedIds])),
    }))
  },

  /**
   * §113 — everything of this user's that is still in flight, regardless of
   * how recent it is.
   *
   * The history pages below are ordered by recency, 20 at a time, and further
   * pages only load as the user scrolls. A still-processing asset that has
   * fallen outside the fetched window therefore never re-enters this list
   * after a reload — absent entirely, not stuck at 0% — while its own detail
   * view shows the truth. Neither the 5s poll nor the SSE handlers can
   * recover it: both only update items already present.
   *
   * Runs IN ADDITION TO the history fetch, not instead of it, and merges
   * through the same path, so nothing about the recency list changes.
   */
  fetchProcessing: async () => {
    try {
      const assets = await api.get<AssetResponse[]>('/me/assets?processing=true')
      if (!assets.length) return
      set((s) => ({ files: mergeHistoryAssets(s.files, assets, s.dismissedHistoryIds) }))
    } catch {
      // Discovery is best-effort: failing it must not stop the panel opening.
    }
  },

  fetchHistory: async () => {
    if (get().historyLoaded) return
    set({ historyLoading: true })
    try {
      const assets = await api.get<AssetResponse[]>(`/me/assets?skip=0&limit=${HISTORY_PAGE_SIZE}`)
      const merged = mergeHistoryAssets(get().files, assets, get().dismissedHistoryIds)
      set({
        historyLoaded: true,
        historyLoading: false,
        historySkip: HISTORY_PAGE_SIZE,
        historyHasMore: assets.length >= HISTORY_PAGE_SIZE,
        files: merged,
      })
    } catch {
      set({ historyLoaded: true, historyLoading: false })
    }
  },

  fetchMoreHistory: async () => {
    const { historyHasMore, historyLoading, historySkip } = get()
    if (!historyHasMore || historyLoading) return
    set({ historyLoading: true })
    try {
      const assets = await api.get<AssetResponse[]>(`/me/assets?skip=${historySkip}&limit=${HISTORY_PAGE_SIZE}`)
      const merged = mergeHistoryAssets(get().files, assets, get().dismissedHistoryIds)
      set((s) => ({
        historyLoading: false,
        historySkip: s.historySkip + HISTORY_PAGE_SIZE,
        historyHasMore: assets.length >= HISTORY_PAGE_SIZE,
        files: merged,
      }))
    } catch {
      set({ historyLoading: false })
    }
  },

  updateProcessingProgress: (assetId, percent) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, processingProgress: percent }
          : f,
      ),
    }))
  },

  markProcessingComplete: (assetId) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, status: 'complete' as const, processingProgress: 100 }
          : f,
      ),
    }))
  },

  markProcessingFailed: (assetId, error) => {
    set((s) => ({
      files: s.files.map((f) =>
        f.assetId === assetId && f.status === 'processing'
          ? { ...f, status: 'failed' as const, error }
          : f,
      ),
    }))
  },

  refreshProcessingItems: async () => {
    // §117 — an item that can never finish must eventually stop being polled.
    //
    // This poll runs every 5s from a layout-level bridge, over a store that
    // is PERSISTED in localStorage, for every file still marked 'processing'
    // — regardless of which page is open. So an asset that never leaves
    // 'processing' is re-fetched every 5 seconds, forever, on every page,
    // across reloads, by asset id. That is what produced repeated requests
    // for an unrelated asset id while viewing a different asset, and it was
    // invisible because every error here is swallowed.
    //
    // It became permanent rather than rare because process_asset was not a
    // registered Celery task (§115), so nothing ever moved these rows out of
    // 'processing'. The registration is fixed; this is the floor that stops
    // the client spinning regardless of why the server went quiet.
    const now = Date.now()
    const stale = get().files.filter(
      (f) => f.status === 'processing' && f.assetId && now - f.createdAt > PROCESSING_POLL_MAX_MS,
    )
    if (stale.length) {
      const staleIds = new Set(stale.map((f) => f.id))
      set((s) => ({
        files: s.files.map((f) =>
          staleIds.has(f.id)
            ? { ...f, status: 'failed' as const, error: 'Processing did not finish. Try re-uploading.' }
            : f,
        ),
      }))
    }

    // No age filter needed here: the block above has already flipped every
    // over-age item to 'failed', and zustand's set is synchronous, so this
    // read cannot still see one as 'processing'. A second age check would be
    // unreachable code that looks load-bearing.
    const processingFiles = get().files.filter((f) => f.status === 'processing' && f.assetId)
    if (!processingFiles.length) return
    try {
      const results = await Promise.all(
        processingFiles.map((f) =>
          api.get<AssetResponse>(`/assets/${f.assetId}`).catch(() => null),
        ),
      )
      set((s) => ({
        files: s.files.map((f) => {
          if (f.status !== 'processing' || !f.assetId) return f
          const idx = processingFiles.findIndex((pf) => pf.assetId === f.assetId)
          const asset = idx >= 0 ? results[idx] : null
          if (!asset?.latest_version) return f
          const status = mapProcessingStatus(asset.latest_version.processing_status)
          const pct = asset.latest_version.processing_progress
          // §113 — still processing is no longer a dead end for this poll: it
          // now carries a real percent, which is what advances the bar when
          // SSE is not connected (a reload, a backgrounded tab).
          if (status === 'processing') {
            return pct == null || pct === f.processingProgress ? f : { ...f, processingProgress: pct }
          }
          return { ...f, status, processingProgress: status === 'complete' ? 100 : 0 }
        }),
      }))
    } catch {
      // SSE is the primary mechanism; ignore poll errors
    }
  },
})

/**
 * Bounded, project-aware gate around POST /upload/initiate (§27).
 *
 * Dropping a batch previously fired one initiate per file in the same
 * synchronous loop — N unbounded requests at four Gunicorn workers. On a
 * project whose storage prefix was not yet locked, they also contended on
 * one project row and most of them came back 500 (a Postgres deadlock; see
 * routers/upload.py for the mechanism and the server-side fix).
 *
 * Two rules, in order:
 *
 * 1. The FIRST initiate for a project runs alone. Once it returns, that
 *    project's prefix is committed, so every later initiate in the batch
 *    just reads it. This is the rule that protects a fresh project, and it
 *    holds even if the server-side ordering fix were ever reverted.
 * 2. After that, at most INITIATE_CONCURRENCY at a time — same reasoning as
 *    CONCURRENT_PARTS above: enough to keep the pipe busy, not enough to
 *    make a 60-file drop a load test.
 *
 * Deliberately wraps only the initiate call. Part uploads stay as parallel
 * as they ever were; serialising those would make a batch far slower for no
 * reason.
 */
const INITIATE_CONCURRENCY = 3
let initiateActive = 0
const initiateWaiting: Array<() => void> = []
/** projectId -> the in-flight first initiate for that project. */
const firstInitiate = new Map<string, Promise<unknown>>()

async function withInitiateSlot<T>(projectId: string, run: () => Promise<T>): Promise<T> {
  const leader = !firstInitiate.has(projectId)
  if (!leader) {
    // Whether it succeeded or failed, the prefix question is settled by the
    // time it resolves — a rejection must not strand the rest of the batch.
    await firstInitiate.get(projectId)!.catch(() => {})
  }

  while (initiateActive >= INITIATE_CONCURRENCY) {
    await new Promise<void>((resolve) => initiateWaiting.push(resolve))
  }
  initiateActive += 1

  const call = (async () => {
    try {
      return await run()
    } finally {
      initiateActive -= 1
      initiateWaiting.shift()?.()
    }
  })()

  if (leader) firstInitiate.set(projectId, call)
  return call
}

export const useUploadStore = create<UploadStore>()(
  persist(storeCreator, {
    name: 'ff-uploads',
    // Only persist failed/cancelled items — in-progress (including paused)
    // uploads can't survive a page reload since the underlying File object
    // is lost, and successful ones are fetched from the API history on
    // panel open. dismissedHistoryIds is also persisted so a dismissal
    // survives a reload too.
    partialize: (state: UploadStore) => ({
      files: state.files.filter(
        (f: UploadFile) => f.status === 'failed' || f.status === 'cancelled',
      ),
      dismissedHistoryIds: state.dismissedHistoryIds,
    }),
  }),
)
