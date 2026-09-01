'use client'

import * as React from 'react'

/**
 * The pane geometry both compare stages share (§116).
 *
 * This module exists because the same sizing bug had to be fixed twice. §110
 * fixed the video stage; the image branch kept its own copy of the markup and
 * kept the bug, and nothing connected the two, so the fix had no path to it.
 * Measured in a browser before this change, a 480x270 source in a 700x568
 * side-by-side pane:
 *
 *   image branch   the <img> laid out at 480x270 — its intrinsic size —
 *                  centred with 110px bands left/right and 149px top/bottom.
 *   video branch   the element filling the pane at 700x568, the picture
 *                  letterboxed inside it at 700x394.
 *
 * `max-w-full max-h-full` only ever scales DOWN, so any media smaller than its
 * pane renders at natural size and never fills it. That also quietly broke the
 * zoom scale's meaning: useSharedTransform defines 100% as "exactly fitted to
 * this pane" and multiplies from there, so on a small image every percentage
 * was a multiple of the intrinsic size instead — 200% of a 480px-wide source
 * is 960px, not 200% of the pane. Hence "zoomed in and still letterboxed in a
 * smaller box".
 *
 * So the sizing lives here once, and both stages import it. Two copies of one
 * rule drifting is this project's recurring failure (§30, §32, §61) and this is
 * the same shape.
 */

/**
 * Fill the pane and letterbox the picture inside it — never `max-*`.
 *
 * Filling is also what makes the annotation overlays correct: both frame
 * constraints fit the picture inside the ELEMENT's own box, so an element that
 * is smaller than its pane puts the overlay somewhere the picture is not.
 */
export const COMPARE_MEDIA_CLASS = 'absolute inset-0 h-full w-full object-contain'

/**
 * `overflow-hidden` is PER PANE in side-by-side, not on the stage: a zoomed
 * left pane spilling into the right one is not a comparison, and clipping at
 * stage level still lets the two panes bleed into each other. Confirmed by
 * screenshot before this change — at 200% pane B's image was painted across
 * most of pane A.
 *
 * Wipe needs no overflow rule: each pane is clipped to its own side of the
 * divider by `clip-path` already.
 */
export function comparePaneClass(isWipe: boolean): string {
  return isWipe
    ? 'absolute inset-0 flex items-center justify-center'
    : 'relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-black'
}

export interface ComparePaneTransform {
  styleFor(): React.CSSProperties
  onWheel(e: { deltaY: number; preventDefault(): void }): void
  onPointerDown(e: React.PointerEvent): void
}

/**
 * One compare pane: the clip in screen space, the zoom transform inside it.
 *
 * The transform is applied INSIDE the pane so the pane's clip stays in screen
 * space and the wipe divider keeps matching the visible split however far the
 * media is zoomed or panned.
 */
export function ComparePane({
  isWipe,
  clip,
  transform,
  children,
  chrome,
  testId,
}: {
  isWipe: boolean
  /** Screen-space clip for wipe mode; undefined in side-by-side. */
  clip?: React.CSSProperties
  transform?: ComparePaneTransform
  /** Media + overlays. Zooms and pans with the transform. */
  children: React.ReactNode
  /** Badges and messages. Inside the pane, OUTSIDE the transform, so they stay
   *  put and readable at any zoom. */
  chrome?: React.ReactNode
  testId?: string
}) {
  return (
    <div
      data-testid={testId}
      className={comparePaneClass(isWipe)}
      style={clip}
      onWheel={transform?.onWheel}
      onPointerDown={transform?.onPointerDown}
    >
      <div className="absolute inset-0" style={transform?.styleFor()}>
        {children}
      </div>
      {chrome}
    </div>
  )
}
