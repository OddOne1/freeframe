/**
 * The SocialSnippet Files tab's rules, as pure functions: the processing-time
 * estimate, the status chip's words, which rows can be picked, when the list
 * has to keep polling, and the tab's search, filter chips, sort, folder
 * groups and URL state. No React, so each is tested on its own.
 */
import type {
  SnippetDetectSummary,
  SnippetFile,
  SnippetFileStatus,
  SnippetFilesResponse,
  SnippetTrack,
} from '@/types'

/**
 * How many times faster than real time the server's CPU transcribes ONE
 * audio track. Measured on speech-dense audio at about 1.6x (a 57-minute
 * track took 35 minutes) and rounded down to 1.5, so a 30-minute track
 * reads as about 20 minutes. Still AN ESTIMATE; every place it is shown says
 * so. The one number to change when the worker's hardware does.
 */
export const SERVER_CPU_SPEED_FACTOR = 1.5

/** POST /snippet/process takes at most this many assets per request. */
export const MAX_PROCESS_BATCH = 20

/** How often the list is re-read while a file is queued or running. */
export const POLL_INTERVAL_MS = 5000

export interface ProcessingEstimate {
  /** Whole minutes, rounded up; 0 when no file has a known length. */
  minutes: number
  /** Files whose length was never measured, so not in `minutes`. */
  unknown: number
}

/** One file for the estimate: its length, and how many tracks are still to
 *  transcribe when the files list says (null or left out: count it once). */
export interface EstimateItem {
  durationMs: number | null | undefined
  tracks?: number | null
}

/**
 * How many tracks a run of this file transcribes, from the files list:
 * `force` (Reprocess) redoes every planned track, otherwise the tracks
 * already done (transcribed, or found to have no speech) are kept. Null
 * when the list does not know the file's tracks.
 */
export function tracksToTranscribe(
  f: Pick<SnippetFile, 'planned_track_count' | 'done_track_count'>,
  force: boolean,
): number | null {
  if (f.planned_track_count == null) return null
  if (force) return f.planned_track_count
  return Math.max(0, f.planned_track_count - (f.done_track_count ?? 0))
}

/**
 * Roughly how long the server needs for these files: duration × tracks still
 * to transcribe / factor, where a file whose track count is unknown counts
 * once. A file with nothing left to transcribe (only the quick final stages)
 * still makes it at least a minute rather than "unknown".
 */
export function estimateProcessing(
  items: (EstimateItem | number | null | undefined)[],
  factor: number = SERVER_CPU_SPEED_FACTOR,
): ProcessingEstimate {
  let ms = 0
  let unknown = 0
  let known = 0
  for (const item of items) {
    const { durationMs: d, tracks } =
      typeof item === 'object' && item !== null ? item : { durationMs: item, tracks: null }
    if (d == null || !Number.isFinite(d) || d <= 0) {
      unknown += 1
      continue
    }
    known += 1
    ms += d * (tracks != null && Number.isFinite(tracks) && tracks >= 0 ? tracks : 1)
  }
  return { minutes: known > 0 ? Math.max(1, Math.ceil(ms / factor / 60_000)) : 0, unknown }
}

/** "about 12 min on the server CPU", or "about 1 h 05 min …" past an hour. */
export function formatEstimate(e: ProcessingEstimate): string {
  if (e.minutes === 0) return 'an unknown time on the server CPU (no file length is known)'
  const span =
    e.minutes < 60
      ? `${e.minutes} min`
      : `${Math.floor(e.minutes / 60)} h ${String(e.minutes % 60).padStart(2, '0')} min`
  const tail =
    e.unknown > 0 ? `, plus ${e.unknown} ${e.unknown === 1 ? 'file' : 'files'} of unknown length` : ''
  return `about ${span} on the server CPU${tail}`
}

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

