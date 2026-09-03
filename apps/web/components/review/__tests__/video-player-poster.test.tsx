/**
 * §118 — the player shows the asset's existing thumbnail until the first
 * frame decodes.
 *
 * Safari's native HLS path takes ~1.2s to produce a real frame (measured),
 * and showed solid black for that whole gap. The image is already generated
 * and already served in the project grid, so this costs nothing new.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

let asset: { thumbnail_url: string | null } | null = { thumbnail_url: '/stream/hls/thumb.webp?token=t' }

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null }, hlsRef: { current: null },
    isPlaying: false, currentTime: 0, duration: 0, buffered: 0,
    volume: 1, isMuted: false, playbackRate: 1,
    qualityLevels: [], currentQuality: -1,
    isLoading: false, isFullscreen: false, error: null,
    play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seek: vi.fn(),
    setPlaybackRate: vi.fn(), setQuality: vi.fn(), setVolume: vi.fn(),
    toggleMute: vi.fn(), toggleFullscreen: vi.fn(), stepFrame: vi.fn(),
  }),
}))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => ({
    playheadTime: 0, setPlayheadTime: vi.fn(), timeFormat: 'timecode',
    setTimeFormat: vi.fn(), isDrawingMode: false, setDrawingMode: vi.fn(),
    currentVersion: { id: 'v1' }, focusedCommentId: null, setFocusedCommentId: vi.fn(),
  }),
}))
vi.mock('../review-provider', () => ({
  useReview: () => ({
    asset, versions: [], comments: [], isLoading: false, registerPauseHandler: vi.fn(),
  }),
}))
vi.mock('../progress-bar', () => ({ ProgressBar: () => null }))
vi.mock('../lut-canvas', () => ({ LutCanvas: () => null }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(() => new Promise(() => {})) } }))

import { VideoPlayer } from '../video-player'

beforeEach(() => { asset = { thumbnail_url: '/stream/hls/thumb.webp?token=t' } })

const video = () => document.querySelector('video') as HTMLVideoElement

describe('poster', () => {
  it('uses the asset thumbnail, API-prefixed exactly once', () => {
    render(<VideoPlayer assetId="a1" />)
    expect(video().getAttribute('poster')).toBe('/api/stream/hls/thumb.webp?token=t')
  })

  it('does not double-prefix an already absolute url', () => {
    asset = { thumbnail_url: 'https://cdn.example/t.webp' }
    render(<VideoPlayer assetId="a1" />)
    expect(video().getAttribute('poster')).toBe('https://cdn.example/t.webp')
  })

  it('sets no poster when the asset has no thumbnail', () => {
    asset = { thumbnail_url: null }
    render(<VideoPlayer assetId="a1" />)
    expect(video().hasAttribute('poster')).toBe(false)
  })

  it('sets no poster when the asset has not loaded yet', () => {
    asset = null
    render(<VideoPlayer assetId="a1" />)
    expect(video().hasAttribute('poster')).toBe(false)
  })
})
