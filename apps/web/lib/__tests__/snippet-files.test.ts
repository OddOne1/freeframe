import { describe, expect, it } from 'vitest'
import {
  MAX_PROCESS_BATCH, SERVER_CPU_SPEED_FACTOR, anyActive, canSelect, detectSummaryText,
  estimateProcessing, formatEstimate, formatLength, retryNeedsForce, statusLabel,
} from '../snippet-files'
import { snippetKeys } from '../snippet-api'

const MIN = 60_000

describe('estimateProcessing', () => {
  it('is duration / 2.5, in whole minutes rounded up', () => {
    expect(SERVER_CPU_SPEED_FACTOR).toBe(2.5)
    expect(estimateProcessing([25 * MIN])).toEqual({ minutes: 10, unknown: 0 })
    expect(estimateProcessing([10 * MIN, 15 * MIN])).toEqual({ minutes: 10, unknown: 0 })
    expect(estimateProcessing([26 * MIN])).toEqual({ minutes: 11, unknown: 0 })
  })
  it('never says 0 min for a short file', () => {
    expect(estimateProcessing([5_000])).toEqual({ minutes: 1, unknown: 0 })
  })
  it('counts files of unknown length apart instead of as zero', () => {
    expect(estimateProcessing([null, 0, undefined, 50 * MIN])).toEqual({ minutes: 20, unknown: 3 })
    expect(estimateProcessing([null])).toEqual({ minutes: 0, unknown: 1 })
  })
  it('takes another factor', () => {
    expect(estimateProcessing([10 * MIN], 1)).toEqual({ minutes: 10, unknown: 0 })
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
    snippet_status, error: null, not_ready_reason: null, ...extra,
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
  it('a retry forces only when a transcript already exists', () => {
    expect(retryNeedsForce({ segment_count: 0 })).toBe(false)
    expect(retryNeedsForce({ segment_count: 4 })).toBe(true)
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
