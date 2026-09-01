/**
 * Video wipe mode, the centred mode toggle, and the right-pane dropdown anchor.
 *
 * The visual result — a clean moving boundary over two playing videos — is not
 * assertable in jsdom, which does no layout and decodes no media. What IS
 * assertable, and is the whole risk of this change, is that wipe reuses the
 * transport's OWN video elements rather than creating a second pair, that it
 * does not become video's default, and that the shared clip chrome behaves the
 * same for video as for images.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

const replace = vi.fn()
let searchParamsString = 'compare=v-1&compareRight=v-3'
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams(searchParamsString),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [], createComment: vi.fn(), resolveComment: vi.fn(), deleteComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-stream-url', () => ({ useStreamUrl: () => ({ url: '/s.m3u8', error: false }) }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))

// The real transport, but with refs we can identify — the claim under test is
// that wipe attaches THESE, not a fresh pair of its own.
const refA = { current: null as HTMLVideoElement | null }
const refB = { current: null as HTMLVideoElement | null }
vi.mock('@/hooks/use-video-player', () => ({
  useVideoPlayer: () => {
    const seen = (globalThis as { __n?: number }).__n ?? 0
    ;(globalThis as { __n?: number }).__n = seen + 1
    return { videoRef: seen % 2 === 0 ? refA : refB }
  },
}))

import { CompareOverlay } from '../compare-overlay'

const videoAsset = { id: 'a1', project_id: 'p1', asset_type: 'video', name: 'clip' } as never
const imageAsset = { id: 'a1', project_id: 'p1', asset_type: 'image', name: 'still' } as never
const version = (n: number) => ({
  id: `v-${n}`, asset_id: 'a1', version_number: n, processing_status: 'ready',
  created_at: new Date().toISOString(), files: [{ fps: 25, duration_seconds: 60 }],
}) as never

function renderOverlay(asset: unknown) {
  return render(
    <CompareOverlay
      asset={asset as never}
      versions={[version(1), version(3)]}
      rightVersion={version(3)}
      onClose={vi.fn()}
    />,
  )
}

beforeEach(() => {
  replace.mockClear()
  ;(globalThis as { __n?: number }).__n = 0
  refA.current = null
  refB.current = null
  searchParamsString = 'compare=v-1&compareRight=v-3'
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
})

describe('video wipe mode', () => {
  it('video still opens side-by-side by default', () => {
    // `mode` defaults to wipe for images. Honouring the same param for video
    // without a media-aware default would silently change what every existing
    // compare link and every plain Compare click shows.
    renderOverlay(videoAsset)
    expect(screen.queryByTestId('wipe-stage')).toBeNull()
  })

  it('mode=wipe renders the wipe stage for video', () => {
    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    renderOverlay(videoAsset)
    expect(screen.getByTestId('wipe-stage')).toBeInTheDocument()
    expect(screen.getByTestId('wipe-divider')).toBeInTheDocument()
  })

  it('uses the TRANSPORT’s own video elements, not a second pair', () => {
    // The load-bearing claim of the whole change: rendering-only. A fresh pair
    // of <video>s would look identical on screen and be driven by nothing.
    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    renderOverlay(videoAsset)
    expect(refA.current).toBe(screen.getByTestId('wipe-video-a'))
    expect(refB.current).toBe(screen.getByTestId('wipe-video-b'))
  })

  it('clips side B from the divider, exactly as the image stage does', () => {
    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    renderOverlay(videoAsset)
    const bLayer = screen.getByTestId('wipe-video-b').closest('[style*="clip-path"]') as HTMLElement
    expect(bLayer).toBeTruthy()
    expect(bLayer.style.clipPath).toBe('inset(0 0 0 50%)')
  })

  it('keeps exclusive unmute working in wipe', () => {
    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    renderOverlay(videoAsset)
    // Default audible side is B (matching side-by-side).
    expect(screen.getByTestId('wipe-video-b')).not.toHaveAttribute('muted')
    fireEvent.click(screen.getByLabelText('Unmute v1'))
    expect((screen.getByTestId('wipe-video-a') as HTMLVideoElement).muted).toBe(false)
    expect((screen.getByTestId('wipe-video-b') as HTMLVideoElement).muted).toBe(true)
  })
})

describe('mode toggle', () => {
  it('is offered for video, which it was not before', () => {
    renderOverlay(videoAsset)
    expect(screen.getByTestId('compare-mode-toggle')).toBeInTheDocument()
  })

  it('is still offered for images', () => {
    renderOverlay(imageAsset)
    expect(screen.getByTestId('compare-mode-toggle')).toBeInTheDocument()
  })

  it('sits in the centre track, between the two version pills', () => {
    // Centred on the STAGE, not on the space the pills leave — otherwise it
    // drifts as labels change width ("v2" vs "v10").
    renderOverlay(videoAsset)
    const toggle = screen.getByTestId('compare-mode-toggle')
    const bar = toggle.parentElement!.parentElement!
    expect(bar.className).toContain('grid-cols-[1fr_auto_1fr]')
    const tracks = Array.from(bar.children)
    expect(tracks[1]).toContainElement(toggle)
    expect(tracks[0]).toContainElement(screen.getByTestId('compare-select-a'))
    expect(tracks[2]).toContainElement(screen.getByTestId('compare-select-b'))
  })

  it('writes the mode to the URL for video too', () => {
    renderOverlay(videoAsset)
    fireEvent.click(screen.getByTestId('compare-mode-toggle'))
    expect(String(replace.mock.calls.at(-1)?.[0])).toContain('mode=wipe')
  })
})

describe('version dropdown anchoring', () => {
  it('anchors the right pane menu to its right edge, the left pane to its left', () => {
    // The right pill sits in the top-right corner: a left-anchored menu grows
    // off-screen from there.
    renderOverlay(videoAsset)
    fireEvent.click(within(screen.getByTestId('compare-select-b')).getByRole('button'))
    expect(screen.getByRole('listbox').className).toContain('right-0')

    fireEvent.click(within(screen.getByTestId('compare-select-a')).getByRole('button'))
    const menus = screen.getAllByRole('listbox')
    expect(menus.some((m) => m.className.includes('left-0'))).toBe(true)
  })
})

/**
 * The control-row and containment regressions from adba966 (§112).
 *
 * All three had the same shape: controls that live INSIDE the zoomable stage
 * are reachable by the content they are meant to control.
 */
