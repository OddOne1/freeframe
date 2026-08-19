import { create, type StateCreator } from 'zustand'
import { persist } from 'zustand/middleware'
import { api } from '@/lib/api'
import type { AssetResponse } from '@/types'

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
}

interface VersionInitiateResponse {
  upload_id: string
  s3_key: string
  asset_id: string
  version_id: string
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
      attempt++
      updateFile(id, {
        status: 'paused',
        pauseReason: 'retrying',
        error: `Part ${partNumber} interrupted — retrying (attempt ${attempt})…`,
      })
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
}): Promise<void> {
  const { id, file, controller, updateFile, initiate } = params

  let upload_id: string | undefined
  let s3_key: string | undefined
  let version_id: string | undefined
  let asset_id: string | undefined
  let speedInterval: ReturnType<typeof setInterval> | undefined

  try {
    updateFile(id, { status: 'uploading' })

    const initRes = await initiate()
    upload_id = initRes.upload_id
    s3_key = initRes.s3_key
    version_id = initRes.version_id
    asset_id = initRes.asset_id

    updateFile(id, { uploadId: upload_id, assetId: asset_id, versionId: version_id })

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    const parts: Array<{ PartNumber: number; ETag: string }> = new Array(totalChunks)

    bytesUploadedMap[id] = 0
    speedInterval = startSpeedSampler(id, file.size, updateFile)

    // Small worker pool instead of one part at a time — see CONCURRENT_PARTS
    // above for why. Workers pull the next part number off a shared counter
    // until none are left; each part still goes through the same
    // pause/retry-with-backoff path as before, just several at once.
    let nextPartNumber = 1
    const claimNextPart = (): number | null => {
      if (nextPartNumber > totalChunks) return null
      return nextPartNumber++
    }

    const partWorker = async (): Promise<void> => {
      let partNumber = claimNextPart()
      while (partNumber !== null) {
        if (controller.signal.aborted) throw new DOMException('Upload cancelled', 'AbortError')

        const start = (partNumber - 1) * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, file.size)
        const chunk = file.slice(start, end)

        const result = await uploadPartWithRetry(id, s3_key!, upload_id!, partNumber, chunk, controller, updateFile)
        parts[result.PartNumber - 1] = result

        bytesUploadedMap[id] = (bytesUploadedMap[id] ?? 0) + chunk.size
        updateFile(id, { progress: Math.min(95, Math.round((bytesUploadedMap[id] / file.size) * 95)) })

        partNumber = claimNextPart()
      }
    }

    const workerCount = Math.min(CONCURRENT_PARTS, totalChunks)
    await Promise.all(Array.from({ length: workerCount }, () => partWorker()))

    await api.post('/upload/complete', {
      s3_key,
      upload_id,
      asset_id,
      version_id,
      parts,
    })

    if (isMediaFile(file)) {
      updateFile(id, { progress: 100, status: 'processing', processingProgress: 0, speedBps: undefined, etaSeconds: undefined })
    } else {
      updateFile(id, { progress: 100, status: 'complete', speedBps: undefined, etaSeconds: undefined })
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      updateFile(id, { status: 'cancelled', progress: 0, pauseReason: undefined, speedBps: undefined, etaSeconds: undefined })
    } else {
      const message = err instanceof Error ? err.message : 'Upload failed'
      updateFile(id, { status: 'failed', error: message, pauseReason: undefined, speedBps: undefined, etaSeconds: undefined })
    }
    // Notify backend so the version is marked failed (not stuck at uploading).
    // This ensures post-refresh history shows the item in "Failed", not "Active".
    if (upload_id && s3_key && version_id) {
      api.post('/upload/abort', { s3_key, upload_id, version_id }).catch(() => {})
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
  startUpload: (file: File, projectId: string, assetName: string, projectName?: string, folderId?: string | null) => string
  startVersionUpload: (file: File, assetId: string, assetName: string, projectId: string) => string
  cancelUpload: (fileId: string) => void
  pauseUpload: (fileId: string) => void
  resumeUpload: (fileId: string) => void
  removeFile: (fileId: string) => void
  clearCompleted: () => void
  fetchHistory: () => Promise<void>
  fetchMoreHistory: () => Promise<void>
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
        progress: 100,
        processingProgress: v.processing_status === 'ready' ? 100 : 0,
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

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  startUpload: (file, projectId, assetName, projectName, folderId) => {
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
    })

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
      initiate: () =>
        api.post<VersionInitiateResponse>(`/assets/${assetId}/versions`, {
          project_id: projectId,
          asset_name: assetName,
          original_filename: file.name,
          file_size_bytes: file.size,
          mime_type: file.type,
        }),
    })

    return id
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
    // A failed/cancelled upload already has a real asset+version row on the
    // backend (created by /upload/initiate before any bytes transfer), so
    // just dropping it from local state isn't enough — fetchHistory() would
    // fetch it right back from /me/assets on the next panel open or page
    // reload. Soft-delete it the same way the asset browser's own delete
    // does, so it actually disappears.
    if (target?.assetId && (target.status === 'failed' || target.status === 'cancelled')) {
      api.delete(`/assets/${target.assetId}`).catch(() => {})
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
          if (status === 'processing') return f
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
