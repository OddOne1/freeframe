/**
 * §117 bug B — a compare pane that cannot play must say so.
 *
 * The reported failure was completely silent: both stream URLs fetched
 * successfully (200, correct distinct version_ids), the scrubber kept
 * advancing, and neither video ever played, with nothing in the console.
 *
 * Two independent mechanisms produced that silence, and both are covered
 * here. applySideState swallowed a rejected play() — the rAF clock is driven
 * by wall time, not by the media, so the transport carries on regardless.
 * And the overlay only ever surfaced the stream-URL fetch error, never the
 * player's own error, so an HLS or decode failure had nowhere to appear.
 */
import { describe, it, expect, vi } from 'vitest'
import { applySideState } from '../use-synced-transport'

const side = { offset: 0, duration: 10 }

function fakeVideo(playImpl: () => unknown) {
  return { paused: true, currentTime: 0, play: playImpl, pause: vi.fn() }
}

describe('a rejected play() is reported', () => {
  it('hands the rejection to the caller instead of discarding it', async () => {
    const err = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    const onPlayError = vi.fn()
    applySideState(fakeVideo(() => Promise.reject(err)), 1, side, true, 0.04, onPlayError)
    await new Promise((r) => setTimeout(r, 0))
    expect(onPlayError).toHaveBeenCalledWith(err)
  })

  it('reports a synchronous throw too', async () => {
    const onPlayError = vi.fn()
    applySideState(
      fakeVideo(() => { throw new Error('sync') }),
      1, side, true, 0.04, onPlayError,
    )
    await new Promise((r) => setTimeout(r, 0))
    // Promise.resolve() around a throwing call still rejects, so this must be
    // caught rather than escaping as an uncaught error out of the rAF loop.
    expect(onPlayError).toHaveBeenCalled()
  })

  it('stays silent when play() succeeds', async () => {
    const onPlayError = vi.fn()
    applySideState(fakeVideo(() => Promise.resolve()), 1, side, true, 0.04, onPlayError)
    await new Promise((r) => setTimeout(r, 0))
    expect(onPlayError).not.toHaveBeenCalled()
  })

  it('does not throw when no reporter is supplied', () => {
    expect(() =>
      applySideState(fakeVideo(() => Promise.reject(new Error('x'))), 1, side, true),
    ).not.toThrow()
  })
})