describe('control row and zoom containment', () => {
  it('puts all three controls in ONE row, outside the stage', () => {
    renderOverlay(videoAsset)
    const row = screen.getByTestId('compare-control-row')
    expect(row).toContainElement(screen.getByLabelText('Toggle left comments'))
    expect(row).toContainElement(screen.getByLabelText('Toggle right comments'))
    expect(row).toContainElement(screen.getByTestId('compare-zoom'))
    // The point of the fix: a zoomed video cannot paint over what is not
    // inside the stage it is painted in.
    expect(screen.getByTestId('sbs-stage').contains(row)).toBe(false)
  })

  it('keeps each toggle on its own side of the row', () => {
    // They had both drifted to the left (`left-4` and `left-16`), the right
    // one still claiming to be the right one only in its aria-label.
    renderOverlay(videoAsset)
    const row = screen.getByTestId('compare-control-row')
    const tracks = Array.from(row.children)
    expect(tracks[0]).toContainElement(screen.getByLabelText('Toggle left comments'))
    expect(tracks[2]).toContainElement(screen.getByLabelText('Toggle right comments'))
  })

  it('centres zoom on the stage, not between the toggles', () => {
    // Three equal tracks, so the divider's position and the toggles' widths
    // cannot shift it.
    renderOverlay(videoAsset)
    const row = screen.getByTestId('compare-control-row')
    expect(row.className).toContain('grid-cols-[1fr_auto_1fr]')
    expect(Array.from(row.children)[1]).toContainElement(screen.getByTestId('compare-zoom'))
  })

  it('the zoom control is in normal flow, not floating over the video', () => {
    renderOverlay(videoAsset)
    const zoom = screen.getByTestId('compare-zoom')
    expect(zoom.className).not.toContain('absolute')
    expect(zoom.className).not.toContain('bottom-4')
  })

  it('clips a zoomed pane to its own box in side-by-side', () => {
    // Without this a zoomed-in left pane paints into the right one, which is
    // not a comparison. Wipe needs none — clip-path already contains it.
    renderOverlay(videoAsset)
    const pane = screen.getByTestId('wipe-video-a').parentElement!.parentElement as HTMLElement
    expect(pane.className).toContain('overflow-hidden')
  })

  it('leaves wipe’s clip-path containment alone', () => {
    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    renderOverlay(videoAsset)
    const pane = screen.getByTestId('wipe-video-a').parentElement!.parentElement as HTMLElement
    expect(pane.style.clipPath).toBe('inset(0 50% 0 0)')
  })

  it('reads 100% as Fit, and the percentage survives a mode switch unchanged', () => {
    // The user-visible contract: the number means the same relative thing in
    // both modes, so switching modes at a given percentage neither overflows
    // nor shrinks.
    const { rerender } = render(
      <CompareOverlay asset={videoAsset as never} versions={[version(1), version(3)]}
        rightVersion={version(3)} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('compare-zoom-label').textContent).toContain('Fit')
    fireEvent.click(screen.getByLabelText('Zoom in'))
    const zoomed = screen.getByTestId('compare-zoom-label').textContent

    searchParamsString = 'compare=v-1&compareRight=v-3&mode=wipe'
    rerender(
      <CompareOverlay asset={videoAsset as never} versions={[version(1), version(3)]}
        rightVersion={version(3)} onClose={vi.fn()} />,
    )
    expect(screen.getByTestId('compare-zoom-label').textContent).toBe(zoomed)
  })
})
