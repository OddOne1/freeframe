import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { stubGeometry, restoreGeometry } from '@/test/geometry'
import { fireEvent, render, screen, renderHook, act } from '@testing-library/react'
import { WipeViewer } from '../wipe-viewer'
import { useSharedTransform } from '../use-shared-transform'

/**
 * jsdom does no layout, so an <img> reports 0 for every geometry property.
 * Describe a laid-out image on the prototypes; ImageFrameConstraint's own
 * effect then reads it for real.
 */

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  restoreGeometry()
})

function renderWipe() {
  const { result } = renderHook(() => useSharedTransform())
  render(
    <WipeViewer urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3" transform={result.current} />,
  )
  return result
}

describe('WipeViewer', () => {
  it('renders both images, badges, and starts split at 50%', () => {
    renderWipe()
    expect(screen.getByAltText('v1')).toHaveAttribute('src', '/a.webp')
    expect(screen.getByAltText('v3')).toHaveAttribute('src', '/b.webp')
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    expect(screen.getByTestId('wipe-divider')).toHaveAttribute('data-split', '50')
  })

  it('divider drag updates the split percentage from pointer position', () => {
    renderWipe()
    const stage = screen.getByTestId('wipe-stage')
    stage.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    const divider = screen.getByTestId('wipe-divider')
    fireEvent.pointerDown(divider, { clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 250 })
    fireEvent.pointerUp(window)
    expect(divider).toHaveAttribute('data-split', '25')
  })

  it('renders the overlay prop inside the stage, unclipped (outside the clipPath layer)', () => {
    const { result } = renderHook(() => useSharedTransform())
    render(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="wipe-overlay" />}
      />,
    )
    const overlay = screen.getByTestId('wipe-overlay')
    expect(screen.getByTestId('wipe-stage')).toContainElement(overlay)
    // Unclipped: no ancestor between the overlay and the stage carries a clipPath.
    let node = overlay.parentElement
    while (node && node !== screen.getByTestId('wipe-stage')) {
      expect(node.style.clipPath).toBe('')
      node = node.parentElement
    }
  })

  it('positions the overlay over the picture, not the letterboxed stage (#185)', () => {
    // Drawings are authored in image-frame space (ImageFrameConstraint in the
    // single viewer and the side-by-side panes). Wipe display has to use the
    // SAME space or every annotation shown here is offset by the letterbox.
    stubGeometry({
      naturalWidth: 1200, naturalHeight: 400,
      offsetWidth: 900, offsetHeight: 300, offsetLeft: 0, offsetTop: 100,
    })
    const { result } = renderHook(() => useSharedTransform())
    render(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="wipe-overlay" />}
        overlaySide="b"
      />,
    )
    expect(screen.getByTestId('wipe-overlay').parentElement).toHaveStyle({
      position: 'absolute',
      left: '0px',
      top: '100px',
      width: '900px',
      height: '300px',
    })
  })

  it('measures the overlay against the version that owns it', () => {
    // Two versions of an asset can differ in aspect ratio, so the constraint
    // has to follow overlaySide rather than always measuring the same image.
    // Baseline geometry (both images): 3:1 letterboxed into a 900x500 stage.
    stubGeometry({
      naturalWidth: 1200, naturalHeight: 400,
      offsetWidth: 900, offsetHeight: 300, offsetLeft: 0, offsetTop: 100,
    })
    const { result } = renderHook(() => useSharedTransform())
    const wipe = (side: 'a' | 'b') => (
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="wipe-overlay" />}
        overlaySide={side}
      />
    )
    const { rerender } = render(wipe('a'))
    expect(screen.getByTestId('wipe-overlay').parentElement)
      .toHaveStyle({ top: '100px', height: '300px' })

    // Give side B a taller shape than side A — only a constraint bound to B's
    // <img> can report it.
    for (const [key, value] of Object.entries({
      naturalWidth: 900, naturalHeight: 600, offsetWidth: 900, offsetHeight: 600, offsetTop: 0,
    })) {
      Object.defineProperty(screen.getByAltText('v3'), key, { value, configurable: true })
    }
    rerender(wipe('b'))

    expect(screen.getByTestId('wipe-overlay').parentElement)
      .toHaveStyle({ top: '0px', height: '600px' })
  })

  it('clips the overlay to the owning version’s half (A left of the divider, B right)', () => {
    const { result } = renderHook(() => useSharedTransform())
    const { rerender } = render(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="ov" />}
        overlaySide="a"
      />,
    )
    // Side A is visible LEFT of the divider (split defaults to 50%).
    expect(screen.getByTestId('wipe-overlay-clip').style.clipPath).toBe('inset(0 50% 0 0)')

    rerender(
      <WipeViewer
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={result.current}
        overlay={<div data-testid="ov" />}
        overlaySide="b"
      />,
    )
    // Side B is visible RIGHT of the divider — same clip as the B image layer.
    expect(screen.getByTestId('wipe-overlay-clip').style.clipPath).toBe('inset(0 0 0 50%)')
  })
})

