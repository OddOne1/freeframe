import { describe, expect, it } from 'vitest'
import {
  MIN_CLIP_MS, clampClip, formatClipTime, formatDuration, isValidClip, moveEdge,
  moveEdgeSnapped, parseClipTime, snapToWord, wordIndexAt,
} from '../snippet-timing'

const clip = (start_ms: number, end_ms: number) => ({ start_ms, end_ms })

describe('moveEdge', () => {
  it('moves the in point freely inside the clip', () => {
    expect(moveEdge(clip(5000, 12000), 'in', 6200, 60000)).toEqual(clip(6200, 12000))
  })
  it('never lets the in point come within 1 s of the out point', () => {
    expect(moveEdge(clip(5000, 12000), 'in', 11800, 60000)).toEqual(clip(11000, 12000))
    expect(moveEdge(clip(5000, 12000), 'in', 20000, 60000)).toEqual(clip(11000, 12000))
  })
  it('never lets the out point come within 1 s of the in point', () => {
    expect(moveEdge(clip(5000, 12000), 'out', 5300, 60000)).toEqual(clip(5000, 6000))
    expect(moveEdge(clip(5000, 12000), 'out', 0, 60000)).toEqual(clip(5000, 6000))
  })
  it('the moved edge gives way, the other stays put', () => {
    const r = moveEdge(clip(5000, 12000), 'in', 99999, 60000)
    expect(r.end_ms).toBe(12000)
  })
  it('clamps to the start and end of the file', () => {
    expect(moveEdge(clip(5000, 12000), 'in', -400, 60000)).toEqual(clip(0, 12000))
    expect(moveEdge(clip(5000, 12000), 'out', 61000, 60000)).toEqual(clip(5000, 60000))
  })
  it('has no upper bound while the duration is unknown', () => {
    expect(moveEdge(clip(5000, 12000), 'out', 900000, null)).toEqual(clip(5000, 900000))
    expect(moveEdge(clip(5000, 12000), 'out', 900000, 0)).toEqual(clip(5000, 900000))
  })
  it('rounds to whole milliseconds', () => {
    expect(moveEdge(clip(5000, 12000), 'in', 6200.4, 60000).start_ms).toBe(6200)
  })
})

describe('clampClip', () => {
  it('leaves a valid clip alone', () => {
    expect(clampClip(clip(1000, 9000), 60000)).toEqual(clip(1000, 9000))
  })
  it('pulls an end past the file back to the file end', () => {
    expect(clampClip(clip(50000, 70000), 60000)).toEqual(clip(50000, 60000))
  })
  it('widens a too-short clip forward, or backward at the end of the file', () => {
    expect(clampClip(clip(1000, 1200), 60000)).toEqual(clip(1000, 2000))
    expect(clampClip(clip(59800, 60000), 60000)).toEqual(clip(59000, 60000))
  })
  it('fixes a negative start', () => {
    expect(clampClip(clip(-500, 4000), 60000)).toEqual(clip(0, 4000))
  })
})

describe('isValidClip', () => {
  it('follows the server rules', () => {
    expect(isValidClip(clip(0, MIN_CLIP_MS), 60000)).toBe(true)
    expect(isValidClip(clip(0, MIN_CLIP_MS - 1), 60000)).toBe(false)
    expect(isValidClip(clip(59000, 60001), 60000)).toBe(false)
    expect(isValidClip(clip(59000, 60001), null)).toBe(true)
    expect(isValidClip(clip(-1, 5000), 60000)).toBe(false)
  })
})

const words = [
  { start_ms: 1000, end_ms: 1400 },
  { start_ms: 1500, end_ms: 2100 },
  { start_ms: 2200, end_ms: 2600 },
  // a long pause
  { start_ms: 9000, end_ms: 9500 },
]

describe('snapToWord', () => {
  it('snaps an in point to the nearest word start', () => {
    expect(snapToWord(1600, words, 'in')).toBe(1500)
    expect(snapToWord(1900, words, 'in')).toBe(2200)
  })
  it('snaps an out point to the nearest word end', () => {
    expect(snapToWord(2000, words, 'out')).toBe(2100)
    expect(snapToWord(2500, words, 'out')).toBe(2600)
  })
  it('stays put when no boundary is near enough', () => {
    expect(snapToWord(5500, words, 'in')).toBe(5500)
  })
  it('stays put with no words', () => {
    expect(snapToWord(1234, [], 'out')).toBe(1234)
  })
  it('does not need sorted input', () => {
    expect(snapToWord(1600, [...words].reverse(), 'in')).toBe(1500)
  })
})

describe('moveEdgeSnapped', () => {
  it('snaps, then clamps, so a snap cannot break the 1 s rule', () => {
    // nearest word start to 2150 is 2200, but the out point is at 3000
    expect(moveEdgeSnapped(clip(1000, 3000), 'in', 2150, 60000, words, true)).toEqual(clip(2000, 3000))
  })
  it('does not snap when snapping is off', () => {
    expect(moveEdgeSnapped(clip(0, 9000), 'in', 1600, 60000, words, false)).toEqual(clip(1600, 9000))
  })
  it('snaps when on', () => {
    expect(moveEdgeSnapped(clip(0, 9000), 'in', 1600, 60000, words, true)).toEqual(clip(1500, 9000))
  })
})

describe('wordIndexAt', () => {
  it('finds the word under the playhead', () => {
    expect(wordIndexAt(words, 1000)).toBe(0)
    expect(wordIndexAt(words, 2000)).toBe(1)
    expect(wordIndexAt(words, 9499)).toBe(3)
  })
  it('is -1 in a pause and outside the words', () => {
    expect(wordIndexAt(words, 1450)).toBe(-1)
    expect(wordIndexAt(words, 500)).toBe(-1)
    expect(wordIndexAt(words, 9500)).toBe(-1)
    expect(wordIndexAt([], 0)).toBe(-1)
  })
})

describe('formatting and parsing', () => {
  it('formats clip times to the tenth', () => {
    expect(formatClipTime(83450)).toBe('1:23.5')
    expect(formatClipTime(0)).toBe('0:00.0')
  })
  it('formats durations', () => {
    expect(formatDuration(8500)).toBe('8.5 s')
    expect(formatDuration(42000)).toBe('0:42')
    expect(formatDuration(125000)).toBe('2:05')
  })
  it('parses seconds, m:ss.t and h:mm:ss', () => {
    expect(parseClipTime('83.5')).toBe(83500)
    expect(parseClipTime('1:23.5')).toBe(83500)
    expect(parseClipTime('1:02:03')).toBe(3723000)
    expect(parseClipTime('abc')).toBeNull()
    expect(parseClipTime('')).toBeNull()
    expect(parseClipTime('-3')).toBeNull()
  })
  it('round-trips a formatted time', () => {
    expect(parseClipTime(formatClipTime(83500))).toBe(83500)
  })
})
