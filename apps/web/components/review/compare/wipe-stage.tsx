'use client'

import * as React from 'react'

export interface WipeTransform {
  styleFor(): React.CSSProperties
  onWheel(e: { deltaY: number; preventDefault(): void }): void
  onPointerDown(e: React.PointerEvent): void
}

interface WipeStageProps {
  /** Rendered underneath, revealed LEFT of the divider. */
  layerA: React.ReactNode
  /** Rendered on top, clipped so it is revealed RIGHT of the divider. */
  layerB: React.ReactNode
  badgeA: string
  badgeB: string
  /** Extra chrome pinned to each top corner (the video stage's audio toggles). */
  cornerA?: React.ReactNode
  cornerB?: React.ReactNode
  /**
   * Zoom/pan shared by both media layers. Images use it; video does not (the
   * side-by-side video stage has no zoom either), so it is optional and the
   * stage falls back to an identity transform with no wheel/drag handlers.
   */
  transform?: WipeTransform
  /**
   * Extra layer above both media layers, CLIPPED in screen space to the region
   * where its owning version is visible — side A left of the divider, side B
   * right (matching the B layer's clip) — so a version's annotation never
   * bleeds onto the other version's half. `overlaySide` names that version.
   */
  overlay?: React.ReactNode
  overlaySide?: 'a' | 'b' | null
  /** Wraps the overlay in the media-type-appropriate frame constraint. */
  constrainOverlay?: (side: 'a' | 'b', children: React.ReactNode) => React.ReactNode
}

const IDENTITY: WipeTransform = {
  styleFor: () => ({}),
  onWheel: () => {},
  onPointerDown: () => {},
}

/**
 * The wipe chrome — split state, the draggable divider, the screen-space clips
 * and the corner badges — with the media itself supplied by the caller.
 *
 * Extracted so the image and video wipe stages cannot drift: the divider drag,
 * the clip arithmetic and the overlay's owning-side clip are the parts that are
 * easy to get subtly wrong and identical for both. `clip-path` has never cared
 * what it clips, which is why video needs no new sync or layout machinery —
 * only different elements inside the same layers.
 */
export function WipeStage({
  layerA, layerB, badgeA, badgeB, cornerA, cornerB,
  transform, overlay, overlaySide, constrainOverlay,
}: WipeStageProps) {
  const [split, setSplit] = React.useState(50)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const dividerCleanup = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => dividerCleanup.current?.(), [])

  const tf = transform ?? IDENTITY

  const onDividerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const move = (ev: PointerEvent) => {
      const rect = stageRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      setSplit(Math.min(Math.max(((ev.clientX - rect.left) / rect.width) * 100, 0), 100))
    }
    const up = () => {
      dividerCleanup.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    dividerCleanup.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={stageRef}
      data-testid="wipe-stage"
      className="relative h-full w-full overflow-hidden bg-black select-none"
      onWheel={(e) => tf.onWheel(e)}
      onPointerDown={tf.onPointerDown}
    >
      {/* Side A (left of divider) */}
      <div className="absolute inset-0 flex items-center justify-center" style={tf.styleFor()}>
        {layerA}
      </div>
      {/* Side B on top, revealed right of the divider */}
      <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
        <div className="absolute inset-0 flex items-center justify-center" style={tf.styleFor()}>
          {layerB}
        </div>
      </div>
      {/* Overlay layer — above both media layers. The clip lives in SCREEN
          space (outside the transform, like the B layer's) so the annotation is
          shown only over its owning version's half. The transform is applied on
          the inner layer so the drawing still zooms/pans with the media. */}
      {overlay && (
        <div
          data-testid="wipe-overlay-clip"
          className="pointer-events-none absolute inset-0"
          style={
            overlaySide === 'a'
              ? { clipPath: `inset(0 ${100 - split}% 0 0)` }
              : overlaySide === 'b'
                ? { clipPath: `inset(0 0 0 ${split}%)` }
                : undefined
          }
        >
          <div className="absolute inset-0" style={tf.styleFor()}>
            {constrainOverlay ? constrainOverlay(overlaySide ?? 'a', overlay) : overlay}
          </div>
        </div>
      )}
      {/* Divider */}
      <div
        data-testid="wipe-divider"
        data-split={String(Math.round(split))}
        onPointerDown={onDividerDown}
        className="absolute top-0 bottom-0 z-10 w-4 -translate-x-1/2 cursor-col-resize"
        style={{ left: `${split}%` }}
      >
        <div className="mx-auto h-full w-0.5 bg-white/90" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white p-1.5 shadow-lg">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2">
            <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
          </svg>
        </div>
      </div>
      {/* Corner version badges (plus any per-side chrome the caller adds) */}
      <div className="absolute left-3 top-3 z-10 flex items-center gap-1.5">
        <span className="rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeA}</span>
        {cornerA}
      </div>
      <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
        {cornerB}
        <span className="rounded bg-emerald-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">{badgeB}</span>
      </div>
    </div>
  )
}
