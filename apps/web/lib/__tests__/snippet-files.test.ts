import { describe, expect, it } from 'vitest'
import type { SnippetFile, SnippetSearchResponse, SnippetTrack } from '@/types'
import {
  ACTIONS_COLUMN_WIDTH, DEFAULT_COLUMN_WIDTHS, FILE_COLUMNS, FILE_SORTS, MAX_COLUMN_WIDTH, MAX_HIDE_BATCH, ariaSortOf,
  clampColumnWidth, columnTemplate, hiddenModeOf, hideConfirmCopy, hideResultText, sanitizeColumnWidths, selectableIn,
  selectionLimit, tableMinWidth, toggleSort, withoutAsset,
  DEFAULT_FILES_VIEW, FILES_VIEW_KEYS, FILE_FILTERS, MAX_PROCESS_BATCH, RETRY_FORCES, SERVER_CPU_SPEED_FACTOR,
  anyActive, canSelect, detectSummaryText, estimateProcessing, fetchAllFiles, filterCounts, folderLabel,
  formatEstimate, formatLength, groupByFolder, matchesFilter, matchesSearch, needsSpeaker, readFilesView,
  selectAllTargets, sortFiles, statusLabel, summaryText, trackHasSpeech, trackName, tracksToTranscribe,
  writeFilesView,
} from '../snippet-files'
import { snippetKeys } from '../snippet-api'

const MIN = 60_000

describe('estimateProcessing', () => {
  it('is duration / 1.5 per track, in whole minutes rounded up', () => {
    expect(SERVER_CPU_SPEED_FACTOR).toBe(1.5)
    expect(estimateProcessing([30 * MIN])).toEqual({ minutes: 20, unknown: 0 })
    expect(estimateProcessing([10 * MIN, 20 * MIN])).toEqual({ minutes: 20, unknown: 0 })
    expect(estimateProcessing([31 * MIN])).toEqual({ minutes: 21, unknown: 0 })
  })
  it('matches the measured speed: a 57-minute track reads as about 38 minutes (took 35)', () => {
    expect(estimateProcessing([57 * MIN])).toEqual({ minutes: 38, unknown: 0 })
  })
  it('never says 0 min for a short file', () => {
    expect(estimateProcessing([5_000])).toEqual({ minutes: 1, unknown: 0 })
  })
  it('counts files of unknown length apart instead of as zero', () => {
    expect(estimateProcessing([null, 0, undefined, 30 * MIN])).toEqual({ minutes: 20, unknown: 3 })
    expect(estimateProcessing([null])).toEqual({ minutes: 0, unknown: 1 })
    expect(estimateProcessing([{ durationMs: null, tracks: 4 }])).toEqual({ minutes: 0, unknown: 1 })
  })
  it('multiplies by the tracks still to transcribe when they are known', () => {
    expect(estimateProcessing([{ durationMs: 30 * MIN, tracks: 4 }])).toEqual({ minutes: 80, unknown: 0 })
    expect(estimateProcessing([{ durationMs: 30 * MIN, tracks: 2 }, { durationMs: 15 * MIN, tracks: 1 }]))
      .toEqual({ minutes: 50, unknown: 0 })
  })
  it('counts a file once when its tracks are not known', () => {
    expect(estimateProcessing([{ durationMs: 30 * MIN, tracks: null }])).toEqual({ minutes: 20, unknown: 0 })
    expect(estimateProcessing([{ durationMs: 30 * MIN }])).toEqual({ minutes: 20, unknown: 0 })
  })
  it('a file with every track done still reads as a minute, not unknown', () => {
    expect(estimateProcessing([{ durationMs: 57 * MIN, tracks: 0 }])).toEqual({ minutes: 1, unknown: 0 })
  })
  it('takes another factor', () => {
    expect(estimateProcessing([10 * MIN], 1)).toEqual({ minutes: 10, unknown: 0 })
  })
})

describe('tracksToTranscribe', () => {
  const f = (planned_track_count: number | null, done_track_count = 0) => ({ planned_track_count, done_track_count })
  it('leaves out finished tracks on a resume', () => {
    expect(tracksToTranscribe(f(4, 2), false)).toBe(2)
    expect(tracksToTranscribe(f(4, 4), false)).toBe(0)
    expect(tracksToTranscribe(f(2, 0), false)).toBe(2)
  })
  it('counts every planned track when forced', () => {
    expect(tracksToTranscribe(f(4, 2), true)).toBe(4)
  })
  it('is unknown when the list does not know the tracks', () => {
    expect(tracksToTranscribe(f(null), false)).toBeNull()
    expect(tracksToTranscribe(f(null), true)).toBeNull()
  })
})

