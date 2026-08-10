import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Resolve a possibly-relative media URL returned by the API (thumbnails,
 * posters, logos, attachments, stream URLs) into a fully-qualified one.
 * The media proxy returns relative paths like "/stream/hls/...?token=..." —
 * this prepends the API origin so <img>/<video> tags outside of API-proxied
 * pages can still load them. Absolute URLs are returned unchanged.
 */
export function resolveApiMediaUrl(url: string | null | undefined): string | null {
  if (!url) return url ?? null
  if (!url.startsWith('/')) return url
  return `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}${url}`
}

/**
 * Format seconds into "M:SS" or "H:MM:SS"
 * e.g. 83 → "1:23", 3725 → "1:02:05"
 */
export function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds)
  const hrs = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  }
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/**
 * Format seconds into SMPTE timecode "HH:MM:SS:FF" at 24fps
 * e.g. 83.5 → "00:01:23:12"
 */
export function formatTimecode(seconds: number, fps = 24): string {
  const totalFrames = Math.floor(seconds * fps)
  const frames = totalFrames % fps
  const totalSeconds = Math.floor(totalFrames / fps)
  const secs = totalSeconds % 60
  const mins = Math.floor(totalSeconds / 60) % 60
  const hrs = Math.floor(totalSeconds / 3600)

  return [
    String(hrs).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
    String(frames).padStart(2, '0'),
  ].join(':')
}

/**
 * Format seconds as frame count at given fps
 * e.g. 83.5 at 24fps → "2004"
 */
export function formatFrames(seconds: number, fps = 24): string {
  return String(Math.floor(seconds * fps))
}

/**
 * Format bytes into human-readable size string
 * e.g. 1_610_612_736 → "1.5 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${parseFloat(value.toFixed(1))} ${units[i]}`
}

/**
 * Format a transfer rate in bytes/sec into a human-readable string.
 * e.g. 8_400_000 → "8.4 MB/s"
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

/**
 * Format a duration in seconds into a short "time left" string.
 * e.g. 95 → "1m 35s", 12 → "12s", 4000 → "1h 6m"
 */
export function formatEta(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hrs = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hrs > 0) return `${hrs}h ${mins}m`
  if (mins > 0) return `${mins}m ${secs}s`
  return `${secs}s`
}

/**
 * Format an ISO date string into a relative time string
 * e.g. "2 hours ago", "3 days ago", "just now"
 */
/**
 * How long a soft-deleted item stays in Recently Deleted before the
 * scheduled purge removes it permanently. Must match
 * `RETENTION_DAYS` in apps/api/services/purge_service.py — the API
 * returns `deleted_at` and nothing else, so the expiry is computed here.
 */
export const TRASH_RETENTION_DAYS = 30

export function trashExpiresAt(deletedAt: string | null | undefined): Date | null {
  if (!deletedAt) return null
  const deleted = new Date(deletedAt)
  if (Number.isNaN(deleted.getTime())) return null
  return new Date(deleted.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
}

/**
 * "expires in 12 days, 4 hours".
 *
 * Days and hours because that's the precision the retention window
 * actually has — a per-second countdown on a 30-day timer would be noise,
 * and would need a ticker 60× busier to serve it.
 *
 * `now` is injectable so this is testable without freezing the clock.
 */
export function formatTimeRemaining(expiresAt: Date, now: Date = new Date()): string {
  const ms = expiresAt.getTime() - now.getTime()
  // The sweep runs daily, so an item can legitimately sit here a few hours
  // past its expiry. Saying "expires in -3 hours" would look broken.
  if (ms <= 0) return 'expiring shortly'

  const totalHours = Math.floor(ms / (60 * 60 * 1000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24

  if (days > 0) {
    return `expires in ${days} day${days !== 1 ? 's' : ''}, ${hours} hour${hours !== 1 ? 's' : ''}`
  }
  if (totalHours > 0) {
    return `expires in ${totalHours} hour${totalHours !== 1 ? 's' : ''}`
  }
  const mins = Math.max(1, Math.floor(ms / (60 * 1000)))
  return `expires in ${mins} minute${mins !== 1 ? 's' : ''}`
}

export function formatRelativeTime(date: string): string {
  const now = Date.now()
  const then = new Date(date).getTime()
  const diffMs = now - then
  const diffSecs = Math.floor(diffMs / 1000)

  if (diffSecs < 60) return 'just now'

  const diffMins = Math.floor(diffSecs / 60)
  if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`

  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`

  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`

  const diffYears = Math.floor(diffMonths / 12)
  return `${diffYears} year${diffYears !== 1 ? 's' : ''} ago`
}

/**
 * Truncate a string to the given length, appending "..." if truncated
 */
export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.slice(0, length) + '...'
}

export function endOfDayISO(dateStr: string): string {
  const d = new Date(dateStr)
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
}

/**
 * Human-readable name for an ISO 639-1 code, as auto-detected by Whisper.
 *
 * Uses Intl.DisplayNames where available (covers every language Whisper can
 * return, localized to the viewer) and falls back to the uppercased code
 * itself — "PT" is still more useful than nothing if Intl is unavailable or
 * the code is unrecognized.
 */
export function languageLabel(code: string | null | undefined): string {
  if (!code) return 'Unknown'
  try {
    const dn = new Intl.DisplayNames(undefined, { type: 'language' })
    return dn.of(code) || code.toUpperCase()
  } catch {
    return code.toUpperCase()
  }
}
