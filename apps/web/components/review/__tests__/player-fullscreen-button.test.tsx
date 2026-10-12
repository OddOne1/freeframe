/**
 * The fullscreen button, where there is a fullscreen to enter (§228c item 5).
 *
 * Two things the hook's own tests cannot say, because they are the
 * component's half of the fix:
 *
 *  1. On a browser with NO fullscreen API the button is not drawn at all.
 *     The owner pressed a button that could not work; a missing button is
 *     worse-looking and better.
 *  2. On the iPhone's path — iOS takes the `<video>` into its own player —
 *     the graded preview is a WebGL canvas drawn OVER that video, so the
 *     grade is simply not in what the system player shows. If a LUT is
 *     active the viewer is told, rather than being handed an ungraded
 *     picture without comment. And `fixed inset-0 z-50`, which pins THIS
 *     container over the page, must not be applied on that path: nothing
 *     about this element went fullscreen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import type { FullscreenMode } from '@/hooks/use-video-player'

let mode: FullscreenMode = 'element'
let isFullscreen = false
const toggleFullscreen = vi.fn<(el: HTMLElement) => FullscreenMode>(() => mode)

vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => ({
    videoRef: { current: null },
    hlsRef: { current: null },
    isPlaying: false, currentTime: 0, duration: 120, buffered: 0,
    volume: 1, isMuted: false, playbackRate: 1,
    qualityLevels: [], currentQuality: -1,
    isLoading: false, isFullscreen, fullscreenMode: mode, error: null,
    play: vi.fn(), pause: vi.fn(), togglePlay: vi.fn(), seek: vi.fn(),
    setPlaybackRate: vi.fn(), setQuality: vi.fn(), setVolume: vi.fn(),
    toggleMute: vi.fn(), toggleFullscreen, stepFrame: vi.fn(),
  }),
}))
vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => ({
    playheadTime: 0, setPlayheadTime: vi.fn(), timeFormat: 'timecode',
    setTimeFormat: vi.fn(), isDrawingMode: false, setDrawingMode: vi.fn(),
    currentVersion: { id: 'v1' }, focusedCommentId: null,
    setFocusedCommentId: vi.fn(),
  }),
}))
vi.mock('../review-provider', () => ({
  useReview: () => ({
    asset: { thumbnail_url: null },
    versions: [], comments: [], isLoading: false,
    registerPauseHandler: vi.fn(),
  }),
}))
vi.mock('../progress-bar', () => ({ ProgressBar: () => null }))
vi.mock('../lut-canvas', () => ({ LutCanvas: () => null }))
vi.mock('@/lib/api', () => ({ api: { get: vi.fn(() => new Promise(() => {})) } }))

import { VideoPlayer } from '../video-player'
import { ToastProvider } from '@/components/shared/toast'

/** A LUT the player would be drawing over the video. */
const CUBE = { size: 2, data: new Float32Array(2 * 2 * 2 * 3) } as never

beforeEach(() => {
  mode = 'element'
  isFullscreen = false
  toggleFullscreen.mockClear()
})

describe('§228c item 5 — the button exists only where it can work', () => {
  it('is drawn on the compact phone row when an API exists', () => {
    render(<VideoPlayer assetId="a1" compactControls />)
    expect(screen.getByTestId('player-fullscreen')).toBeInTheDocument()
  })

  it('is NOT drawn on the compact row when no API exists', () => {
    mode = 'none'
    render(<VideoPlayer assetId="a1" compactControls />)
    expect(screen.queryByTestId('player-fullscreen')).toBeNull()
  })

  it('is drawn on the wide row when an API exists', () => {
    render(<VideoPlayer assetId="a1" />)
    expect(screen.getByTestId('player-fullscreen-wide')).toBeInTheDocument()
  })

  it('is NOT drawn on the wide row when no API exists', () => {
    mode = 'none'
    render(<VideoPlayer assetId="a1" />)
    expect(screen.queryByTestId('player-fullscreen-wide')).toBeNull()
  })

  it('and pressing it hands the hook the CONTAINER element', () => {
    const { container } = render(<VideoPlayer assetId="a1" compactControls />)
    fireEvent.click(screen.getByTestId('player-fullscreen'))
    expect(toggleFullscreen).toHaveBeenCalledTimes(1)
    const passed = toggleFullscreen.mock.calls[0][0]
    expect(passed).toBe(container.firstElementChild)
  })
})

describe("§228c item 5 — the LUT and the iPhone's own player", () => {
  it('says the grade will not be visible, on the native path', () => {
    mode = 'video-native'
    render(
      <ToastProvider>
        <VideoPlayer assetId="a1" compactControls cube={CUBE} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('player-fullscreen'))
    expect(
      screen.getByText('LUT not shown in iPhone fullscreen'),
    ).toBeInTheDocument()
  })

  it('says nothing when no LUT is active — there is nothing to lose', () => {
    mode = 'video-native'
    render(
      <ToastProvider>
        <VideoPlayer assetId="a1" compactControls />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('player-fullscreen'))
    expect(screen.queryByText('LUT not shown in iPhone fullscreen')).toBeNull()
  })

  it('and says nothing on the element path, where the LUT IS shown', () => {
    mode = 'element'
    render(
      <ToastProvider>
        <VideoPlayer assetId="a1" compactControls cube={CUBE} />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByTestId('player-fullscreen'))
    expect(screen.queryByText('LUT not shown in iPhone fullscreen')).toBeNull()
  })

  it('renders without a ToastProvider at all — the share page has none', () => {
    mode = 'video-native'
    expect(() => {
      render(<VideoPlayer assetId="a1" compactControls cube={CUBE} />)
      fireEvent.click(screen.getByTestId('player-fullscreen'))
    }).not.toThrow()
  })
})

describe('§228c item 5 — `fixed inset-0 z-50` follows the real fullscreen', () => {
  it('is applied while an ELEMENT is fullscreen', () => {
    mode = 'element'
    isFullscreen = true
    const { container } = render(<VideoPlayer assetId="a1" />)
    expect(container.firstElementChild?.className).toContain('fixed inset-0 z-50')
  })

  it('is NOT applied while the iPhone shows its own player', () => {
    mode = 'video-native'
    isFullscreen = true
    const { container } = render(<VideoPlayer assetId="a1" compactControls />)
    // This element did not go fullscreen — the video did, inside a player
    // iOS draws on top of the page. Pinning this over the whole viewport
    // leaves it covering the viewer once that player closes.
    expect(container.firstElementChild?.className).not.toContain('fixed inset-0')
  })
})
