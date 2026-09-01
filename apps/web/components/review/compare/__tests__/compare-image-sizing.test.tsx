import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import * as React from 'react'
import { CompareImageStage } from '../compare-image-stage'
import { CompareVideoStage } from '../compare-video-stage'
import { WipeViewer } from '../wipe-viewer'
import { COMPARE_MEDIA_CLASS, comparePaneClass } from '../compare-pane'
import { useSharedTransform } from '../use-shared-transform'

/**
 * §116 — the image side-by-side branch sized its media differently from the
 * video branch, and had done since the video branch was fixed.
 *
 * Measured in a real browser before the fix, a 480x270 source in a 700x568
 * pane: the <img> laid out at 480x270 (its intrinsic size, centred with wide
 * empty bands) while the <video> filled the pane at 700x568. `max-*` only
 * scales DOWN, so media smaller than its pane never fills it -- and since
 * useSharedTransform defines 100% as "fitted to the pane" and multiplies from
 * there, every zoom step on such an image was a multiple of the wrong number.
 *
 * jsdom does no layout, so these assert the CSS that produced that geometry
 * rather than the geometry itself. The browser measurement is in the commit
 * message; what these protect is the rule.
 */

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

function makeTransform() {
  const { result } = renderHook(() => useSharedTransform())
  return result.current
}

describe('compare media sizing', () => {
  it('never uses max-* sizing, which cannot scale media up to its pane', () => {
    expect(COMPARE_MEDIA_CLASS).not.toContain('max-')
    expect(COMPARE_MEDIA_CLASS).toContain('h-full')
    expect(COMPARE_MEDIA_CLASS).toContain('w-full')
    expect(COMPARE_MEDIA_CLASS).toContain('object-contain')
  })

  it('image side-by-side fills its pane, exactly as video does', () => {
    const tf = makeTransform()
    const imgARef = React.createRef<HTMLImageElement>()
    const imgBRef = React.createRef<HTMLImageElement>()
    render(
      <CompareImageStage
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={tf} imgARef={imgARef} imgBRef={imgBRef}
      />,
    )
    for (const alt of ['v1', 'v3']) {
      expect(screen.getByAltText(alt).className).toBe(COMPARE_MEDIA_CLASS)
    }
  })

  it('image wipe fills its stage too — the same one-line bug lived there', () => {
    const tf = makeTransform()
    render(<WipeViewer urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3" transform={tf} />)
    for (const alt of ['v1', 'v3']) {
      expect(screen.getByAltText(alt).className).toBe(COMPARE_MEDIA_CLASS)
    }
  })

  it('the video stage draws its sizing from the same shared constant', () => {
    // The point of the shared module: a future fix to one branch reaches the
    // other. Before this, the two kept private copies and drifted for months.
    const tf = makeTransform()
    const a = React.createRef<HTMLVideoElement>()
    const b = React.createRef<HTMLVideoElement>()
    render(
      <CompareVideoStage
        mode="sbs" videoRefA={a} videoRefB={b} badgeA="v1" badgeB="v3"
        audioSide="none" onAudioSideChange={vi.fn()} transform={tf}
      />,
    )
    expect(screen.getByTestId('wipe-video-a').className).toBe(COMPARE_MEDIA_CLASS)
    expect(screen.getByTestId('wipe-video-b').className).toBe(COMPARE_MEDIA_CLASS)
  })

  it('clips each image pane to its own box in side-by-side', () => {
    // Screenshotted before the fix: at 200% pane B’s image was painted
    // across most of pane A, because only the STAGE clipped, not the panes.
    const tf = makeTransform()
    const imgARef = React.createRef<HTMLImageElement>()
    const imgBRef = React.createRef<HTMLImageElement>()
    render(
      <CompareImageStage
        urlA="/a.webp" urlB="/b.webp" badgeA="v1" badgeB="v3"
        transform={tf} imgARef={imgARef} imgBRef={imgBRef}
      />,
    )
    for (const alt of ['v1', 'v3']) {
      // img -> transform wrapper -> pane
      const pane = screen.getByAltText(alt).parentElement!.parentElement as HTMLElement
      expect(pane.className).toContain('overflow-hidden')
      expect(pane.className).toBe(comparePaneClass(false))
    }
  })

  it('side-by-side panes clip; wipe panes do not, because clip-path already does', () => {
    expect(comparePaneClass(false)).toContain('overflow-hidden')
    expect(comparePaneClass(true)).not.toContain('overflow-hidden')
  })
})
