/**
 * The synced transport's per-side drift tolerance (upstream issue #183).
 *
 * Upstream shipped ONE blended `fps` for both panes, and had no test that ever
 * put two different frame rates through one hook call — which is exactly the
 * case the blend is wrong for. Two versions of an asset genuinely can differ in
 * rate (a re-export, a conform), and the paused tolerance is what decides
 * whether a parked pane re-seeks on every animation frame.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { applySideState, useSyncedTransport, type SlavableVideo } from '../use-synced-transport'
import { frameStep } from '@/lib/compare-time'

// Two real fake <video>s, one per side, so the WIRING is observable: which
// tolerance actually reaches which pane. Asserting applySideState directly
// proves the arithmetic and nothing about how the hook hands it out — which
// is precisely where #183 lived.
const videoA = makeFakeVideo()
const videoB = makeFakeVideo()
let nextRef = 0
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({ videoRef: { current: nextRef++ % 2 === 0 ? videoA : videoB } }),
}))

function makeFakeVideo() {
  const seeks: number[] = []
  let _t = 0
  return {
    get currentTime() { return _t },
    set currentTime(v: number) { _t = v; seeks.push(v) },
    paused: true,
    play: () => undefined,
    pause: () => undefined,
    seeks,
    reset(at: number) { _t = at; seeks.length = 0 },
  }
}

/** A parked video sitting `drift` seconds away from where it should be. */
function parkedAt(expected: number, drift: number): SlavableVideo & { seeks: number[] } {
  const seeks: number[] = []
  let _t = expected + drift
  return {
    get currentTime() { return _t },
    set currentTime(v: number) { _t = v; seeks.push(v) },
    paused: true,
    play: () => undefined,
    pause: () => undefined,
    seeks,
  }
}

const SIDE = { offset: 0, duration: 100 }

describe('per-side paused drift tolerance (#183)', () => {
  it('a 24fps pane tolerates drift that a 60fps pane does not', () => {
    // ~30ms: inside one frame at 24fps (41.7ms), outside one at 60fps (16.7ms).
    const drift = 0.03
    const slow = parkedAt(10, drift)
    const fast = parkedAt(10, drift)

    applySideState(slow, 10, SIDE, false, frameStep(24))
    applySideState(fast, 10, SIDE, false, frameStep(60))

    expect(slow.seeks).toEqual([])
    expect(fast.seeks).toEqual([10])
  })

  it('the blend upstream used gets one of the two sides wrong', () => {
    // This is the bug, stated as a test: comparing 24fps against 60fps,
    // upstream fed BOTH sides one blended rate. Whichever rate loses the blend
    // is handed a tolerance that is not one of its own frames.
    const drift = 0.03
    const blended = frameStep(60) // mediaB.fps ?? mediaA.fps — one side's rate wins

    const slowUnderBlend = parkedAt(10, drift)
    applySideState(slowUnderBlend, 10, SIDE, false, blended)
    // The 24fps pane is re-seeked for a drift smaller than one of ITS frames:
    // that seek snaps to the same frame it was already showing, and the next
    // animation frame asks again. That is the decoder thrash.
    expect(slowUnderBlend.seeks).toEqual([10])

    const slowUnderOwnRate = parkedAt(10, drift)
    applySideState(slowUnderOwnRate, 10, SIDE, false, frameStep(24))
    expect(slowUnderOwnRate.seeks).toEqual([])
  })

  it('the DEFAULT tolerance is a whole frame, not a sub-frame threshold', () => {
    // applySideState's own default, used by any caller that omits the
    // tolerance. #183's root cause was a 1ms threshold here: a paused seek
    // snaps to the nearest decodable frame, essentially never exactly the
    // expected time, so a sub-frame default re-issues the seek every rAF
    // forever — decoder thrash on the paused-frame inspection compare is for.
    const v = parkedAt(10, 0.03)
    applySideState(v, 10, SIDE, false)
    expect(v.seeks).toEqual([])
  })

  it('an unknown rate falls back to ~25fps rather than a sub-frame threshold', () => {
    // Pre-backfill files have no fps. The fallback must still be a real frame,
    // not something so tight every parked tick re-seeks.
    expect(frameStep(null)).toBe(0.04)
    const v = parkedAt(10, 0.03)
    applySideState(v, 10, SIDE, false, frameStep(null))
    expect(v.seeks).toEqual([])
  })

  it('routes each pane its OWN tolerance through the hook', () => {
    // The end-to-end claim, and the one no upstream test made: two differing
    // rates through ONE hook call, each pane slaved with its own tolerance.
    nextRef = 0
    const { result } = renderHook(() =>
      useSyncedTransport({
        urlA: '/a.m3u8',
        urlB: '/b.m3u8',
        timingA: { offset: 0, duration: 100 },
        timingB: { offset: 0, duration: 100 },
        fpsA: 24,
        fpsB: 60,
      }),
    )
    // Park both 30ms away from the seek target: inside one 24fps frame,
    // outside one 60fps frame.
    videoA.reset(10.03)
    videoB.reset(10.03)
    act(() => { result.current.seekTo(10) })

    expect(videoA.seeks).toEqual([])   // 24fps side: left alone
    expect(videoB.seeks).toEqual([10]) // 60fps side: corrected
  })

  it('swapping the two rates swaps which pane is corrected', () => {
    // Guards the obvious wrong fix — two tolerances that are both computed but
    // handed to the wrong sides reads identically to the test above.
    nextRef = 0
    const { result } = renderHook(() =>
      useSyncedTransport({
        urlA: '/a.m3u8',
        urlB: '/b.m3u8',
        timingA: { offset: 0, duration: 100 },
        timingB: { offset: 0, duration: 100 },
        fpsA: 60,
        fpsB: 24,
      }),
    )
    videoA.reset(10.03)
    videoB.reset(10.03)
    act(() => { result.current.seekTo(10) })

    expect(videoA.seeks).toEqual([10])
    expect(videoB.seeks).toEqual([])
  })
})
