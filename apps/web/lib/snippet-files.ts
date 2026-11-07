/**
 * The SocialSnippet Files tab's rules, as pure functions: the processing-time
 * estimate, the status chip's words, which rows can be picked, and when the
 * list has to keep polling. No React, so each is tested on its own.
 */
import type { SnippetDetectSummary, SnippetFile, SnippetFileStatus } from '@/types'

/**
 * How many times faster than real time the server's CPU transcribes, on
 * average: a 25-minute file takes about 10 minutes. AN ESTIMATE, not a
 * measurement of this server; every place it is shown says so. The one
 * number to change when the worker's hardware does.
 */
export const SERVER_CPU_SPEED_FACTOR = 2.5

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

/** Roughly how long the server needs for these files: duration / factor. */
export function estimateProcessing(
  durationsMs: (number | null | undefined)[],
  factor: number = SERVER_CPU_SPEED_FACTOR,
): ProcessingEstimate {
  let ms = 0
  let unknown = 0
  for (const d of durationsMs) {
    if (d == null || !Number.isFinite(d) || d <= 0) unknown += 1
    else ms += d
  }
  return { minutes: ms > 0 ? Math.max(1, Math.ceil(ms / factor / 60_000)) : 0, unknown }
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
 * detection failed is "Done" with a warning, because the transcript is good.
 */
export function statusLabel(
  f: Pick<SnippetFile, 'snippet_status' | 'error' | 'not_ready_reason'>,
): { label: string; tone: StatusTone } {
  if (f.not_ready_reason && f.snippet_status === 'not_processed') {
    return { label: 'Not ready', tone: 'neutral' }
  }
  if (f.snippet_status === 'done' && f.error) return { label: 'Done, no new clips', tone: 'warning' }
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

/** Retrying a failure has to force when a transcript is already there, or the
 *  server skips the file as "already transcribed". */
export const retryNeedsForce = (f: Pick<SnippetFile, 'segment_count'>) => f.segment_count > 0

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
