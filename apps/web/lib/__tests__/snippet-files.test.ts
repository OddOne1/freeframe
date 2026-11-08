import { describe, expect, it } from 'vitest'
import {
  MAX_PROCESS_BATCH, RETRY_FORCES, SERVER_CPU_SPEED_FACTOR, anyActive, canSelect, detectSummaryText,
  estimateProcessing, formatEstimate, formatLength, statusLabel, tracksToTranscribe,
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
