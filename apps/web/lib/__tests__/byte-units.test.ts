/**
 * File sizes match the viewer's OWN operating system (§190).
 *
 * Found from real data, not theory. Mathias compared a share link against
 * Finder: `P1012993.RW2_.png` is 135,458,109 bytes (confirmed by SQL),
 * Finder says "135,5 MB", FreeFrame said "129.2 MB". The database was never
 * wrong — the row was verified by a real S3 HEAD at upload. The app divided
 * by 1024 and labelled it "MB", which by SI definition means 1000.
 *
 * "Just use decimal" was researched and rejected: Windows Explorer really
 * does use 1024 while still printing "MB", so a Windows viewer currently
 * agrees with FreeFrame by coincidence — both wrong in the same direction.
 * Flipping everything to decimal would fix Finder and break Explorer.
 *
 *   macOS / iOS / Android / GNOME Files   decimal
 *   Windows Explorer                      binary, labelled MB
 *   KDE Dolphin                           binary, labelled MiB (undetectable)
 */
import { describe, it, expect } from 'vitest'

import {
  DEFAULT_BYTE_UNIT_MODE,
  detectByteUnitMode,
  formatBytesIn,
  isWindowsPlatform,
} from '../byte-units'

/** The file from the investigation. */
const REAL_FILE = 135_458_109

describe('the file that started this', () => {
  it('reads as Finder reads it, in decimal', () => {
    expect(formatBytesIn(REAL_FILE, 'decimal')).toBe('135.5 MB')
  })

  it('reads as Windows Explorer reads it, in binary', () => {
    expect(formatBytesIn(REAL_FILE, 'binary')).toBe('129.2 MB')
  })

  it('and those are genuinely different numbers for one byte count', () => {
    /* The whole bug in one line: same file, two answers, and the app was
       giving the second while claiming the first's units. */
    expect(formatBytesIn(REAL_FILE, 'decimal')).not.toBe(
      formatBytesIn(REAL_FILE, 'binary'),
    )
  })
})

describe('the maths, both ways', () => {
  it.each([
    [0, 'decimal', '0 B'],
    [0, 'binary', '0 B'],
    [500, 'decimal', '500 B'],
    [1_000, 'decimal', '1 KB'],
    [1_024, 'binary', '1 KB'],
    [1_500_000, 'decimal', '1.5 MB'],
    [1.5 * 1024 * 1024, 'binary', '1.5 MB'],
    [1_500_000_000, 'decimal', '1.5 GB'],
    [1610612736, 'binary', '1.5 GB'],
    [2_000_000_000_000, 'decimal', '2 TB'],
  ] as const)('%s bytes in %s mode -> %s', (bytes, mode, expected) => {
    expect(formatBytesIn(bytes, mode)).toBe(expected)
  })

  it('labels each unit the same in both conventions', () => {
    /* Deliberately NOT MiB/GiB on the binary branch: the point is to match
       Windows Explorer, which prints "MB". Being pedantically correct here
       would disagree with the very thing being matched. */
    expect(formatBytesIn(REAL_FILE, 'binary')).toMatch(/ MB$/)
    expect(formatBytesIn(REAL_FILE, 'decimal')).toMatch(/ MB$/)
  })

  it('does not run off the end of the unit list', () => {
    const huge = 10 ** 30
    expect(formatBytesIn(huge, 'decimal')).toMatch(/ TB$/)
    expect(formatBytesIn(huge, 'binary')).toMatch(/ TB$/)
  })

  it('handles values below a kilobyte without decimals', () => {
    expect(formatBytesIn(1, 'decimal')).toBe('1 B')
    expect(formatBytesIn(999, 'decimal')).toBe('999 B')
  })
})

describe('recognising Windows', () => {
  it.each([
    'Windows',
    'Win32',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:40.0) Gecko/20100101',
  ])('treats %s as Windows', (platform) => {
    expect(isWindowsPlatform(platform)).toBe(true)
  })

  it.each([
    // "darwin" CONTAINS "win", and the first version of this used a bare
    // /win/i substring test — so every Mac was being served Windows'
    // convention. jsdom's own UA is "Mozilla/5.0 (darwin) ..." and the
    // suite caught it within minutes. macOS's `process.platform` is
    // literally "darwin" too, so the desktop app would have had it as well.
    'darwin',
    'Mozilla/5.0 (darwin) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/29.0.0',
    'macOS',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    'Mozilla/5.0 (X11; Linux x86_64)',
    'Linux',
    'Android',
  ])('does not treat %s as Windows', (platform) => {
    expect(isWindowsPlatform(platform)).toBe(false)
  })

  it.each([undefined, null, ''])('treats %s as not-Windows', (platform) => {
    expect(isWindowsPlatform(platform)).toBe(false)
  })
})

describe('detection against a browser', () => {
  const withNavigator = (nav: unknown, fn: () => void) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      configurable: true,
      writable: true,
    })
    try {
      fn()
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  }

  it('prefers userAgentData.platform where it exists', () => {
    withNavigator(
      { userAgentData: { platform: 'Windows' }, userAgent: 'irrelevant' },
      () => expect(detectByteUnitMode()).toBe('binary'),
    )
  })

  it('falls back to the classic user-agent string', () => {
    withNavigator(
      { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      () => expect(detectByteUnitMode()).toBe('binary'),
    )
  })

  it('gives a Mac decimal', () => {
    withNavigator(
      { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      () => expect(detectByteUnitMode()).toBe('decimal'),
    )
  })

  it('returns null with no navigator at all — the SSR case', () => {
    /* Null rather than a guess, so the caller can tell "no browser yet"
       from "confirmed Mac". Guessing here is what turns a server render
       into a hydration mismatch. */
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    delete (globalThis as { navigator?: unknown }).navigator
    try {
      expect(detectByteUnitMode()).toBeNull()
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original)
    }
  })

  it('returns null rather than throwing when the platform is unreadable', () => {
    withNavigator({}, () => expect(detectByteUnitMode()).toBeNull())
  })
})

describe('the default', () => {
  it('is decimal — the majority, and what the labels mean', () => {
    expect(DEFAULT_BYTE_UNIT_MODE).toBe('decimal')
  })
})
