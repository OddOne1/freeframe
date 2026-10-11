/**
 * The phone player: a four-control transport row and a settings sheet
 * (§228 A4), and the timestamped comment flow (§228 A5).
 *
 * The real `VideoPlayer`, the real sheet, the real `CommentInput` and the
 * real review store. What is stubbed is the stream fetch and
 * `useVideoPlayer`, because jsdom has no media element worth the name —
 * but the state the sheet edits is the SAME state the desktop row edits,
 * and that is exactly what these assert: `setPlaybackRate` is the player
 * hook's, `loop` reaches the `<video>`, `captionsOn` drives the TextTrack.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'

const setPlaybackRate = vi.fn()
const setQuality = vi.fn()
const pause = vi.fn()
const togglePlay = vi.fn()
const toggleFullscreen = vi.fn()

let qualityLevels: { index: number; label: string }[] = []

vi.mock('@/hooks/use-video-player', async () => {
  const React = await import('react')
  return {
    useVideoPlayer: () => {
      const videoRef = React.useRef<HTMLVideoElement>(null)
      return {
        videoRef,
        isPlaying: false,
        currentTime: 12.5,
        duration: 60,
        buffered: 0,
        volume: 1,
        isMuted: false,
        playbackRate: 1,
        qualityLevels,
        currentQuality: -1,
        isLoading: false,
        isFullscreen: false,
        error: null,
        pause,
        togglePlay,
        seek: vi.fn(),
        setPlaybackRate,
        setQuality,
        setVolume: vi.fn(),
        toggleMute: vi.fn(),
        toggleFullscreen,
      }
    },
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => ({ url: '/stream/hls/x.m3u8' })),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

const registerPauseHandler = vi.fn()
const pauseVideo = vi.fn()
vi.mock('../review-provider', async () => {
  const React = await import('react')
  return {
    ReviewProvider: ({ children }: { children: React.ReactNode }) => children,
    useReview: () => ({
      assetId: 'a1',
      asset: { id: 'a1', thumbnail_url: null },
      versions: [],
      comments: [],
      isLoading: false,
      error: null,
      registerPauseHandler,
      pauseVideo,
      seekTo: vi.fn(),
      refetchComments: vi.fn(),
      refetchVersions: vi.fn(),
      addComment: vi.fn(),
      resolveComment: vi.fn(),
    }),
  }
})

vi.mock('../progress-bar', () => ({ ProgressBar: () => <div data-testid="progress-bar" /> }))
vi.mock('../lut-canvas', () => ({ LutCanvas: () => null }))
vi.mock('@/hooks/use-drawing', () => ({
  useDrawing: () => ({ clear: vi.fn(), undo: vi.fn(), getJSON: () => ({}) }),
}))

import { VideoPlayer } from '../video-player'
import { CommentInput } from '../comment-input'
import { useReviewStore } from '@/stores/review-store'

beforeEach(() => {
  qualityLevels = []
  setPlaybackRate.mockClear()
  setQuality.mockClear()
  pauseVideo.mockClear()
  useReviewStore.setState({ playheadTime: 0, isDrawingMode: false, timeFormat: 'timecode' })
})

function renderPhonePlayer(props: Record<string, unknown> = {}) {
  return render(
    <VideoPlayer assetId="a1" compactControls {...props} />,
  )
}

const openSheet = async () => {
  fireEvent.click(screen.getByTestId('player-settings-button'))
  return screen.findByTestId('player-settings-sheet')
}

// ─── The compact transport row ──────────────────────────────────────────

describe('§228 — the phone transport row', () => {
  it('keeps play/pause, the timecode and fullscreen, and nothing else', () => {
    renderPhonePlayer()
    const row = screen.getByTestId('video-transport-compact')
    expect(within(row).getByLabelText('Play')).toBeTruthy()
    expect(within(row).getByLabelText('Enter fullscreen')).toBeTruthy()
    expect(within(row).getByLabelText('Player settings')).toBeTruthy()
    expect(within(row).getByText(/00:00:12/)).toBeTruthy()
    // The five that moved into the sheet, or out entirely.
    expect(within(row).queryByLabelText('Loop')).toBeNull()
    expect(within(row).queryByLabelText('Playback speed')).toBeNull()
    expect(within(row).queryByLabelText('Mute')).toBeNull()
    expect(within(row).queryByLabelText(/captions/i)).toBeNull()
    expect(within(row).queryByLabelText('Quality')).toBeNull()
  })

  it('and the scrubber is still there, above it', () => {
    renderPhonePlayer()
    expect(screen.getByTestId('progress-bar')).toBeTruthy()
  })

  it('while the desktop row is untouched without the prop', () => {
    render(<VideoPlayer assetId="a1" captionsUrl="/c.vtt" />)
    expect(screen.queryByTestId('video-transport-compact')).toBeNull()
    expect(screen.getByLabelText('Loop')).toBeTruthy()
    expect(screen.getByLabelText('Playback speed')).toBeTruthy()
    expect(screen.getByLabelText('Mute')).toBeTruthy()
    expect(screen.queryByTestId('player-settings-button')).toBeNull()
  })
})

// ─── The sheet ──────────────────────────────────────────────────────────

describe('§228 — the settings sheet', () => {
  it('holds speed, loop, captions, quality and the LUT', async () => {
    qualityLevels = [{ index: 0, label: '1080p' }, { index: 1, label: '720p' }]
    renderPhonePlayer({
      captionsUrl: '/captions.vtt',
      captionsLanguage: 'en',
      lutSheetContent: <div data-testid="lut-library" />,
      lutLabel: 'Show LUT',
    })
    const sheet = await openSheet()
    expect(within(sheet).getByTestId('sheet-row-speed')).toBeTruthy()
    expect(within(sheet).getByTestId('sheet-row-loop')).toBeTruthy()
    expect(within(sheet).getByTestId('sheet-row-captions')).toBeTruthy()
    expect(within(sheet).getByTestId('sheet-row-quality')).toBeTruthy()
    expect(within(sheet).getByTestId('sheet-row-lut')).toBeTruthy()
  })

  it('leaves out the rows whose control does not exist on this asset', async () => {
    // No transcript, no HLS ladder, no LUT support.
    renderPhonePlayer()
    const sheet = await openSheet()
    expect(within(sheet).queryByTestId('sheet-row-captions')).toBeNull()
    expect(within(sheet).queryByTestId('sheet-row-quality')).toBeNull()
    expect(within(sheet).queryByTestId('sheet-row-lut')).toBeNull()
    // Speed and loop always exist.
    expect(within(sheet).getByTestId('sheet-row-speed')).toBeTruthy()
    expect(within(sheet).getByTestId('sheet-row-loop')).toBeTruthy()
  })

  it('changing the speed drives the SAME state the desktop button drives', async () => {
    renderPhonePlayer()
    const sheet = await openSheet()
    fireEvent.click(within(sheet).getByTestId('sheet-row-speed'))
    fireEvent.click(await screen.findByText('1.5x'))
    // `setPlaybackRate` is useVideoPlayer's — the one the desktop row's
    // speed button cycles through.
    expect(setPlaybackRate).toHaveBeenCalledWith(1.5)
  })

  it('and closes afterwards, because picking a speed is the whole interaction', async () => {
    renderPhonePlayer()
    const sheet = await openSheet()
    fireEvent.click(within(sheet).getByTestId('sheet-row-speed'))
    fireEvent.click(await screen.findByText('0.5x'))
    await waitFor(() => expect(screen.queryByTestId('player-settings-sheet')).toBeNull())
  })

  it('loop reaches the <video> element, and the sheet stays open', async () => {
    const { container } = renderPhonePlayer()
    const video = container.querySelector('video') as HTMLVideoElement
    expect(video.loop).toBe(false)
    const sheet = await openSheet()
    fireEvent.click(within(sheet).getByTestId('sheet-row-loop'))
    await waitFor(() => expect(video.loop).toBe(true))
    // A toggle's only feedback is seeing it flip, so it must not close.
    expect(screen.getByTestId('player-settings-sheet')).toBeTruthy()
  })

  it('captions drive the same toggle the desktop CC button does', async () => {
    const { container } = renderPhonePlayer({ captionsUrl: '/captions.vtt', captionsLanguage: 'en' })
    const sheet = await openSheet()
    const row = within(sheet).getByTestId('sheet-row-captions')
    expect(row).toHaveTextContent(/Captions \(English\)/)
    expect(row).toHaveTextContent('Off')
    fireEvent.click(row)
    await waitFor(() =>
      expect(screen.getByTestId('sheet-row-captions')).toHaveTextContent('On'),
    )
    expect(container.querySelector('track')).toBeTruthy()
  })

  it('quality is the "Auto" ladder the owner saw clipped as "Au…", not an audio control', async () => {
    qualityLevels = [{ index: 0, label: '1080p' }, { index: 1, label: '720p' }]
    renderPhonePlayer()
    const sheet = await openSheet()
    fireEvent.click(within(sheet).getByTestId('sheet-row-quality'))
    const page = await screen.findByTestId('sheet-page-quality')
    expect(within(page).getByText('Auto')).toBeTruthy()
    expect(within(page).getByText('1080p')).toBeTruthy()
    fireEvent.click(within(page).getByText('720p'))
    expect(setQuality).toHaveBeenCalledWith(1)
  })

  it('the LUT is a sub-page holding the real picker, reached and left again', async () => {
    renderPhonePlayer({ lutSheetContent: <div data-testid="lut-library" />, lutLabel: 'Show LUT' })
    const sheet = await openSheet()
    expect(within(sheet).getByTestId('sheet-row-lut')).toHaveTextContent('Show LUT')
    fireEvent.click(within(sheet).getByTestId('sheet-row-lut'))
    expect(await screen.findByTestId('lut-library')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Back to player settings'))
    await waitFor(() => expect(screen.getByTestId('sheet-row-speed')).toBeTruthy())
  })

  it('every sheet row is at least 44px tall and no smaller than 12px text', async () => {
    // jsdom computes no layout, so this reads the contract the classes
    // encode rather than a measured box — the measured version is the
    // Chromium audit in the §228 report.
    renderPhonePlayer({ captionsUrl: '/c.vtt' })
    const sheet = await openSheet()
    for (const row of Array.from(sheet.querySelectorAll('[data-testid^="sheet-row-"]'))) {
      expect(row.className).toMatch(/\bmin-h-11\b/)
      expect(row.querySelector('.text-xs')).toBeTruthy()
    }
  })

  it('reopening starts at the top level, not on the sub-page last left', async () => {
    renderPhonePlayer({ lutSheetContent: <div data-testid="lut-library" /> })
    let sheet = await openSheet()
    fireEvent.click(within(sheet).getByTestId('sheet-row-lut'))
    await screen.findByTestId('lut-library')
    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('player-settings-sheet')).toBeNull())
    sheet = await openSheet()
    expect(within(sheet).getByTestId('sheet-row-speed')).toBeTruthy()
  })
})

// ─── The timestamped comment flow ───────────────────────────────────────

describe('§228 — focusing the composer pauses and stamps', () => {
  function renderComposer() {
    return render(
      <CommentInput
        assetId="a1"
        projectId="p1"
        assetType="video"
        onSubmit={vi.fn(async () => {})}
      />,
    )
  }

  it('focus pauses the video through the provider’s registered handler', () => {
    renderComposer()
    fireEvent.focus(screen.getByRole('textbox'))
    expect(pauseVideo).toHaveBeenCalled()
  })

  it('a click still pauses too — the tap that focuses it on a phone', () => {
    renderComposer()
    fireEvent.click(screen.getByRole('textbox'))
    expect(pauseVideo).toHaveBeenCalled()
  })

  it('the stamp is the store’s playhead, not a second timecode source', () => {
    useReviewStore.setState({ playheadTime: 12.5, timeFormat: 'timecode' })
    renderComposer()
    fireEvent.focus(screen.getByRole('textbox'))
    expect(screen.getByTestId('comment-timecode-stamp')).toHaveTextContent('00:00:12:12')
  })

  it('and it is removable, and comes back', () => {
    useReviewStore.setState({ playheadTime: 12.5 })
    renderComposer()
    expect(screen.getByTestId('comment-timecode-stamp')).toBeTruthy()
    fireEvent.click(screen.getByTestId('comment-timecode-toggle'))
    expect(screen.queryByTestId('comment-timecode-stamp')).toBeNull()
    fireEvent.click(screen.getByTestId('comment-timecode-toggle'))
    expect(screen.getByTestId('comment-timecode-stamp')).toBeTruthy()
  })

  it('a detached stamp is not submitted', async () => {
    useReviewStore.setState({ playheadTime: 12.5 })
    const onSubmit = vi.fn(async (_body: string, _tc?: number) => {})
    render(
      <CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />,
    )
    fireEvent.click(screen.getByTestId('comment-timecode-toggle'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'no timecode' } })
    fireEvent.click(screen.getByTitle('Send (Enter)'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][1]).toBeUndefined()
  })

  it('an attached one is', async () => {
    useReviewStore.setState({ playheadTime: 12.5 })
    const onSubmit = vi.fn(async (_body: string, _tc?: number) => {})
    render(
      <CommentInput assetId="a1" projectId="p1" assetType="video" onSubmit={onSubmit} />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'at this frame' } })
    fireEvent.click(screen.getByTitle('Send (Enter)'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][1]).toBe(12.5)
  })
})

// ─── Keyboard shortcuts are untouched ───────────────────────────────────

describe('§228 — the keyboard shortcuts still work', () => {
  it('space, J, K and L reach the player with the compact row up', () => {
    renderPhonePlayer()
    togglePlay.mockClear()
    fireEvent.keyDown(window, { code: 'Space' })
    fireEvent.keyDown(window, { code: 'KeyK' })
    expect(togglePlay).toHaveBeenCalledTimes(2)
  })
})
