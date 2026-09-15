import { describe, it, expect } from 'vitest'
import {
  formatTime,
  formatTimecode,
  formatBytes,
  formatRelativeTime,
  truncate,
  cn,
} from '../utils'

describe('formatTime', () => {
  it('formats 0 seconds', () => {
    expect(formatTime(0)).toBe('0:00')
  })

  it('formats 83 seconds as 1:23', () => {
    expect(formatTime(83)).toBe('1:23')
  })

  it('formats 3723 seconds as 1:02:03', () => {
    expect(formatTime(3723)).toBe('1:02:03')
  })

  it('formats 59 seconds', () => {
    expect(formatTime(59)).toBe('0:59')
  })

  it('formats 3600 seconds as 1:00:00', () => {
    expect(formatTime(3600)).toBe('1:00:00')
  })
})

describe('formatTimecode', () => {
  it('formats 0 seconds as 00:00:00:00', () => {
    expect(formatTimecode(0)).toBe('00:00:00:00')
  })

  it('formats 83.5 seconds at 24fps', () => {
    // 83.5 * 24 = 2004 frames total
    // 2004 % 24 = 12 frames
    // 2004 / 24 = 83 seconds total
    // 83 % 60 = 23 seconds
    // 83 / 60 = 1 minute
    expect(formatTimecode(83.5, 24)).toBe('00:01:23:12')
  })

  it('formats with custom fps', () => {
    expect(formatTimecode(1, 30)).toBe('00:00:01:00')
  })
})

describe('formatBytes', () => {
  it('returns "0 B" for 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  // §190 — these three asserted the bug: divide by 1024, print "MB", which
  // by SI definition means 1000-based. A 135,458,109-byte file that macOS
  // Finder calls "135,5 MB" therefore showed as "129.2 MB". The old
  // assertions were wrong about what the label means, so they are corrected
  // here rather than deleted. Windows' 1024-with-MB convention is not lost —
  // it moved to `useFormatBytes()`, which asks the viewer's own OS, and is
  // covered in lib/__tests__/byte-units.test.ts.
  it('formats KB', () => {
    expect(formatBytes(1000)).toBe('1 KB')
    // 1024 rounds to "1 KB" either way, so this case never distinguished
    // the two conventions at all.
    expect(formatBytes(1024)).toBe('1 KB')
  })

  it('formats MB', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    // 1.5 MiB, correctly labelled as the 1.6 MB it is.
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.6 MB')
  })

  it('formats GB', () => {
    expect(formatBytes(1_500_000_000)).toBe('1.5 GB')
    expect(formatBytes(1610612736)).toBe('1.6 GB')
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for recent timestamps (within 60s)', () => {
    const recent = new Date(Date.now() - 30000).toISOString()
    expect(formatRelativeTime(recent)).toBe('just now')
  })

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5 minutes ago')
  })

  it('returns singular "minute ago"', () => {
    const oneMinAgo = new Date(Date.now() - 65 * 1000).toISOString()
    expect(formatRelativeTime(oneMinAgo)).toBe('1 minute ago')
  })

  it('returns hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2 hours ago')
  })

  it('returns days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago')
  })
})

describe('truncate', () => {
  it('returns short string unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('truncates long string with ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })

  it('returns string unchanged when equal to length', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })
})

describe('cn', () => {
  it('merges class names', () => {
    const result = cn('foo', 'bar')
    expect(result).toContain('foo')
    expect(result).toContain('bar')
  })

  it('handles conditional classes', () => {
    const result = cn('base', false && 'conditional')
    expect(result).toContain('base')
    expect(result).not.toContain('conditional')
  })

  it('merges conflicting tailwind classes (last wins)', () => {
    const result = cn('text-red-500', 'text-blue-500')
    expect(result).toBe('text-blue-500')
  })
})