const LABELS: Record<SnippetFileStatus, { label: string; tone: StatusTone }> = {
  not_processed: { label: 'Not processed', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Processing', tone: 'info' },
  done: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
}

/**
 * The status chip. A file whose own upload or transcode is not finished says
 * so instead, since that is what stops it; a finished transcript whose clip
 * detection failed is "Done" with a warning, because the transcript is good;
 * a file done with no segments at all had no speech on any track.
 */
export function statusLabel(
  f: Pick<SnippetFile, 'snippet_status' | 'error' | 'not_ready_reason' | 'segment_count'>,
): { label: string; tone: StatusTone } {
  if (f.not_ready_reason && f.snippet_status === 'not_processed') {
    return { label: 'Not ready', tone: 'neutral' }
  }
  if (f.snippet_status === 'done' && f.error) return { label: 'Done, no new clips', tone: 'warning' }
  if (f.snippet_status === 'done' && f.segment_count === 0) {
    return { label: 'Done, no speech found', tone: 'neutral' }
  }
  return LABELS[f.snippet_status] ?? { label: f.snippet_status, tone: 'neutral' }
}

export const isActive = (s: SnippetFileStatus) => s === 'queued' || s === 'running'

/** Keep polling while any listed file is queued or running. */
export function anyActive(files: Pick<SnippetFile, 'snippet_status'>[] | undefined): boolean {
  return (files ?? []).some((f) => isActive(f.snippet_status))
}

/** A row can be ticked for "Process selected" when the file is ready and not
 *  already queued or running. */
export function canSelect(f: Pick<SnippetFile, 'asset_status' | 'snippet_status' | 'media_file_id'>): boolean {
  return f.asset_status === 'ready' && f.media_file_id != null && !isActive(f.snippet_status)
}

/** Retry never forces: the server resumes a failed or interrupted file
 *  (finished stages are kept) even when an older transcript is still there.
 *  Only Reprocess starts from scratch. */
export const RETRY_FORCES = false

/** A file's length: "4:05", or "1:12:00" from an hour up. */
export function formatLength(ms: number): string {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** One line for the toast after naming a speaker. */
export function detectSummaryText(d: SnippetDetectSummary | undefined | null): string {
  if (!d) return 'Speaker saved.'
  if (!d.ran) return `Speaker saved. ${d.reason ?? 'Clips were not re-detected.'}`
  if (d.created === 0 && d.removed === 0) return 'Speaker saved. No clip suggestions changed.'
  return `Speaker saved. Clip suggestions re-detected: ${d.created} new, ${d.removed} replaced.`
}

// ─── Loading the whole list ──────────────────────────────────────────────────

/** The files endpoint's largest page. */
export const FILES_PAGE_SIZE = 100
/** The tab reads at most this many files (five pages); filters, counts and
 *  sorting work on what it read. */
export const FILES_LOAD_LIMIT = 500

/**
 * Reads every page of the files list, up to `limit` files: page 1 first (it
 * carries the total), then the rest in parallel. A file that moved between
 * pages while they were read (the list is live) is kept once.
 */
export async function fetchAllFiles(
  getPage: (page: number, pageSize: number) => Promise<SnippetFilesResponse>,
  { pageSize = FILES_PAGE_SIZE, limit = FILES_LOAD_LIMIT }: { pageSize?: number; limit?: number } = {},
): Promise<SnippetFilesResponse> {
  const first = await getPage(1, pageSize)
  const pages = Math.min(Math.ceil(first.total / pageSize), Math.ceil(limit / pageSize))
  const rest = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) => getPage(i + 2, pageSize)))
  const seen = new Set<string>()
  const items: SnippetFile[] = []
  for (const f of [first, ...rest].flatMap((r) => r.items)) {
    if (seen.has(f.asset_id) || items.length >= limit) continue
    seen.add(f.asset_id)
    items.push(f)
  }
  return { total: first.total, items }
}

// ─── Speakers per track ──────────────────────────────────────────────────────

/** The server ends a track's label in "no speech" when the last run found none. */
export function trackHasSpeech(t: Pick<SnippetTrack, 'label'>): boolean {
  return !/\bno speech\s*$/i.test(t.label)
}

/** A track still waiting for a name: it may have speech and has no speaker. */
export function trackNeedsSpeaker(t: Pick<SnippetTrack, 'label' | 'speaker_id'>): boolean {
  return t.speaker_id == null && trackHasSpeech(t)
}

/** A file needs a speaker name when any track that may hold speech has none.
 *  A track found to have no speech never counts. */
export function needsSpeaker(f: Pick<SnippetFile, 'tracks'>): boolean {
  return f.tracks.some(trackNeedsSpeaker)
}

