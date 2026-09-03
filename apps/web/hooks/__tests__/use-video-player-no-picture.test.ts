/**
 * §118 — the "no playable picture" guard must re-check, not fire once.
 *
 * The §117 version checked videoWidth at loadedmetadata. Measured in Safari
 * 26.5.2 on a native HLS stream: loadedmetadata fires at ~110ms with
 * videoWidth 0, and the real size is not known until ~1.2s later, announced
 * by `resize` — which fires again on every ABR switch (960x540 -> 480x270 ->
 * 768x432). So it reported "no picture" for every Safari playback and never
 * took it back, while Chromium populates dimensions immediately and never
 * showed it at all.
 *
 * The rule is tested here; the wiring is asserted from the source below; and
 * the integration was measured in real Safari against the shipped hook —
 * a healthy HLS stream stayed clean at 3s/9s/14s, and a real WAV in a
 * <video> raised the message after the grace and kept it. jsdom implements
 * no media pipeline, so driving the hook there would prove none of that.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { picturelessVerdict } from '../use-video-player'

const src = readFileSync(join(__dirname, '..', 'use-video-player.ts'), 'utf8')

describe('picturelessVerdict', () => {
  it('is too early at loadedmetadata, where Safari reports 0x0 for healthy media', () => {
    // The exact numbers measured in Safari at 110ms.
    expect(picturelessVerdict({ videoWidth: 0, videoHeight: 0, readyState: 1, currentTime: 0 }))
      .toBe('too-early')
  })

  it('reports a picture as soon as real dimensions appear', () => {
    // Measured at 1283ms, announced by `resize`.
    expect(picturelessVerdict({ videoWidth: 960, videoHeight: 540, readyState: 1, currentTime: 0 }))
      .toBe('has-picture')
  })

  it('does not accuse a slow start part-way through the grace period', () => {
    expect(picturelessVerdict({ videoWidth: 0, videoHeight: 0, readyState: 4, currentTime: 4.9 }))
      .toBe('too-early')
  })

  it('reports no picture once playback has genuinely progressed', () => {
    expect(picturelessVerdict({ videoWidth: 0, videoHeight: 0, readyState: 4, currentTime: 6 }))
      .toBe('no-picture')
  })

  it('needs real decoded data, not just a clock', () => {
    // readyState 1 with a large currentTime is not evidence of decoding.
    expect(picturelessVerdict({ videoWidth: 0, videoHeight: 0, readyState: 1, currentTime: 30 }))
      .toBe('too-early')
  })

  it('treats a half-known size as no picture yet, not as a picture', () => {
    expect(picturelessVerdict({ videoWidth: 1920, videoHeight: 0, readyState: 4, currentTime: 6 }))
      .toBe('no-picture')
  })
})

describe('how the hook uses it', () => {
  const effect = src.slice(src.indexOf('const evaluatePicture'), src.indexOf('const onTimeUpdate'))

  it('clears on a picture and raises on no-picture', () => {
    expect(effect).toContain("verdict === 'has-picture'")
    expect(effect).toContain("verdict === 'no-picture'")
  })

  it('never clears an error it did not set', () => {
    // Both branches compare against NO_PICTURE_ERROR before writing, so a
    // real decode failure survives the picture arriving.
    expect(effect).toContain('prev === NO_PICTURE_ERROR')
    expect(effect).not.toContain('setError(null)')
  })

  it('re-checks on every signal that can change the answer', () => {
    // `resize` is the one that actually announces a known size; the one-shot
    // loadedmetadata check is what made this wrong in the first place.
    for (const ev of ['resize', 'loadeddata', 'playing']) {
      expect(src).toContain(`video.addEventListener('${ev}', evaluatePicture)`)
      expect(src).toContain(`video.removeEventListener('${ev}', evaluatePicture)`)
    }
    // And continuously, which is what keeps it raised for a broken media.
    const timeUpdate = src.slice(src.indexOf('const onTimeUpdate'), src.indexOf('const onPlay'))
    expect(timeUpdate).toContain('evaluatePicture()')
  })
})
