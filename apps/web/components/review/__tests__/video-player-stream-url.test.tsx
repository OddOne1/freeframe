/**
 * VideoPlayer actually routes its stream URL through resolveStreamUrl
 * (CLAUDE.md §32).
 *
 * Sibling to share-stream-url.test.tsx, which pins what the helper DOES.
 * This pins that the player still USES it — dropping the call is a silent
 * regression the helper's own tests cannot see, and it is precisely the
 * shape of the original bug (a resolution happening in the wrong number of
 * places).
 *
 * Asserted on the argument handed to useVideoPlayer, because that is the
 * value that becomes the request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

const seenUrls: (string | null)[] = []

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: (url: string | null) => {
    seenUrls.push(url)
    // Mirrors the real hook's return shape (hooks/use-video-player.ts:309-333)
    // — the player reads qualityLevels.length during render, so an
    // incomplete mock fails for reasons that have nothing to do with URLs.
    return {
      videoRef: { current: null },
      hlsRef: { current: null },
      isPlaying: false, currentTime: 0, duration: 0, buffered: 0,
      volume: 1, isMuted: false, playbackRate: 1,
      qualityLevels: [], currentQuality: -1,
      isLoading: false, isFullscreen: false, error: null,
      play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seek: vi.fn(),
      setPlaybackRate: vi.fn(), setQuality: vi.fn(), setVolume: vi.fn(),
      toggleMute: vi.fn(), toggleFullscreen: vi.fn(), stepFrame: vi.fn(),
    }
  },
}))

vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => ({
    playheadTime: 0, setPlayheadTime: vi.fn(), timeFormat: 'timecode',
    setTimeFormat: vi.fn(), isDrawingMode: false, setDrawingMode: vi.fn(),
    currentVersion: null, focusedCommentId: null, setFocusedCommentId: vi.fn(),
  }),
}))

vi.mock('../review-provider', () => ({
  useReview: () => ({
    asset: null, versions: [], comments: [], isLoading: false,
    registerPauseHandler: vi.fn(),
  }),
}))

vi.mock('../progress-bar', () => ({ ProgressBar: () => null }))
vi.mock('../lut-canvas', () => ({ LutCanvas: () => null }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(() => new Promise(() => {})) } }))

import { VideoPlayer } from '../video-player'

beforeEach(() => {
  seenUrls.length = 0
})

describe('initialStreamUrl (the share path)', () => {
  it('is resolved exactly once before it becomes the request', () => {
    render(<VideoPlayer assetId="a1" initialStreamUrl="/stream/hls/master.m3u8?token=abc" />)
    expect(seenUrls).toContain('/api/stream/hls/master.m3u8?token=abc')
    expect(seenUrls.some((u) => u?.includes('/api/api'))).toBe(false)
  })

  it('does not get a prefix bolted onto an absolute url', () => {
    render(<VideoPlayer assetId="a1" initialStreamUrl="https://cdn.example/m.m3u8" />)
    expect(seenUrls).toContain('https://cdn.example/m.m3u8')
  })

  it('is not passed through unresolved', () => {
    render(<VideoPlayer assetId="a1" initialStreamUrl="/stream/hls/master.m3u8?token=abc" />)
    // The raw value reaching the player would mean no prefix at all, and a
    // request to the Next origin rather than the API.
    expect(seenUrls.filter((u) => u === '/stream/hls/master.m3u8?token=abc')).toHaveLength(0)
  })
})