describe('formatEstimate', () => {
  it('reads as an approximate time on the server CPU', () => {
    expect(formatEstimate({ minutes: 12, unknown: 0 })).toBe('about 12 min on the server CPU')
    expect(formatEstimate({ minutes: 65, unknown: 0 })).toBe('about 1 h 05 min on the server CPU')
    expect(formatEstimate({ minutes: 3, unknown: 1 })).toBe(
      'about 3 min on the server CPU, plus 1 file of unknown length',
    )
    expect(formatEstimate({ minutes: 0, unknown: 2 })).toMatch(/unknown time/)
  })
})

describe('statusLabel', () => {
  const f = (snippet_status: Parameters<typeof statusLabel>[0]['snippet_status'], extra = {}) => ({
    snippet_status, error: null, not_ready_reason: null, segment_count: 3, ...extra,
  })
  it('names each status', () => {
    expect(statusLabel(f('not_processed'))).toEqual({ label: 'Not processed', tone: 'neutral' })
    expect(statusLabel(f('queued'))).toEqual({ label: 'Queued', tone: 'info' })
    expect(statusLabel(f('running'))).toEqual({ label: 'Processing', tone: 'info' })
    expect(statusLabel(f('done'))).toEqual({ label: 'Done', tone: 'success' })
    expect(statusLabel(f('failed', { error: 'boom' }))).toEqual({ label: 'Failed', tone: 'error' })
  })
  it('says a file is not ready when its own processing is what stops it', () => {
    expect(statusLabel(f('not_processed', { not_ready_reason: 'the file is still uploading' })))
      .toEqual({ label: 'Not ready', tone: 'neutral' })
    // A transcript already made stays visible after a new version is uploaded.
    expect(statusLabel(f('done', { not_ready_reason: 'the file is still uploading' })).label).toBe('Done')
  })
  it('says a file done without any segment had no speech', () => {
    expect(statusLabel(f('done', { segment_count: 0 })))
      .toEqual({ label: 'Done, no speech found', tone: 'neutral' })
    expect(statusLabel(f('failed', { segment_count: 0, error: 'x' })).label).toBe('Failed')
  })
  it('keeps a good transcript "done" when only clip detection failed', () => {
    expect(statusLabel(f('done', { error: 'Clip detection failed: x' })))
      .toEqual({ label: 'Done, no new clips', tone: 'warning' })
  })
})

describe('selection and polling', () => {
  const row = (asset_status: string, snippet_status: Parameters<typeof canSelect>[0]['snippet_status'],
    media_file_id: string | null = 'mf') => ({ asset_status, snippet_status, media_file_id })
  it('only ready, idle files can be picked', () => {
    expect(canSelect(row('ready', 'not_processed'))).toBe(true)
    expect(canSelect(row('ready', 'done'))).toBe(true)
    expect(canSelect(row('ready', 'failed'))).toBe(true)
    expect(canSelect(row('uploading', 'not_processed'))).toBe(false)
    expect(canSelect(row('failed', 'not_processed'))).toBe(false)
    expect(canSelect(row('ready', 'queued'))).toBe(false)
    expect(canSelect(row('ready', 'running'))).toBe(false)
    expect(canSelect(row('ready', 'not_processed', null))).toBe(false)
  })
  it('polls while anything is queued or running, and stops when nothing is', () => {
    expect(anyActive([{ snippet_status: 'done' }, { snippet_status: 'queued' }])).toBe(true)
    expect(anyActive([{ snippet_status: 'running' }])).toBe(true)
    expect(anyActive([{ snippet_status: 'done' }, { snippet_status: 'failed' }])).toBe(false)
    expect(anyActive(undefined)).toBe(false)
  })
  it('the batch limit is the server limit', () => {
    expect(MAX_PROCESS_BATCH).toBe(20)
  })
  it('a retry never forces: the server resumes, keeping finished stages', () => {
    expect(RETRY_FORCES).toBe(false)
  })
})

describe('formatLength', () => {
  it('shows hours only from an hour up', () => {
    expect(formatLength(245_000)).toBe('4:05')
    expect(formatLength(4_320_000)).toBe('1:12:00')
    expect(formatLength(3_599_400)).toBe('59:59')
  })
})