/** "Track 1" for track index 0: what the speaker selects are labelled with. */
export const trackName = (t: Pick<SnippetTrack, 'track_index'>) => `Track ${t.track_index + 1}`

// ─── Filter, search, sort, group ─────────────────────────────────────────────

export type FileFilter = 'all' | 'attention' | 'processing' | 'done' | 'not_processed' | 'needs_speaker'

export const FILE_FILTERS: { value: FileFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'processing', label: 'Processing' },
  { value: 'done', label: 'Done' },
  { value: 'not_processed', label: 'Not processed' },
  { value: 'needs_speaker', label: 'Needs speaker name' },
]

export function matchesFilter(f: SnippetFile, filter: FileFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'attention':
      return f.snippet_status === 'failed'
    case 'processing':
      return isActive(f.snippet_status)
    case 'done':
      return f.snippet_status === 'done'
    case 'not_processed':
      return f.snippet_status === 'not_processed'
    case 'needs_speaker':
      return needsSpeaker(f)
  }
}

/** Case-insensitive part of the file name or of the folder path in the row.
 *  The server's `q` matches names only; the folder part is matched here. */
export function matchesSearch(f: Pick<SnippetFile, 'name' | 'folder_path'>, q: string): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return f.name.toLowerCase().includes(needle) || folderLabel(f.folder_path).toLowerCase().includes(needle)
}

/** How many files each chip would show (after the search). */
export function filterCounts(files: SnippetFile[]): Record<FileFilter, number> {
  const counts = Object.fromEntries(FILE_FILTERS.map((x) => [x.value, 0])) as Record<FileFilter, number>
  for (const f of files) for (const { value } of FILE_FILTERS) if (matchesFilter(f, value)) counts[value] += 1
  return counts
}

export type FileSortKey = 'name' | 'status' | 'length' | 'updated'
export type SortDir = 'asc' | 'desc'
export type FileSort = `${FileSortKey}-${SortDir}`

export const FILE_SORTS: { value: FileSort; label: string }[] = [
  { value: 'name-asc', label: 'Name, A to Z' },
  { value: 'name-desc', label: 'Name, Z to A' },
  { value: 'status-asc', label: 'Status, failed first' },
  { value: 'status-desc', label: 'Status, done first' },
  { value: 'length-asc', label: 'Length, shortest first' },
  { value: 'length-desc', label: 'Length, longest first' },
  { value: 'updated-desc', label: 'Last updated, newest first' },
  { value: 'updated-asc', label: 'Last updated, oldest first' },
]