describe('useSharedTransform', () => {
  it('wheel steps through the fixed zoom list, and reset means Fit', () => {
    // CHANGED DELIBERATELY, not broken. Zoom was continuous 1.2x steps
    // clamped [1, 8] with no visible control; it now steps through the same
    // fixed list the new control offers, so the readout can never show a
    // percentage the control cannot return to.
    const wheel = (deltaY: number) => ({ deltaY, preventDefault() {} }) as unknown as WheelEvent
    const { result } = renderHook(() => useSharedTransform())

    // A percentage cannot become a scale until the media is measured: "100%"
    // means one media pixel per screen pixel, which depends on how far
    // object-contain already shrank it. Until then the wheel is inert.
    act(() => result.current.onWheel(wheel(-100)))
    expect(result.current.canZoom).toBe(false)
    expect(result.current.scale).toBe(1)

    // 1000px of media contained into a 500px pane is drawn at half size, so
    // 100% is a scale of 2.
    act(() => result.current.setMediaMetrics({
      intrinsicWidth: 1000, intrinsicHeight: 500, boxWidth: 500, boxHeight: 500,
    }))
    expect(result.current.canZoom).toBe(true)

    act(() => result.current.setZoom(1))
    expect(result.current.scale).toBeCloseTo(2)
    expect(result.current.isFit).toBe(false)

    act(() => result.current.onWheel(wheel(-100)))
    expect(result.current.zoomPct).toBe(1.33)

    // Fit is not a percentage. object-contain has already fitted the media,
    // so fit IS scale 1 whatever the media's own size — which is also why
    // reset and fit are the same thing.
    act(() => result.current.reset())
    expect(result.current.isFit).toBe(true)
    expect(result.current.scale).toBe(1)
    expect(result.current.tx).toBe(0)
  })
})

describe('setMediaMetrics is idempotent by value', () => {
  it('does not produce new state for equal measurements', () => {
    // Callers measure on every ResizeObserver tick and pass a fresh object.
    // An identity-based setter re-renders on every tick even when nothing
    // moved — and if the caller's effect also re-runs each render (a ref
    // whose identity is not stable, which is what a mocked player hook
    // produces), that is an unbounded loop. It was: this OOM'd the worker.
    const { result } = renderHook(() => useSharedTransform())
    const m = { intrinsicWidth: 1000, intrinsicHeight: 500, boxWidth: 500, boxHeight: 500 }

    act(() => result.current.setMediaMetrics({ ...m }))
    act(() => result.current.setZoom(1))
    const scaleAfterFirst = result.current.scale

    // A DIFFERENT object with identical values must change nothing.
    act(() => result.current.setMediaMetrics({ ...m }))
    expect(result.current.scale).toBe(scaleAfterFirst)

    // A genuine resize must still take effect: the same media in half the
    // pane is drawn half as large, so 100% needs twice the scale.
    act(() => result.current.setMediaMetrics({ ...m, boxWidth: 250, boxHeight: 250 }))
    expect(result.current.scale).toBeCloseTo(scaleAfterFirst * 2)
  })
})