describe('detectSummaryText', () => {
  it('says what re-detection did, or why it did not run', () => {
    expect(detectSummaryText({ ran: true, created: 3, removed: 2, reason: null })).toBe(
      'Speaker saved. Clip suggestions re-detected: 3 new, 2 replaced.',
    )
    expect(detectSummaryText({ ran: true, created: 0, removed: 0, reason: null })).toBe(
      'Speaker saved. No clip suggestions changed.',
    )
    expect(detectSummaryText({ ran: false, created: 0, removed: 0, reason: 'No transcript yet.' })).toBe(
      'Speaker saved. No transcript yet.',
    )
    expect(detectSummaryText(undefined)).toBe('Speaker saved.')
  })
})

describe('snippetKeys.files', () => {
  it('leaves defaults out of the key', () => {
    expect(snippetKeys.files('p')).toBe('/projects/p/snippet/files')
    expect(snippetKeys.files('p', { q: '  ', page: 1, page_size: 50 })).toBe('/projects/p/snippet/files')
    expect(snippetKeys.files('p', { q: 'a b', page: 2, page_size: 20 })).toBe(
      '/projects/p/snippet/files?q=a+b&page=2&page_size=20',
    )
  })
})

// ─── Files tab navigation: search, chips, sort, groups, URL ─────────────────

const tr = (track_index: number, label: string, speaker_id: string | null = null): SnippetTrack => ({
  track_index, label, speaker_id, speaker_name: speaker_id ? `Name ${speaker_id}` : null,
})

let seq = 0
const mk = (o: Partial<SnippetFile> = {}): SnippetFile => {
  seq += 1
  return {
    asset_id: `a${String(seq).padStart(3, '0')}`, media_file_id: `m${seq}`, name: `File ${seq}.mov`, kind: 'video',
    folder_path: '/', duration_ms: 60_000, asset_status: 'ready', not_ready_reason: null,
    snippet_status: 'not_processed', segment_count: 0, snippet_count: 0, error: null,
    updated_at: '2026-11-01T10:00:00Z', tracks: [], planned_track_count: null, done_track_count: 0, hidden: false, ...o,
  }
}
const names = (fs: SnippetFile[]) => fs.map((f) => f.name)

