/**
 * Fullscreen, by whichever API the browser actually has (§228c item 5).
 *
 * The owner, from an iPhone: "in mobile view the Fullscreen button isn't
 * working." The cause was one line — `containerEl.requestFullscreen()
 * .catch(() => {})`. iPhone Safari implements no element-level Fullscreen
 * API at all (only `webkitEnterFullscreen` on the `<video>` itself), so
 * `requestFullscreen` was `undefined`, the call threw a TypeError before
 * any promise existed for `.catch` to catch, and the throw died inside a
 * click handler. Nothing happened and nothing was logged.
 *
 * WHAT THIS CAN AND CANNOT SHOW. jsdom implements none of the Fullscreen
 * API (verified: `Element.prototype.requestFullscreen`,
 * `document.exitFullscreen` and `document.fullscreenElement` are all
 * undefined), and Chromium cannot be made to behave like iPhone Safari.
 * So what is tested here is the DISPATCH: given each of the four API
 * shapes a browser can present, which function gets called, on which
 * object, and whether anything throws. That the iPhone's own shape is the
 * third one is sourced from the API being absent there, not demonstrated
 * here — the real check is the owner's, on his phone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import * as React from 'react'

import { useVideoPlayer, detectFullscreenMode } from '../use-video-player'

let api: ReturnType<typeof useVideoPlayer>
let videoEl: HTMLVideoElement

function Harness() {
  api = useVideoPlayer(null, { detached: true })
  return <video ref={api.videoRef} data-testid="v" />
}

/** Everything this test defines on the DOM, taken off again afterwards. */
const planted: Array<() => void> = []

function plant(target: object, key: string, value: unknown) {
  const had = Object.prototype.hasOwnProperty.call(target, key)
  const original = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { value, configurable: true, writable: true })
  planted.push(() => {
    if (had && original) Object.defineProperty(target, key, original)
    else delete (target as Record<string, unknown>)[key]
  })
}

function mount() {
  const { container } = render(<Harness />)
  videoEl = container.querySelector('video') as HTMLVideoElement
  return container
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  planted.splice(0).forEach((undo) => undo())
  vi.restoreAllMocks()
})

describe('§228c item 5 — which fullscreen API gets called', () => {
  it('the standard API: on the CONTAINER, not on the video', () => {
    const onContainer = vi.fn(() => Promise.resolve())
    const onVideo = vi.fn()
    plant(Element.prototype, 'requestFullscreen', onContainer)
    plant(HTMLVideoElement.prototype, 'webkitEnterFullscreen', onVideo)

    mount()
    const container = document.createElement('div')
    let used: string | undefined
    act(() => {
      used = api.toggleFullscreen(container)
    })

    expect(used).toBe('element')
    expect(onContainer).toHaveBeenCalledTimes(1)
    // The element it was called ON is the point: the native iOS player
    // shows the video alone, so taking that path on a desktop would throw
    // away our own controls and the timestamped comments with them.
    expect(onContainer.mock.instances[0]).toBe(container)
    expect(onVideo).not.toHaveBeenCalled()
  })

  it('only the webkit-prefixed element API: that one, same container', () => {
    const prefixed = vi.fn()
    plant(Element.prototype, 'webkitRequestFullscreen', prefixed)
    // and no unprefixed one at all
    expect(
      (document.documentElement as unknown as Record<string, unknown>)
        .requestFullscreen,
    ).toBeUndefined()

    mount()
    const container = document.createElement('div')
    let used: string | undefined
    act(() => {
      used = api.toggleFullscreen(container)
    })

    expect(used).toBe('element-webkit')
    expect(prefixed).toHaveBeenCalledTimes(1)
    expect(prefixed.mock.instances[0]).toBe(container)
  })

  it('only `video.webkitEnterFullscreen` — the iPhone: on the VIDEO', () => {
    const enter = vi.fn()
    plant(HTMLVideoElement.prototype, 'webkitEnterFullscreen', enter)

    mount()
    const container = document.createElement('div')
    let used: string | undefined
    act(() => {
      used = api.toggleFullscreen(container)
    })

    expect(used).toBe('video-native')
    expect(enter).toHaveBeenCalledTimes(1)
    expect(enter.mock.instances[0]).toBe(videoEl)
  })

  it('nothing at all: no call, no throw, and the mode says `none`', () => {
    mount()
    const container = document.createElement('div')
    let used: string | undefined
    // The assertion that matters is that this does not throw. The old
    // implementation threw a TypeError here, which is the whole bug.
    expect(() => {
      act(() => {
        used = api.toggleFullscreen(container)
      })
    }).not.toThrow()
    expect(used).toBe('none')
    expect(api.fullscreenMode).toBe('none')
  })

  it('and a rejected promise from the standard API is swallowed too', () => {
    // Chrome rejects this when the gesture is not trusted, which is every
    // programmatic call. It must not surface as an unhandled rejection.
    plant(Element.prototype, 'requestFullscreen', () =>
      Promise.reject(new Error('not allowed')),
    )
    mount()
    expect(() => {
      act(() => {
        api.toggleFullscreen(document.createElement('div'))
      })
    }).not.toThrow()
  })
})

