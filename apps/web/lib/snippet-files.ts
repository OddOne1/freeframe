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
  SnippetHiddenMode,
  SnippetHideResponse,
  SnippetSearchResponse,
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

/** POST /snippet/files/hide and /unhide take at most this many per request. */
export const MAX_HIDE_BATCH = 100

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

/**
 * A file needs a speaker name when it has been processed (or is being
 * processed) and a track that may hold speech has none. A file not processed
 * yet never counts: which of its tracks carry speech is not known until a run
 * looks. Nor does a file with no known tracks, or a track found to have no
 * speech.
 */
export function needsSpeaker(f: Pick<SnippetFile, 'tracks' | 'snippet_status'>): boolean {
  return f.snippet_status !== 'not_processed' && f.tracks.some(trackNeedsSpeaker)
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

export type FileSortKey = 'name' | 'kind' | 'folder' | 'status' | 'length' | 'segments' | 'clips' | 'updated'
export type SortDir = 'asc' | 'desc'
export type FileSort = `${FileSortKey}-${SortDir}`

/** The dropdown's options (the only sort control at phone width, where rows
 *  are cards); the column headers set the same values. */
export const FILE_SORTS: { value: FileSort; label: string }[] = [
  { value: 'updated-desc', label: 'Last updated, newest first' },
  { value: 'updated-asc', label: 'Last updated, oldest first' },
  { value: 'name-asc', label: 'Name, A to Z' },
  { value: 'name-desc', label: 'Name, Z to A' },
  { value: 'kind-asc', label: 'Kind, audio first' },
  { value: 'kind-desc', label: 'Kind, video first' },
  { value: 'folder-asc', label: 'Folder, A to Z' },
  { value: 'folder-desc', label: 'Folder, Z to A' },
  { value: 'status-asc', label: 'Status, failed first' },
  { value: 'status-desc', label: 'Status, done first' },
  { value: 'length-asc', label: 'Length, shortest first' },
  { value: 'length-desc', label: 'Length, longest first' },
  { value: 'segments-desc', label: 'Segments, most first' },
  { value: 'segments-asc', label: 'Segments, fewest first' },
  { value: 'clips-desc', label: 'Clips, most first' },
  { value: 'clips-asc', label: 'Clips, fewest first' },
]

/** Which way a column sorts on its first click: words A to Z, numbers and
 *  dates largest or newest first. */
const FIRST_DIR: Record<FileSortKey, SortDir> = {
  name: 'asc',
  kind: 'asc',
  folder: 'asc',
  status: 'asc',
  length: 'desc',
  segments: 'desc',
  clips: 'desc',
  updated: 'desc',
}

/** A column header click: the same column flips its direction, another
 *  column starts in its natural direction. */
export function toggleSort(current: FileSort, key: FileSortKey): FileSort {
  const [curKey, curDir] = current.split('-') as [FileSortKey, SortDir]
  if (curKey === key) return `${key}-${curDir === 'asc' ? 'desc' : 'asc'}`
  return `${key}-${FIRST_DIR[key]}`
}

/** The header's aria-sort for a column under the current sort. */
export function ariaSortOf(current: FileSort, key: FileSortKey): 'ascending' | 'descending' | 'none' {
  const [curKey, curDir] = current.split('-') as [FileSortKey, SortDir]
  if (curKey !== key) return 'none'
  return curDir === 'asc' ? 'ascending' : 'descending'
}

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
  if (key === 'kind' || key === 'folder') {
    const text = (f: SnippetFile) => (key === 'kind' ? f.kind : isRootFolder(f.folder_path) ? '/' : f.folder_path)
    return [...files].sort((a, b) => sign * collator.compare(text(a), text(b)) || byName(a, b))
  }
  const value = (f: SnippetFile): number | null => {
    if (key === 'status') return STATUS_RANK[f.snippet_status] ?? 99
    if (key === 'segments') return f.segment_count
    if (key === 'clips') return f.snippet_count
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

/** The line above the table: "12 files, 5 done, 2 failed, 3 need a speaker",
 *  or "3 hidden files, …" in the Hidden view. Counts only the files given:
 *  the tab hands it the hidden files only when the Hidden chip is on. */
export function summaryText(files: SnippetFile[], total = files.length, hidden = false): string {
  let done = 0
  let failed = 0
  let speaker = 0
  for (const f of files) {
    if (f.snippet_status === 'done') done += 1
    if (f.snippet_status === 'failed') failed += 1
    if (needsSpeaker(f)) speaker += 1
  }
  return `${total}${hidden ? ' hidden' : ''} ${total === 1 ? 'file' : 'files'}, ${done} done, ${failed} failed, ${speaker} ${
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
  pick: (f: SnippetFile) => boolean = canSelect,
): { ids: string[]; eligible: number; clipped: number } {
  const ids = rows.filter(pick).map((f) => f.asset_id)
  return { ids: ids.slice(0, max), eligible: ids.length, clipped: Math.max(0, ids.length - max) }
}

// ─── The view in the URL ─────────────────────────────────────────────────────

export interface FilesView {
  q: string
  filter: FileFilter
  sort: FileSort
  grouped: boolean
  /** The Hidden chip: list the files hidden from SocialSnippet, and only those. */
  hidden: boolean
}

export const DEFAULT_FILES_VIEW: FilesView = {
  q: '',
  filter: 'all',
  sort: 'updated-desc',
  grouped: true,
  hidden: false,
}

/** Query keys, prefixed so they never meet the Clips tab's. */
export const FILES_VIEW_KEYS = {
  q: 'files_q',
  filter: 'files_filter',
  sort: 'files_sort',
  group: 'files_group',
  hidden: 'files_hidden',
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
    hidden: params.get(FILES_VIEW_KEYS.hidden) === '1',
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
  set(FILES_VIEW_KEYS.hidden, view.hidden ? '1' : '', '')
  return next
}

// ─── Hiding files ────────────────────────────────────────────────────────────

/** What the list asks the server for: the hidden files alone with the Hidden
 *  chip on, else everything else (the server's default). */
export const hiddenModeOf = (view: Pick<FilesView, 'hidden'>): SnippetHiddenMode =>
  view.hidden ? 'only' : 'exclude'

/**
 * Which rows can be ticked. In the Hidden view any hidden file can (restoring
 * needs nothing of it); otherwise the rows that can be processed, so the one
 * selection feeds both Process selected and Hide selected. A file that cannot
 * be processed yet is still hidden with its own row's Hide.
 */
export function selectableIn(hiddenView: boolean): (f: SnippetFile) => boolean {
  return hiddenView ? (f) => f.hidden === true : canSelect
}

/** The most rows one selection holds: one request's worth. */
export const selectionLimit = (hiddenView: boolean) => (hiddenView ? MAX_HIDE_BATCH : MAX_PROCESS_BATCH)

/**
 * The confirmation before hiding, for the Files tab and the Clips tab alike:
 * what hiding does, what it keeps, and that it can be undone.
 */
export function hideConfirmCopy(names: string[]): { title: string; points: string[]; action: string } {
  const one = names.length === 1
  const title = one ? `Hide “${names[0]}” from SocialSnippet?` : `Hide ${names.length} files from SocialSnippet?`
  const it = one ? 'its' : 'their'
  return {
    title,
    points: [
      `${one ? 'Its' : 'Their'} clips, suggestions and transcript hits are no longer shown: not in search, not in the clip list, not in the player.`,
      `Nothing is deleted: ${it} transcript, ${it} clips and downloads already made are kept.`,
      `Reversible: turn on the Hidden filter in the Files tab and choose Restore.`,
    ],
    action: one ? 'Hide file' : `Hide ${names.length} files`,
  }
}

/**
 * The toast after a hide or restore: how many changed, and the first one that
 * did not with its reason ("already hidden", "not found", …). `tone` is
 * "error" only when nothing changed for a reason other than "already so".
 */
export function hideResultText(
  res: SnippetHideResponse,
  action: 'hide' | 'restore',
  names: Record<string, string>,
): { message: string; tone: 'success' | 'info' | 'error' } {
  const done = action === 'hide' ? 'hidden' : 'restored'
  const unchanged = res.results.filter((r) => !r.changed)
  const already = action === 'hide' ? 'already hidden' : 'not hidden'
  const problems = unchanged.filter((r) => r.reason !== already)
  const parts: string[] = []
  if (res.changed > 0) parts.push(`${res.changed} ${res.changed === 1 ? 'file' : 'files'} ${done}.`)
  if (problems.length > 0) {
    const first = problems[0]
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''
    parts.push(`Not ${done}: ${names[first.asset_id] ?? 'a file'}: ${first.reason}${more}.`)
  } else if (res.changed === 0) {
    parts.push(action === 'hide' ? 'Already hidden.' : 'Already shown.')
  }
  const tone = problems.length > 0 ? (res.changed > 0 ? 'info' : 'error') : res.changed > 0 ? 'success' : 'info'
  return { message: parts.join(' '), tone }
}

// ─── Table columns (desktop) ─────────────────────────────────────────────────

export type FileColumnKey =
  | 'name'
  | 'kind'
  | 'folder'
  | 'status'
  | 'length'
  | 'segments'
  | 'clips'
  | 'updated'
  | 'speakers'

export interface FileColumn {
  key: FileColumnKey
  label: string
  /** The sort it sets; the speakers column does not sort. */
  sort: FileSortKey | null
  /** Default and smallest width in px. */
  width: number
  min: number
  align?: 'right'
}

/** The resizable columns, in order. A checkbox column before them and an
 *  actions column after them have fixed widths. */
export const FILE_COLUMNS: FileColumn[] = [
  { key: 'name', label: 'Name', sort: 'name', width: 220, min: 120 },
  { key: 'kind', label: 'Kind', sort: 'kind', width: 64, min: 52 },
  { key: 'folder', label: 'Folder', sort: 'folder', width: 128, min: 72 },
  { key: 'status', label: 'Status', sort: 'status', width: 128, min: 96 },
  { key: 'length', label: 'Length', sort: 'length', width: 72, min: 60, align: 'right' },
  { key: 'segments', label: 'Segments', sort: 'segments', width: 76, min: 64, align: 'right' },
  { key: 'clips', label: 'Clips', sort: 'clips', width: 56, min: 48, align: 'right' },
  { key: 'updated', label: 'Last updated', sort: 'updated', width: 104, min: 84 },
  { key: 'speakers', label: 'Speakers per track', sort: null, width: 224, min: 160 },
]

/** No column grows past this by dragging. */
export const MAX_COLUMN_WIDTH = 800

export type ColumnWidths = Record<FileColumnKey, number>

export const DEFAULT_COLUMN_WIDTHS = Object.fromEntries(FILE_COLUMNS.map((c) => [c.key, c.width])) as ColumnWidths

/** A width for `key` kept between its minimum and MAX_COLUMN_WIDTH, in whole px. */
export function clampColumnWidth(key: FileColumnKey, px: number): number {
  const col = FILE_COLUMNS.find((c) => c.key === key)
  if (!col) return 0
  if (!Number.isFinite(px)) return col.width
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(col.min, px)))
}

/** Widths read back from storage: unknown keys dropped, bad values replaced
 *  by the default, every value clamped. Anything unreadable is the defaults. */
export function sanitizeColumnWidths(raw: unknown): ColumnWidths {
  const out = { ...DEFAULT_COLUMN_WIDTHS }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const col of FILE_COLUMNS) {
    const v = (raw as Record<string, unknown>)[col.key]
    if (typeof v === 'number' && Number.isFinite(v)) out[col.key] = clampColumnWidth(col.key, v)
  }
  return out
}

/** The fixed actions column: room for Reprocess or Retry next to the Hide icon. */
export const ACTIONS_COLUMN_WIDTH = 144

/** The grid columns from `lg` up: checkbox, the resizable ones, a filler
 *  that takes any spare width, and the actions. */
export function columnTemplate(widths: ColumnWidths, checkbox = 28, actions = ACTIONS_COLUMN_WIDTH): string {
  return [`${checkbox}px`, ...FILE_COLUMNS.map((c) => `${widths[c.key]}px`), 'minmax(0,1fr)', `${actions}px`].join(' ')
}

/** The table's smallest width: below it, it scrolls inside its container. */
export function tableMinWidth(
  widths: ColumnWidths,
  gap = 8,
  checkbox = 28,
  actions = ACTIONS_COLUMN_WIDTH,
  padding = 24,
): number {
  const cols = FILE_COLUMNS.reduce((sum, c) => sum + widths[c.key], 0)
  return checkbox + cols + actions + gap * (FILE_COLUMNS.length + 2) + padding
}

/**
 * The clip list's loaded pages without one file's clips and moments, for the
 * moment between hiding the file and the server's fresh answer. Every page's
 * `total` drops by how many entries were removed (an entry per topic group,
 * as the server counts them); emptied groups go.
 */
export function withoutAsset(
  pages: SnippetSearchResponse[] | undefined,
  assetId: string,
): SnippetSearchResponse[] | undefined {
  if (!pages) return pages
  let removed = 0
  const kept = pages.map((page) => ({
    ...page,
    groups: page.groups
      .map((g) => {
        const items = g.items.filter((c) => c.asset_id !== assetId)
        removed += g.items.length - items.length
        return { ...g, items }
      })
      .filter((g) => g.items.length > 0 || page.groups.length === 1),
  }))
  return kept.map((page) => ({ ...page, total: Math.max(0, page.total - removed) }))
}
