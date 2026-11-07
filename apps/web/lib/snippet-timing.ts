/**
 * In/out point arithmetic for the SocialSnippet player. Pure functions, no
 * React, so the rules the server enforces (PATCH /snippets/{id}: start < end,
 * inside the file, at least 1 s long) are the same rules the handles obey
 * while they are being dragged, and both are tested in one place.
 */

/** The server's minimum clip length. */
export const MIN_CLIP_MS = 1000

/** How far a point may move to reach a word boundary. Beyond this the point
 *  stays where it was put: snapping across a long pause would move an out
 *  point to a sentence the editor did not ask for. */
export const SNAP_MAX_DISTANCE_MS = 1500

export interface InOut {
  start_ms: number
  end_ms: number
}

export interface TimedWord {
  start_ms: number
  end_ms: number
}

/**
 * Move one edge of a clip, keeping the clip valid.
 *
 * `durationMs` null or 0 means "length not known yet" (metadata still loading,
 * or never measured): there is then no upper bound, which is also what the
 * server does when the file's duration was never recorded.
 *
 * The edge being moved gives way, never the other one: dragging the in point
 * into the out point stops it a second short of the out point rather than
 * pushing the out point along.
 */
export function moveEdge(
  clip: InOut,
  edge: 'in' | 'out',
  valueMs: number,
  durationMs: number | null,
  minMs: number = MIN_CLIP_MS,
): InOut {
  const max = durationMs && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  const v = Math.round(Math.min(Math.max(valueMs, 0), max))
  if (edge === 'in') {
    const start = Math.max(0, Math.min(v, clip.end_ms - minMs))
    return { start_ms: start, end_ms: clip.end_ms }
  }
  const end = Math.min(max, Math.max(v, clip.start_ms + minMs))
  return { start_ms: clip.start_ms, end_ms: end }
}

/**
 * Bring a whole clip back inside the rules: used on load (a stored clip that
 * runs past a re-measured file) and before saving.
 */
export function clampClip(clip: InOut, durationMs: number | null, minMs: number = MIN_CLIP_MS): InOut {
  const max = durationMs && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
  let start = Math.max(0, Math.round(clip.start_ms))
  let end = Math.round(clip.end_ms)
  if (end > max) end = max
  if (end - start < minMs) {
    end = Math.min(max, start + minMs)
    if (end - start < minMs) start = Math.max(0, end - minMs)
  }
  return { start_ms: start, end_ms: end }
}

/** Whether the clip passes the server's checks as it stands. */
export function isValidClip(clip: InOut, durationMs: number | null, minMs: number = MIN_CLIP_MS): boolean {
  if (clip.start_ms < 0) return false
  if (clip.end_ms - clip.start_ms < minMs) return false
  if (durationMs && durationMs > 0 && clip.end_ms > durationMs) return false
  return true
}

/**
 * The nearest word boundary to `ms`: word STARTS for an in point (a clip
 * should begin on the first sound of a word) and word ENDS for an out point.
 * Returns `ms` unchanged when there are no words or none within `maxDistance`.
 * `words` need not be sorted.
 */
export function snapToWord(
  ms: number,
  words: readonly TimedWord[],
  edge: 'in' | 'out',
  maxDistance: number = SNAP_MAX_DISTANCE_MS,
): number {
  let best = ms
  let bestDist = Number.POSITIVE_INFINITY
  for (const w of words) {
    const b = edge === 'in' ? w.start_ms : w.end_ms
    const d = Math.abs(b - ms)
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return bestDist <= maxDistance ? best : ms
}

/**
 * Move an edge with optional snapping, then clamp. Snapping first and
 * clamping second means a snap can never produce an invalid clip: if the
 * nearest boundary would break the 1 s rule, the clamp wins.
 */
export function moveEdgeSnapped(
  clip: InOut,
  edge: 'in' | 'out',
  valueMs: number,
  durationMs: number | null,
  words: readonly TimedWord[],
  snap: boolean,
): InOut {
  const target = snap ? snapToWord(valueMs, words, edge) : valueMs
  return moveEdge(clip, edge, target, durationMs)
}

/**
 * Index of the word being spoken at `ms` in a list sorted by start, or -1.
 * Between two words it returns -1, so nothing is highlighted in a pause.
 */
export function wordIndexAt(words: readonly TimedWord[], ms: number): number {
  let lo = 0
  let hi = words.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = words[mid]
    if (ms < w.start_ms) hi = mid - 1
    else if (ms >= w.end_ms) lo = mid + 1
    else return mid
  }
  return -1
}

/** "1:23.4": minutes, seconds and tenths, the precision the nudge buttons use. */
export function formatClipTime(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100))
  const totalSeconds = Math.floor(tenths / 10)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`
}

/** "0:42" for a duration badge; under ten seconds keeps the tenth ("8.5 s"). */
export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Parse what someone typed into a numeric in/out field: "83.5" (seconds),
 * "1:23.5" (m:ss.t) or "1:02:03" (h:mm:ss). Null for anything else.
 */
export function parseClipTime(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const parts = t.split(':')
  if (parts.length > 3) return null
  let seconds = 0
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p)) return null
    seconds = seconds * 60 + Number(p)
  }
  return Math.round(seconds * 1000)
}
