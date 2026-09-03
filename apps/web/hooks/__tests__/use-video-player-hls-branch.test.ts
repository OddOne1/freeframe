/**
 * §117 bug B — which media path each browser gets.
 *
 * Compare played in Chromium and failed in Safari with `HLS error:
 * mediaError`. Measured in real Safari 26.5.2: Hls.isSupported() is true
 * (desktop Safari has MSE) and canPlayType('application/vnd.apple.mpegurl')
 * is "maybe" — so with isSupported() checked first, Safari always took
 * hls.js's MSE path and the native fallback beneath it was unreachable in
 * the only browser that has a native HLS player.
 *
 * That is the failure: our segments are MPEG-TS (the ffmpeg hls muxer's
 * default), Safari's MSE will not accept TS, so hls.js must transmux and
 * append through SourceBuffer. Safari's native player reads TS directly.
 *
 * These pin the ORDER of that decision. jsdom has neither MSE nor a media
 * stack, so the hook itself cannot be exercised here; the branch condition
 * is asserted against the shipped source, and the real-browser numbers above
 * are in the commit message.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'use-video-player.ts'), 'utf8')
// Bounded from the branch itself to the NEXT cleanup after it: `return () =>`
// appears in earlier effects too, and an unanchored indexOf produced an empty
// slice.
//
// COMMENTS STRIPPED FIRST. The code being asserted on explains itself, and
// that prose names both `Hls.isSupported()` and canPlayType — so an ordering
// check over the raw text compares the comment to the comment, not the two
// conditions. (This bit me three times across this codebase; see §115's
// dispatch test and §116's sizing test for the same shape.)
const attachStart = src.indexOf('const isHlsSource')
const attach = src
  .slice(attachStart, src.indexOf('return () => {', attachStart))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

/** Reproduces the shipped condition for a given browser's capabilities. */
function branchFor({ canPlayType, hlsSupported }: { canPlayType: string; hlsSupported: boolean }) {
  const isHlsSource = true
  const nativeHls = isHlsSource && Boolean(canPlayType)
  if (nativeHls) return 'native'
  if (isHlsSource && hlsSupported) return 'hlsjs'
  return 'direct'
}

describe('HLS path selection', () => {
  it('Safari gets native playback, not hls.js', () => {
    // Real values, measured in Safari 26.5.2.
    expect(branchFor({ canPlayType: 'maybe', hlsSupported: true })).toBe('native')
  })

  it('Chromium is unchanged and still gets hls.js', () => {
    // Real values, measured in Electron/Chromium.
    expect(branchFor({ canPlayType: '', hlsSupported: true })).toBe('hlsjs')
  })

  it('a browser with neither still gets a direct src', () => {
    expect(branchFor({ canPlayType: '', hlsSupported: false })).toBe('direct')
  })

  it('the shipped code tests native support BEFORE Hls.isSupported()', () => {
    // The ordering IS the fix: both conditions are true in Safari, so
    // whichever is asked first decides, and asking isSupported() first is
    // what made the native branch dead code there.
    const nativeAt = attach.indexOf("canPlayType('application/vnd.apple.mpegurl')")
    const hlsAt = attach.indexOf('Hls.isSupported()')
    expect(nativeAt).toBeGreaterThan(-1)
    expect(hlsAt).toBeGreaterThan(-1)
    expect(nativeAt).toBeLessThan(hlsAt)
  })

  it('a fatal hls.js error reports its details, not just the type', () => {
    // Every report of this arrived as "mediaError", which does not
    // distinguish a codec Safari's MSE refuses from a segment that never
    // loaded. `details` is the part that names it.
    expect(src).toContain('data.details')
  })
})

describe('a video track that never decodes is reported', () => {
  // §117 put this check inline in onLoadedMetadata. §118 moved it out,
  // because that was the wrong moment: Safari reports 0x0 there on healthy
  // media and only knows the size ~1.2s later. These are INVERTED rather
  // than deleted — the guard still exists, it just is not a one-shot check
  // any more, and the rule itself is covered in
  // use-video-player-no-picture.test.ts.
  const metadata = src.slice(src.indexOf('const onLoadedMetadata'), src.indexOf('const evaluatePicture'))

  it('no longer decides at loadedmetadata, where the answer is not yet known', () => {
    expect(metadata).not.toContain('videoWidth === 0')
    expect(metadata).toContain('evaluatePicture()')
  })

  it('still reports a pictureless media, via the extracted rule', () => {
    expect(src).toContain('picturelessVerdict')
    expect(src).toContain('NO_PICTURE_ERROR')
  })
})
