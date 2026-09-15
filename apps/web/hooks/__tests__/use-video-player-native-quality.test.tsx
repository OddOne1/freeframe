/**
 * Manual rendition switching on the native-HLS path (§185).
 *
 * §117 put Safari on its native `<video>` engine and said the cost was no
 * level list, so no quality picker — in the browser most of this project's
 * real viewing happens in. hls.js is not what knows the renditions though;
 * the master playlist is, and Safari will play one rendition's playlist as
 * readily as the master. Switching quality here means reassigning
 * `video.src`, with the native engine still doing the decoding.
 *
 * Which makes CONTINUITY the whole risk, and most of what is asserted
 * below. A reassignment starts at 0:00, paused — so a picker that threw the
 * viewer back to the top of a take every time they touched it would be
 * worse than no picker at all.
 *
 * jsdom has a real HTMLVideoElement and no decoder, which is exactly enough:
 * `src`, `currentTime` and the event plumbing are real, so what is checked
 * is the calls and the state, never decoded video. Whether Safari's engine
 * then plays the rendition can only be confirmed in Safari.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import * as React from 'react'

import { useVideoPlayer } from '../use-video-player'

const MASTER = '/api/stream/hls/master.m3u8?token=TOK'
const MANIFEST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
0/playlist.m3u8?token=TOK
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
1/playlist.m3u8?token=TOK
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360
2/playlist.m3u8?token=TOK
`

let api: ReturnType<typeof useVideoPlayer>
let videoEl: HTMLVideoElement

function Harness({ src }: { src: string }) {
  api = useVideoPlayer(src, { detached: true })
  return <video ref={api.videoRef} data-testid="v" />
}

/** jsdom's media element reports no formats and implements no playback. */
function makeSafari() {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe')
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() =>
    Promise.resolve(),
  )
}

/**
 * Stand in for the engine reaching a playable state on the new source.
 *
 * `currentTime` is zeroed FIRST, because that is what a real engine does on
 * a src reassignment and what makes this worth testing: jsdom has no media
 * pipeline, so it leaves the old value sitting there — and a restore test
 * that skips this step passes just as happily with the restore deleted.
 * (Confirmed: without this line, dropping the whole `onReady` handler still
 * left this assertion green.)
 */
function reachMetadata(duration = 120) {
  videoEl.currentTime = 0
  Object.defineProperty(videoEl, 'duration', { value: duration, configurable: true })
  act(() => {
    videoEl.dispatchEvent(new Event('loadedmetadata'))
  })
}

function setPaused(paused: boolean) {
  Object.defineProperty(videoEl, 'paused', { value: paused, configurable: true })
}

async function mount(src = MASTER) {
  const r = render(<Harness src={src} />)
  videoEl = r.getByTestId('v') as HTMLVideoElement
  await waitFor(() => expect(api.qualityLevels.length).toBeGreaterThan(0))
  return r
}

beforeEach(() => {
  makeSafari()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, text: async () => MANIFEST }) as unknown as Response),
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('discovering the renditions', () => {
  it('populates the same level list hls.js would have', async () => {
    await mount()

    expect(api.qualityLevels.map((l) => l.label)).toEqual(['1080p', '720p', '360p'])
  })

  it('starts on Auto, leaving the native ABR in charge', async () => {
    await mount()

    expect(api.currentQuality).toBe(-1)
  })

  it('reads the master the browser was already given', async () => {
    await mount()

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(MASTER)
  })

  it('leaves the picker absent when the manifest cannot be read', async () => {
    /* The behaviour that shipped before this. A quality control is not worth
       an error banner over a video that is playing fine. */
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as unknown as Response))
    const r = render(<Harness src={MASTER} />)
    videoEl = r.getByTestId('v') as HTMLVideoElement

    await new Promise((res) => setTimeout(res, 20))

    expect(api.qualityLevels).toEqual([])
    expect(api.error).toBeNull()
  })

  it('survives a manifest that is not a master playlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, text: async () => '#EXTM3U\nseg.ts\n' }) as unknown as Response),
    )
    const r = render(<Harness src={MASTER} />)
    videoEl = r.getByTestId('v') as HTMLVideoElement

    await new Promise((res) => setTimeout(res, 20))

    expect(api.qualityLevels).toEqual([])
  })
})

describe('switching rendition', () => {
  it('points the element at that rendition\'s own playlist', async () => {
    await mount()

    act(() => api.setQuality(1))

    expect(videoEl.src).toContain('/api/stream/hls/1/playlist.m3u8?token=TOK')
    expect(api.currentQuality).toBe(1)
  })

  it('goes back to the master for Auto', async () => {
    await mount()
    act(() => api.setQuality(2))

    act(() => api.setQuality(-1))

    expect(videoEl.src).toContain('/api/stream/hls/master.m3u8?token=TOK')
    expect(api.currentQuality).toBe(-1)
  })

  it('asks the element to load, rather than hoping it notices', async () => {
    await mount()

    act(() => api.setQuality(0))

    expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  })

  it('ignores an index that does not exist', async () => {
    await mount()
    const before = videoEl.src

    act(() => api.setQuality(99))

    expect(videoEl.src).toBe(before)
  })
})

describe('continuity across a switch', () => {
  it('restores the playback position', async () => {
    await mount()
    videoEl.currentTime = 42
    setPaused(true)

    act(() => api.setQuality(1))
    // Not yet: seeking before metadata would clamp to 0 on a duration-less
    // source, which is the reset this exists to prevent.
    reachMetadata()

    expect(videoEl.currentTime).toBeCloseTo(42)
  })

  it('resumes playing if it was playing', async () => {
    await mount()
    videoEl.currentTime = 10
    setPaused(false)

    act(() => api.setQuality(1))
    reachMetadata()

    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled()
  })

  it('stays paused if it was paused', async () => {
    await mount()
    videoEl.currentTime = 10
    setPaused(true)
    ;(HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear()

    act(() => api.setQuality(1))
    reachMetadata()

    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  })

  it('does not seek past the end of a shorter rendition', async () => {
    await mount()
    videoEl.currentTime = 500
    setPaused(true)

    act(() => api.setQuality(1))
    reachMetadata(120)

    expect(videoEl.currentTime).toBeLessThanOrEqual(120)
  })

  it('does not seek at all when the new source has no duration yet', async () => {
    /* A clamp against a NaN/0 duration lands on 0:00 — the reset. */
    await mount()
    videoEl.currentTime = 30
    setPaused(true)

    act(() => api.setQuality(1))
    videoEl.currentTime = 0
    Object.defineProperty(videoEl, 'duration', { value: NaN, configurable: true })
    act(() => {
      videoEl.dispatchEvent(new Event('loadedmetadata'))
    })

    // Left where the engine put it rather than seeked to a clamped 0 — the
    // restore is skipped, not attempted badly.
    expect(videoEl.currentTime).toBe(0)
  })

  it('does not restore across a LATER unrelated metadata event', async () => {
    /* The listener is one-shot. Left attached, every subsequent
       loadedmetadata would yank the viewer back to where they were when
       they last touched the picker. */
    await mount()
    videoEl.currentTime = 42
    setPaused(true)
    act(() => api.setQuality(1))
    reachMetadata()

    videoEl.currentTime = 90
    Object.defineProperty(videoEl, 'duration', { value: 120, configurable: true })
    act(() => {
      videoEl.dispatchEvent(new Event('loadedmetadata'))
    })

    expect(videoEl.currentTime).toBeCloseTo(90)
  })
})