describe('§228c item 5 — leaving fullscreen, on each path', () => {
  it('the standard API exits on the DOCUMENT', () => {
    const exit = vi.fn(() => Promise.resolve())
    plant(Element.prototype, 'requestFullscreen', vi.fn(() => Promise.resolve()))
    plant(document, 'exitFullscreen', exit)
    plant(document, 'fullscreenElement', document.createElement('div'))

    mount()
    act(() => {
      api.toggleFullscreen(document.createElement('div'))
    })
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('the prefixed API exits with the prefixed call', () => {
    const exit = vi.fn()
    plant(Element.prototype, 'webkitRequestFullscreen', vi.fn())
    plant(document, 'webkitExitFullscreen', exit)
    plant(document, 'webkitFullscreenElement', document.createElement('div'))

    mount()
    act(() => {
      api.toggleFullscreen(document.createElement('div'))
    })
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('the iPhone exits on the VIDEO, and only while it is displaying', () => {
    const enter = vi.fn()
    const exit = vi.fn()
    plant(HTMLVideoElement.prototype, 'webkitEnterFullscreen', enter)
    plant(HTMLVideoElement.prototype, 'webkitExitFullscreen', exit)
    plant(HTMLVideoElement.prototype, 'webkitDisplayingFullscreen', true)

    mount()
    act(() => {
      api.toggleFullscreen(document.createElement('div'))
    })
    // `document.fullscreenElement` is meaningless on this path — the
    // document never has a fullscreen element, the video has its own flag.
    expect(exit).toHaveBeenCalledTimes(1)
    expect(enter).not.toHaveBeenCalled()
  })
})

describe('§228c item 5 — `isFullscreen` stays true to all three paths', () => {
  it('follows the standard event', () => {
    plant(Element.prototype, 'requestFullscreen', vi.fn(() => Promise.resolve()))
    mount()
    expect(api.isFullscreen).toBe(false)

    plant(document, 'fullscreenElement', document.createElement('div'))
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(api.isFullscreen).toBe(true)

    // Escape, or the browser's own exit button.
    planted.pop()?.()
    act(() => {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
    expect(api.isFullscreen).toBe(false)
  })

  it('follows the webkit-prefixed event', () => {
    plant(Element.prototype, 'webkitRequestFullscreen', vi.fn())
    mount()
    plant(document, 'webkitFullscreenElement', document.createElement('div'))
    act(() => {
      document.dispatchEvent(new Event('webkitfullscreenchange'))
    })
    expect(api.isFullscreen).toBe(true)
  })

  it("follows the iPhone's own two events, on the video element", () => {
    plant(HTMLVideoElement.prototype, 'webkitEnterFullscreen', vi.fn())
    mount()
    // Neither `fullscreenchange` nor the prefixed one ever fires here, so
    // without these two listeners `isFullscreen` would be permanently
    // false and the button would keep saying "Enter fullscreen".
    act(() => {
      videoEl.dispatchEvent(new Event('webkitbeginfullscreen'))
    })
    expect(api.isFullscreen).toBe(true)
    act(() => {
      videoEl.dispatchEvent(new Event('webkitendfullscreen'))
    })
    expect(api.isFullscreen).toBe(false)
  })
})

describe('§228c item 5 — the detector on its own', () => {
  it('prefers the standard API over both fallbacks', () => {
    plant(Element.prototype, 'requestFullscreen', vi.fn())
    plant(Element.prototype, 'webkitRequestFullscreen', vi.fn())
    const video = document.createElement('video')
    plant(video, 'webkitEnterFullscreen', vi.fn())
    expect(detectFullscreenMode(video)).toBe('element')
  })

  it('and asks the video only when the element APIs are both absent', () => {
    const video = document.createElement('video')
    expect(detectFullscreenMode(video)).toBe('none')
    plant(video, 'webkitEnterFullscreen', vi.fn())
    expect(detectFullscreenMode(video)).toBe('video-native')
  })

  it('answers `none` when there is no video to ask', () => {
    expect(detectFullscreenMode(null)).toBe('none')
  })
})
