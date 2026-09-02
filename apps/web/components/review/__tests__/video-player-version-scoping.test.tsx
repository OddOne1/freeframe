/**
 * §117 bug A — the normal player must ask for the version it is actually
 * showing.
 *
 * GET /assets/{id}/stream with no version_id falls back server-side to the
 * highest version_number with NO ready-status filter, and 409s when that one
 * is still processing. The review provider meanwhile selects the newest READY
 * version. The two disagree exactly while a new version is uploading, and the
 * 409 surfaced as a permanently blank player: the empty catch left streamUrl
 * null, so useVideoPlayer(null) had no src to fail on and reported nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

const requested: string[] = []
let currentVersion: { id: string } | null = { id: 'v-ready' }
let reviewLoading = false
let getImpl: (url: string) => Promise<unknown> = async () => ({ url: '/stream/hls/master.m3u8?token=t' })

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
    currentVersion, focusedCommentId: null, setFocusedCommentId: vi.fn(),
  }),
}))

vi.mock('../review-provider', () => ({
  useReview: () => ({
    asset: null, versions: [], comments: [], isLoading: reviewLoading,
    registerPauseHandler: vi.fn(),
  }),
}))

vi.mock('../progress-bar', () => ({ ProgressBar: () => null }))
vi.mock('../lut-canvas', () => ({ LutCanvas: () => null }))
vi.mock('@/lib/api', () => ({
  api: { get: (url: string) => { requested.push(url); return getImpl(url) } },
}))

import { VideoPlayer } from '../video-player'

beforeEach(() => {
  requested.length = 0
  currentVersion = { id: 'v-ready' }
  reviewLoading = false
  getImpl = async () => ({ url: '/stream/hls/master.m3u8?token=t' })
})

describe('stream fetch is version-scoped', () => {
  it('asks for the version the provider selected', async () => {
    render(<VideoPlayer assetId="a1" />)
    await waitFor(() => expect(requested.length).toBeGreaterThan(0))
    expect(requested[0]).toBe('/assets/a1/stream?version_id=v-ready')
  })

  it('never asks without a version — that request is the one that 409s', async () => {
    render(<VideoPlayer assetId="a1" />)
    await waitFor(() => expect(requested.length).toBeGreaterThan(0))
    expect(requested.some((u) => !u.includes('version_id='))).toBe(false)
  })

  it('refetches when the selected version changes', async () => {
    const { rerender } = render(<VideoPlayer assetId="a1" />)
    await waitFor(() => expect(requested).toHaveLength(1))
    currentVersion = { id: 'v-other' }
    // NO key change here: adding one remounts the component, and a remount
    // re-runs the effect whatever its deps say — which is how the first
    // version of this test passed against deps that had dropped versionId.
    rerender(<VideoPlayer assetId="a1" />)
    await waitFor(() => expect(requested).toHaveLength(2))
    expect(requested[1]).toBe('/assets/a1/stream?version_id=v-other')
  })

  it('holds off entirely while the provider is still resolving a version', async () => {
    currentVersion = null
    reviewLoading = true
    render(<VideoPlayer assetId="a1" />)
    await new Promise((r) => setTimeout(r, 20))
    expect(requested).toHaveLength(0)
  })
})

describe('a failed stream fetch is visible, not silent', () => {
  it('shows a message when the request rejects', async () => {
    getImpl = async () => { throw Object.assign(new Error('nope'), { status: 500 }) }
    render(<VideoPlayer assetId="a1" />)
    expect(await screen.findByText('Could not load this video.')).toBeInTheDocument()
  })

  it('names a 409 as still-processing rather than a generic failure', async () => {
    getImpl = async () => { throw Object.assign(new Error('409'), { status: 409 }) }
    render(<VideoPlayer assetId="a1" />)
    expect(await screen.findByText('This version is still processing.')).toBeInTheDocument()
  })

  it('says so when the provider finished and produced no version at all', async () => {
    currentVersion = null
    reviewLoading = false
    render(<VideoPlayer assetId="a1" />)
    expect(await screen.findByText('No playable version of this asset.')).toBeInTheDocument()
  })
})