describe('needs-speaker rule', () => {
  it('a track marked "no speech" never needs a speaker', () => {
    expect(trackHasSpeech(tr(0, 'Track 1 · mono · no speech'))).toBe(false)
    expect(trackHasSpeech(tr(0, 'Track 1 · mono · No Speech '))).toBe(false)
    expect(trackHasSpeech(tr(0, 'Lav Anna · 1 ch · de'))).toBe(true)
    // "no speech" in the middle of a label is not the server's marker.
    expect(trackHasSpeech(tr(0, 'no speech zone · mono'))).toBe(true)
  })
  it('a processed file needs one when any track that may have speech has no speaker', () => {
    for (const snippet_status of ['done', 'failed', 'queued', 'running'] as const) {
      expect(needsSpeaker(mk({ snippet_status, tracks: [tr(0, 'Track 1', 's1'), tr(1, 'Track 2')] }))).toBe(true)
    }
    expect(needsSpeaker(mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1', 's1'), tr(1, 'Track 2', 's2')] })))
      .toBe(false)
  })
  it('tracks marked "no speech" never count', () => {
    expect(needsSpeaker(mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1', 's1'), tr(1, 'Track 2 · no speech')] })))
      .toBe(false)
    expect(needsSpeaker(mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1 · no speech'), tr(1, 'Track 2 · no speech')] })))
      .toBe(false)
  })
  it('a file not processed yet, or with no known tracks, never counts', () => {
    expect(needsSpeaker(mk({ snippet_status: 'not_processed', tracks: [tr(0, 'Track 1'), tr(1, 'Track 2')] }))).toBe(false)
    expect(needsSpeaker(mk({ snippet_status: 'not_processed', tracks: [] }))).toBe(false)
    expect(needsSpeaker(mk({ snippet_status: 'done', tracks: [] }))).toBe(false)
    // Not ready (still uploading) is not processed either.
    expect(needsSpeaker(mk({ asset_status: 'uploading', not_ready_reason: 'uploading', tracks: [tr(0, 'Track 1')] })))
      .toBe(false)
  })
  it('names tracks by their position', () => {
    expect(trackName({ track_index: 0 })).toBe('Track 1')
    expect(trackName({ track_index: 3 })).toBe('Track 4')
  })
})

describe('filter chips', () => {
  const files = [
    mk({ snippet_status: 'failed', error: 'x' }),
    mk({ snippet_status: 'queued' }),
    mk({ snippet_status: 'running', tracks: [tr(0, 'Track 1')] }),
    mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1', 's1')] }),
    mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1 · no speech')] }),
    mk({ snippet_status: 'not_processed', tracks: [tr(0, 'Track 1'), tr(1, 'Track 2 · no speech')] }),
  ]
  it('each chip picks its own files', () => {
    expect(files.filter((f) => matchesFilter(f, 'attention')).map((f) => f.snippet_status)).toEqual(['failed'])
    expect(files.filter((f) => matchesFilter(f, 'processing')).map((f) => f.snippet_status)).toEqual(['queued', 'running'])
    expect(files.filter((f) => matchesFilter(f, 'done'))).toHaveLength(2)
    expect(files.filter((f) => matchesFilter(f, 'not_processed'))).toHaveLength(1)
    // The not-processed file has an unnamed track but does not count yet.
    expect(files.filter((f) => matchesFilter(f, 'needs_speaker')).map((f) => f.snippet_status))
      .toEqual(['running'])
    expect(files.filter((f) => matchesFilter(f, 'all'))).toHaveLength(6)
  })
  it('counts every chip at once', () => {
    expect(filterCounts(files)).toEqual({
      all: 6, attention: 1, processing: 2, done: 2, not_processed: 1, needs_speaker: 1,
    })
    expect(Object.keys(filterCounts([]))).toEqual(FILE_FILTERS.map((x) => x.value))
  })
})

describe('search', () => {
  const f = mk({ name: 'Interview Anna.mov', folder_path: '/Shoots/Day 2' })
  it('matches part of the name or the folder path, ignoring case', () => {
    expect(matchesSearch(f, 'anna')).toBe(true)
    expect(matchesSearch(f, 'day 2')).toBe(true)
    expect(matchesSearch(f, '/shoots')).toBe(true)
    expect(matchesSearch(f, 'marco')).toBe(false)
    expect(matchesSearch(f, '   ')).toBe(true)
  })
  it('a file in the project root is shown, and found, as "Project root"', () => {
    expect(folderLabel('/')).toBe('Project root')
    expect(matchesSearch(mk({ name: 'memo.m4a', folder_path: '/' }), 'root')).toBe(true)
  })
})

describe('sortFiles', () => {
  const a = mk({ name: 'b take 10.mov', snippet_status: 'done', duration_ms: 300_000, updated_at: '2026-11-03T00:00:00Z' })
  const b = mk({ name: 'B take 2.mov', snippet_status: 'failed', duration_ms: null, updated_at: '2026-11-01T00:00:00Z' })
  const c = mk({ name: 'a.mov', snippet_status: 'running', duration_ms: 60_000, updated_at: null })
  const d = mk({ name: 'c.mov', snippet_status: 'not_processed', duration_ms: 600_000, updated_at: '2026-11-02T00:00:00Z' })
  const all = [a, b, c, d]
  it('sorts names naturally, ignoring case', () => {
    expect(names(sortFiles(all, 'name-asc'))).toEqual(['a.mov', 'B take 2.mov', 'b take 10.mov', 'c.mov'])
    expect(names(sortFiles(all, 'name-desc'))).toEqual(['c.mov', 'b take 10.mov', 'B take 2.mov', 'a.mov'])
  })
  it('sorts status with failed first, or done first', () => {
    expect(sortFiles(all, 'status-asc').map((f) => f.snippet_status)).toEqual(['failed', 'running', 'not_processed', 'done'])
    expect(sortFiles(all, 'status-desc').map((f) => f.snippet_status)).toEqual(['done', 'not_processed', 'running', 'failed'])
  })
  it('puts an unknown length or update time last in both directions', () => {
    expect(names(sortFiles(all, 'length-asc'))).toEqual(['a.mov', 'b take 10.mov', 'c.mov', 'B take 2.mov'])
    expect(names(sortFiles(all, 'length-desc'))).toEqual(['c.mov', 'b take 10.mov', 'a.mov', 'B take 2.mov'])
    expect(names(sortFiles(all, 'updated-desc'))).toEqual(['b take 10.mov', 'c.mov', 'B take 2.mov', 'a.mov'])
    expect(names(sortFiles(all, 'updated-asc'))).toEqual(['B take 2.mov', 'c.mov', 'b take 10.mov', 'a.mov'])
  })
  it('breaks ties by name and leaves the input alone', () => {
    const x = mk({ name: 'z.mov', snippet_status: 'done' })
    const y = mk({ name: 'y.mov', snippet_status: 'done' })
    const input = [x, y]
    expect(names(sortFiles(input, 'status-asc'))).toEqual(['y.mov', 'z.mov'])
    expect(names(sortFiles(input, 'status-desc'))).toEqual(['y.mov', 'z.mov'])
    expect(names(input)).toEqual(['z.mov', 'y.mov'])
  })
})

describe('groupByFolder', () => {
  it('one group per folder, A to Z with numbers in order, "Ungrouped" last, order inside kept', () => {
    const files = [
      mk({ name: '1', folder_path: '/Shoot/Day 10' }),
      mk({ name: '2', folder_path: '/' }),
      mk({ name: '3', folder_path: '/Shoot/Day 2' }),
      mk({ name: '4', folder_path: '/Audio' }),
      mk({ name: '5', folder_path: '/Shoot/Day 2' }),
    ]
    const groups = groupByFolder(files)
    expect(groups.map((g) => g.label)).toEqual(['/Audio', '/Shoot/Day 2', '/Shoot/Day 10', 'Ungrouped'])
    expect(groups.map((g) => names(g.files))).toEqual([['4'], ['3', '5'], ['1'], ['2']])
  })
  it('is empty for no files', () => {
    expect(groupByFolder([])).toEqual([])
  })
})

describe('summaryText', () => {
  it('counts done, failed and files that need a speaker', () => {
    const files = [
      mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1')] }),
      mk({ snippet_status: 'done', tracks: [tr(0, 'Track 1', 's')] }),
      mk({ snippet_status: 'failed', tracks: [tr(0, 'Track 1 · no speech')] }),
    ]
    expect(summaryText(files)).toBe('3 files, 2 done, 1 failed, 1 needs a speaker')
    const withNew = [...files, mk({ snippet_status: 'not_processed', tracks: [tr(0, 'Track 1')] })]
    expect(summaryText(withNew)).toBe('4 files, 2 done, 1 failed, 1 needs a speaker')
    expect(summaryText([])).toBe('0 files, 0 done, 0 failed, 0 need a speaker')
    expect(summaryText(files.slice(0, 1), 1)).toBe('1 file, 1 done, 0 failed, 1 needs a speaker')
  })
})

describe('selectAllTargets', () => {
  it('ticks only rows that can be processed, in the order shown', () => {
    const rows = [
      mk({ name: 'ok1' }), mk({ name: 'busy', snippet_status: 'running' }),
      mk({ name: 'up', asset_status: 'uploading', not_ready_reason: 'uploading' }), mk({ name: 'ok2', snippet_status: 'done' }),
    ]
    const r = selectAllTargets(rows)
    expect(r.ids).toEqual([rows[0].asset_id, rows[3].asset_id])
    expect(r).toMatchObject({ eligible: 2, clipped: 0 })
  })
  it('stops at the per-request maximum and says how many it left out', () => {
    const rows = Array.from({ length: 27 }, () => mk())
    const r = selectAllTargets(rows)
    expect(r.ids).toHaveLength(MAX_PROCESS_BATCH)
    expect(r.ids).toEqual(rows.slice(0, 20).map((f) => f.asset_id))
    expect(r).toMatchObject({ eligible: 27, clipped: 7 })
  })
})

describe('fetchAllFiles', () => {
  const page = (total: number, from: number, n: number) => ({
    total, items: Array.from({ length: n }, (_, i) => mk({ asset_id: `id${from + i}` })),
  })
  it('follows the pages at 100 a page', async () => {
    const calls: [number, number][] = []
    const res = await fetchAllFiles(async (p, size) => {
      calls.push([p, size])
      return page(230, (p - 1) * size, Math.min(size, 230 - (p - 1) * size))
    })
    expect(calls).toEqual([[1, 100], [2, 100], [3, 100]])
    expect(res.total).toBe(230)
    expect(res.items).toHaveLength(230)
  })
  it('stops at 500 files and keeps the real total', async () => {
    const calls: number[] = []
    const res = await fetchAllFiles(async (p, size) => {
      calls.push(p)
      return page(1234, (p - 1) * size, size)
    })
    expect(calls).toEqual([1, 2, 3, 4, 5])
    expect(res).toMatchObject({ total: 1234 })
    expect(res.items).toHaveLength(500)
  })
  it('asks once for a short list, and keeps a file that moved between pages once', async () => {
    const one = await fetchAllFiles(async () => page(3, 0, 3))
    expect(one.items).toHaveLength(3)
    const moved = await fetchAllFiles(async (p) => (p === 1 ? page(4, 0, 2) : page(4, 1, 2)), { pageSize: 2 })
    expect(moved.items.map((f) => f.asset_id)).toEqual(['id0', 'id1', 'id2'])
  })
})

describe('files view in the URL', () => {
  it('leaves defaults out and keeps other keys', () => {
    const base = new URLSearchParams('tab=files&other=1')
    expect(writeFilesView(base, DEFAULT_FILES_VIEW).toString()).toBe('tab=files&other=1')
    const qs = writeFilesView(base, {
      q: ' day 2 ', filter: 'needs_speaker', sort: 'name-asc', grouped: false, hidden: false,
    })
    expect(qs.get(FILES_VIEW_KEYS.q)).toBe('day 2')
    expect(qs.get(FILES_VIEW_KEYS.filter)).toBe('needs_speaker')
    expect(qs.get(FILES_VIEW_KEYS.sort)).toBe('name-asc')
    // The default (last updated, newest first) is left out.
    expect(DEFAULT_FILES_VIEW.sort).toBe('updated-desc')
    expect(writeFilesView(base, { ...DEFAULT_FILES_VIEW, sort: 'updated-desc' }).has(FILES_VIEW_KEYS.sort)).toBe(false)
    expect(qs.get(FILES_VIEW_KEYS.group)).toBe('none')
    expect(qs.has(FILES_VIEW_KEYS.hidden)).toBe(false)
    expect(writeFilesView(base, { ...DEFAULT_FILES_VIEW, hidden: true }).get(FILES_VIEW_KEYS.hidden)).toBe('1')
    expect(qs.get('tab')).toBe('files')
    expect(qs.get('other')).toBe('1')
  })
  it('reads back what it wrote', () => {
    const view = { q: 'anna', filter: 'attention' as const, sort: 'length-desc' as const, grouped: false, hidden: true }
    expect(readFilesView(writeFilesView(new URLSearchParams(), view))).toEqual(view)
    expect(readFilesView(writeFilesView(new URLSearchParams(), { ...view, hidden: false }))).toEqual({
      ...view, hidden: false,
    })
    expect(readFilesView(new URLSearchParams())).toEqual(DEFAULT_FILES_VIEW)
  })
  it('falls back to the default for values it does not know', () => {
    expect(readFilesView(new URLSearchParams('files_filter=nope&files_sort=size-up&files_group=x&files_hidden=yes')))
      .toEqual(DEFAULT_FILES_VIEW)
  })
})

describe('sortFiles: kind, folder, segments, clips', () => {
  const v = mk({ name: 'v.mov', kind: 'video', folder_path: '/B', segment_count: 5, snippet_count: 1 })
  const a = mk({ name: 'a.wav', kind: 'audio', folder_path: '/A', segment_count: 9, snippet_count: 0 })
  const r = mk({ name: 'r.mov', kind: 'video', folder_path: '/', segment_count: 0, snippet_count: 3 })
  const all = [v, a, r]
  it('sorts by kind and folder (the root first), then by name', () => {
    expect(names(sortFiles(all, 'kind-asc'))).toEqual(['a.wav', 'r.mov', 'v.mov'])
    expect(names(sortFiles(all, 'kind-desc'))).toEqual(['r.mov', 'v.mov', 'a.wav'])
    expect(names(sortFiles(all, 'folder-asc'))).toEqual(['r.mov', 'a.wav', 'v.mov'])
    expect(names(sortFiles(all, 'folder-desc'))).toEqual(['v.mov', 'a.wav', 'r.mov'])
  })
  it('sorts by segment and clip counts', () => {
    expect(names(sortFiles(all, 'segments-desc'))).toEqual(['a.wav', 'v.mov', 'r.mov'])
    expect(names(sortFiles(all, 'clips-asc'))).toEqual(['a.wav', 'v.mov', 'r.mov'])
  })
  it('every column that sorts has both directions in the dropdown', () => {
    for (const c of FILE_COLUMNS.filter((x) => x.sort)) {
      expect(FILE_SORTS.map((o) => o.value)).toEqual(expect.arrayContaining([`${c.sort}-asc`, `${c.sort}-desc`]))
    }
  })
})

describe('toggleSort and ariaSortOf', () => {
  it('the same column flips its direction', () => {
    expect(toggleSort('name-asc', 'name')).toBe('name-desc')
    expect(toggleSort('name-desc', 'name')).toBe('name-asc')
    expect(toggleSort('updated-desc', 'updated')).toBe('updated-asc')
  })
  it('another column starts in its natural direction', () => {
    expect(toggleSort('updated-desc', 'name')).toBe('name-asc')
    expect(toggleSort('name-asc', 'length')).toBe('length-desc')
    expect(toggleSort('name-asc', 'segments')).toBe('segments-desc')
    expect(toggleSort('length-desc', 'folder')).toBe('folder-asc')
    expect(toggleSort('length-desc', 'status')).toBe('status-asc')
  })
  it('says which column sorts and which way', () => {
    expect(ariaSortOf('name-asc', 'name')).toBe('ascending')
    expect(ariaSortOf('updated-desc', 'updated')).toBe('descending')
    expect(ariaSortOf('updated-desc', 'name')).toBe('none')
  })
})

describe('column widths', () => {
  it('clamps a width to the column minimum and the maximum', () => {
    const name = FILE_COLUMNS.find((c) => c.key === 'name')!
    expect(clampColumnWidth('name', 10)).toBe(name.min)
    expect(clampColumnWidth('name', 5000)).toBe(MAX_COLUMN_WIDTH)
    expect(clampColumnWidth('name', 301.6)).toBe(302)
    expect(clampColumnWidth('name', Number.NaN)).toBe(name.width)
    expect(clampColumnWidth('clips', 0)).toBe(FILE_COLUMNS.find((c) => c.key === 'clips')!.min)
  })
  it('every default is within its own limits', () => {
    for (const c of FILE_COLUMNS) {
      expect(c.width).toBeGreaterThanOrEqual(c.min)
      expect(clampColumnWidth(c.key, c.width)).toBe(c.width)
    }
  })
  it('reads stored widths defensively', () => {
    expect(sanitizeColumnWidths(null)).toEqual(DEFAULT_COLUMN_WIDTHS)
    expect(sanitizeColumnWidths('garbage')).toEqual(DEFAULT_COLUMN_WIDTHS)
    expect(sanitizeColumnWidths([1, 2])).toEqual(DEFAULT_COLUMN_WIDTHS)
    const w = sanitizeColumnWidths({ name: 400, folder: 1, clips: 'wide', bogus: 99, status: 99999 })
    expect(w.name).toBe(400)
    expect(w.folder).toBe(FILE_COLUMNS.find((c) => c.key === 'folder')!.min)
    expect(w.clips).toBe(DEFAULT_COLUMN_WIDTHS.clips)
    expect(w.status).toBe(MAX_COLUMN_WIDTH)
    expect('bogus' in w).toBe(false)
  })
  it('builds the grid template and the smallest table width', () => {
    const t = columnTemplate(DEFAULT_COLUMN_WIDTHS)
    expect(t.split(' ')).toHaveLength(FILE_COLUMNS.length + 3)
    expect(t.startsWith('28px 220px ')).toBe(true)
    expect(t.endsWith(`minmax(0,1fr) ${ACTIONS_COLUMN_WIDTH}px`)).toBe(true)
    const sum = FILE_COLUMNS.reduce((n, c) => n + c.width, 0)
    expect(tableMinWidth(DEFAULT_COLUMN_WIDTHS)).toBe(
      28 + sum + ACTIONS_COLUMN_WIDTH + 8 * (FILE_COLUMNS.length + 2) + 24,
    )
  })
})

describe('hiding files', () => {
  it('asks the server for the hidden files only with the Hidden chip on', () => {
    expect(hiddenModeOf({ hidden: true })).toBe('only')
    expect(hiddenModeOf({ hidden: false })).toBe('exclude')
    expect(hiddenModeOf(DEFAULT_FILES_VIEW)).toBe('exclude')
  })
  it('puts the mode in the files key only when it is not the default', () => {
    expect(snippetKeys.files('p1', { hidden: 'exclude' })).toBe('/projects/p1/snippet/files')
    expect(snippetKeys.files('p1', { hidden: 'only', page_size: 1 })).toBe(
      '/projects/p1/snippet/files?page_size=1&hidden=only',
    )
  })
  it('selects processable rows normally and any hidden row in the Hidden view', () => {
    const notReady = mk({ hidden: true, asset_status: 'uploading', not_ready_reason: 'uploading' })
    const running = mk({ hidden: true, snippet_status: 'running' })
    const shown = mk()
    expect(selectableIn(true)(notReady)).toBe(true)
    expect(selectableIn(true)(running)).toBe(true)
    expect(selectableIn(true)(shown)).toBe(false)
    expect(selectableIn(false)(shown)).toBe(canSelect(shown))
    expect(selectableIn(false)(mk({ asset_status: 'uploading' }))).toBe(false)
    expect(selectionLimit(true)).toBe(MAX_HIDE_BATCH)
    expect(selectionLimit(false)).toBe(MAX_PROCESS_BATCH)
    const rows = Array.from({ length: 120 }, () => mk({ hidden: true }))
    expect(selectAllTargets(rows, selectionLimit(true), selectableIn(true))).toMatchObject({
      eligible: 120, clipped: 20,
    })
  })
  it('says in the summary when it counts hidden files', () => {
    const hidden = [mk({ hidden: true, snippet_status: 'done' }), mk({ hidden: true })]
    expect(summaryText(hidden, 2, true)).toBe('2 hidden files, 1 done, 0 failed, 0 need a speaker')
    expect(summaryText(hidden.slice(0, 1), 1, true)).toBe('1 hidden file, 1 done, 0 failed, 0 need a speaker')
  })
  it('the confirmation says what hiding does, what it keeps, and that it can be undone', () => {
    const one = hideConfirmCopy(['Interview.mov'])
    expect(one.title).toBe('Hide “Interview.mov” from SocialSnippet?')
    expect(one.action).toBe('Hide file')
    const text = one.points.join(' ')
    expect(text).toMatch(/not in search, not in the clip list, not in the player/)
    expect(text).toMatch(/Nothing is deleted: its transcript, its clips and downloads already made are kept/)
    expect(text).toMatch(/Reversible/)
    const many = hideConfirmCopy(['a.mov', 'b.mov', 'c.wav'])
    expect(many.title).toBe('Hide 3 files from SocialSnippet?')
    expect(many.action).toBe('Hide 3 files')
    expect(many.points.join(' ')).toMatch(/Their clips/)
  })
  it('reports what changed and the first thing that did not', () => {
    const names = { a1: 'Alpha.mov', a2: 'Beta.wav' }
    const r = (changed: [string, boolean, string][]) => ({
      changed: changed.filter((c) => c[1]).length,
      results: changed.map(([asset_id, ch, reason]) => ({ asset_id, changed: ch, reason })),
    })
    expect(hideResultText(r([['a1', true, 'hidden'], ['a2', true, 'hidden']]), 'hide', names)).toEqual({
      message: '2 files hidden.', tone: 'success',
    })
    expect(hideResultText(r([['a1', false, 'already hidden']]), 'hide', names)).toEqual({
      message: 'Already hidden.', tone: 'info',
    })
    expect(hideResultText(r([['a1', true, 'hidden'], ['a2', false, 'not found'], ['x', false, 'not found']]), 'hide', names))
      .toEqual({ message: '1 file hidden. Not hidden: Beta.wav: not found (and 1 more).', tone: 'info' })
    expect(hideResultText(r([['a2', false, 'not found']]), 'restore', names)).toEqual({
      message: 'Not restored: Beta.wav: not found.', tone: 'error',
    })
    expect(hideResultText(r([['a1', true, 'restored']]), 'restore', names)).toEqual({
      message: '1 file restored.', tone: 'success',
    })
    expect(hideResultText(r([['a1', false, 'not hidden']]), 'restore', names).message).toBe('Already shown.')
  })
})

describe('withoutAsset', () => {
  const clip = (id: string, asset_id: string) => ({ id, asset_id }) as unknown as SnippetSearchResponse['groups'][0]['items'][0]
  it('drops one file\'s clips from every loaded page and lowers the total', () => {
    const pages: SnippetSearchResponse[] = [
      { total: 5, page: 1, page_size: 3, groups: [
        { key: 'climate', label: 'Climate', items: [clip('1', 'A'), clip('2', 'B')] },
        { key: 'ice', label: 'Ice', items: [clip('1', 'A')] },
      ] },
      { total: 5, page: 2, page_size: 3, groups: [{ key: 'none', label: 'No topic', items: [clip('3', 'A'), clip('4', 'C')] }] },
    ]
    const out = withoutAsset(pages, 'A')!
    expect(out.map((p) => p.total)).toEqual([2, 2])
    expect(out[0].groups.map((g) => g.key)).toEqual(['climate'])
    expect(out[0].groups[0].items.map((c) => c.id)).toEqual(['2'])
    expect(out[1].groups[0].items.map((c) => c.id)).toEqual(['4'])
    expect(pages[0].groups[0].items).toHaveLength(2) // not changed in place
  })
  it('keeps the single "All" group of an ungrouped list even when it empties', () => {
    const pages: SnippetSearchResponse[] = [
      { total: 1, page: 1, page_size: 24, groups: [{ key: 'all', label: 'All', items: [clip('1', 'A')] }] },
    ]
    expect(withoutAsset(pages, 'A')).toEqual([{ total: 0, page: 1, page_size: 24, groups: [{ key: 'all', label: 'All', items: [] }] }])
    expect(withoutAsset(undefined, 'A')).toBeUndefined()
  })
})