/** Status order for sorting: what needs a look comes first. */
const STATUS_RANK: Record<SnippetFileStatus, number> = {
  failed: 0,
  running: 1,
  queued: 2,
  not_processed: 3,
  done: 4,
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
const byName = (a: Pick<SnippetFile, 'name' | 'asset_id'>, b: Pick<SnippetFile, 'name' | 'asset_id'>) =>
  collator.compare(a.name, b.name) || (a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0)

/**
 * A sorted copy. Ties fall back to the name (A to Z), and a file whose length
 * or update time is unknown goes last in either direction.
 */
export function sortFiles(files: SnippetFile[], sort: FileSort): SnippetFile[] {
  const [key, dir] = sort.split('-') as [FileSortKey, SortDir]
  const sign = dir === 'desc' ? -1 : 1
  const value = (f: SnippetFile): number | null => {
    if (key === 'status') return STATUS_RANK[f.snippet_status] ?? 99
    if (key === 'length') return f.duration_ms
    if (key === 'updated') {
      const t = f.updated_at ? Date.parse(f.updated_at) : NaN
      return Number.isFinite(t) ? t : null
    }
    return null
  }
  return [...files].sort((a, b) => {
    if (key === 'name') return sign * byName(a, b)
    const va = value(a)
    const vb = value(b)
    if (va == null || vb == null) {
      if (va != null) return -1
      if (vb != null) return 1
      return byName(a, b)
    }
    return sign * (va - vb) || byName(a, b)
  })
}

/** The project root is "/"; files there are not in any folder. */
export const isRootFolder = (path: string) => path.trim() === '' || path.trim() === '/'

/** The folder path as the row shows it ("Project root" for "/"). */
export const folderLabel = (path: string) => (isRootFolder(path) ? 'Project root' : path)

export const UNGROUPED = 'Ungrouped'

export interface FileGroup {
  /** The folder path, or "/" for the files without a folder. */
  key: string
  label: string
  files: SnippetFile[]
}

/** Groups by folder path, folders A to Z and "Ungrouped" (the project root)
 *  last; each group keeps the order of `files`. */
export function groupByFolder(files: SnippetFile[]): FileGroup[] {
  const groups = new Map<string, SnippetFile[]>()
  for (const f of files) {
    const key = isRootFolder(f.folder_path) ? '/' : f.folder_path
    const list = groups.get(key)
    if (list) list.push(f)
    else groups.set(key, [f])
  }
  return Array.from(groups, ([key, list]) => ({ key, label: key === '/' ? UNGROUPED : key, files: list })).sort(
    (a, b) => (a.key === '/' ? 1 : b.key === '/' ? -1 : collator.compare(a.key, b.key)),
  )
}

/** The line above the table: "12 files, 5 done, 2 failed, 3 need a speaker". */
export function summaryText(files: SnippetFile[], total = files.length): string {
  let done = 0
  let failed = 0
  let speaker = 0
  for (const f of files) {
    if (f.snippet_status === 'done') done += 1
    if (f.snippet_status === 'failed') failed += 1
    if (needsSpeaker(f)) speaker += 1
  }
  return `${total} ${total === 1 ? 'file' : 'files'}, ${done} done, ${failed} failed, ${speaker} ${
    speaker === 1 ? 'needs' : 'need'
  } a speaker`
}

/**
 * What "select all" ticks: the rows shown that can be processed, in the order
 * shown, at most `max` (the server's per-request limit). `clipped` is how many
 * more could have been ticked.
 */
export function selectAllTargets(
  rows: SnippetFile[],
  max: number = MAX_PROCESS_BATCH,
): { ids: string[]; eligible: number; clipped: number } {
  const ids = rows.filter(canSelect).map((f) => f.asset_id)
  return { ids: ids.slice(0, max), eligible: ids.length, clipped: Math.max(0, ids.length - max) }
}

// ─── The view in the URL ─────────────────────────────────────────────────────

export interface FilesView {
  q: string
  filter: FileFilter
  sort: FileSort
  grouped: boolean
}

export const DEFAULT_FILES_VIEW: FilesView = { q: '', filter: 'all', sort: 'name-asc', grouped: true }

/** Query keys, prefixed so they never meet the Clips tab's. */
export const FILES_VIEW_KEYS = {
  q: 'files_q',
  filter: 'files_filter',
  sort: 'files_sort',
  group: 'files_group',
} as const

/** Reads the view from the query string; anything unknown is the default. */
export function readFilesView(params: Pick<URLSearchParams, 'get'>): FilesView {
  const filter = params.get(FILES_VIEW_KEYS.filter)
  const sort = params.get(FILES_VIEW_KEYS.sort)
  return {
    q: (params.get(FILES_VIEW_KEYS.q) ?? '').slice(0, 200),
    filter: FILE_FILTERS.some((x) => x.value === filter) ? (filter as FileFilter) : DEFAULT_FILES_VIEW.filter,
    sort: FILE_SORTS.some((x) => x.value === sort) ? (sort as FileSort) : DEFAULT_FILES_VIEW.sort,
    grouped: params.get(FILES_VIEW_KEYS.group) !== 'none',
  }
}

/** A copy of `params` carrying `view`; defaults are left out, other keys are kept. */
export function writeFilesView(params: Pick<URLSearchParams, 'toString'>, view: FilesView): URLSearchParams {
  const next = new URLSearchParams(params.toString())
  const set = (key: string, value: string, fallback: string) => {
    if (value && value !== fallback) next.set(key, value)
    else next.delete(key)
  }
  set(FILES_VIEW_KEYS.q, view.q.trim(), '')
  set(FILES_VIEW_KEYS.filter, view.filter, DEFAULT_FILES_VIEW.filter)
  set(FILES_VIEW_KEYS.sort, view.sort, DEFAULT_FILES_VIEW.sort)
  set(FILES_VIEW_KEYS.group, view.grouped ? '' : 'none', '')
  return next
}
