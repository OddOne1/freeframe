/**
 * §123 — the LUT control sits in the same corner whatever the media type.
 *
 * §119 rebuilt it as one shared component with an explicit requirement that
 * it serve video and photo identically, but each viewer places the trigger
 * itself: the video player puts it in the transport bar's right-hand control
 * group (bottom-right), while the image viewer floated it top-left. Same
 * component, two corners.
 *
 * Measured in a browser after the move: the LUT button occupies x 1005-1044
 * and the zoom stack 1052-1084, bottom-aligned on the same baseline — no
 * overlap, 8px apart.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const imageViewer = readFileSync(join(__dirname, '..', 'image-viewer.tsx'), 'utf8')

/** The wrapper the image viewer positions lutPicker with. */
function lutWrapperClasses(): string {
  const at = imageViewer.indexOf('{lutPicker && (')
  const chunk = imageViewer.slice(at, at + 200)
  return /className="([^"]+)"/.exec(chunk)?.[1] ?? ''
}

describe('the image viewer', () => {
  it('anchors the LUT control to the bottom, like the video player', () => {
    const cls = lutWrapperClasses()
    expect(cls).toContain('bottom-4')
    expect(cls).not.toContain('top-3')
  })

  it('anchors it to the right, like the video player', () => {
    expect(lutWrapperClasses()).toContain('right-')
    expect(lutWrapperClasses()).not.toContain('left-')
  })

  it('keeps clear of the zoom stack, which owns the corner itself', () => {
    // ZoomControls is `absolute bottom-4 right-4` and 32px wide, so anything
    // at right-4 would sit on top of it.
    expect(lutWrapperClasses()).not.toMatch(/\bright-4\b/)
  })

  it('still renders the trigger the page passes in', () => {
    expect(imageViewer).toContain('{lutPicker}')
  })
})
