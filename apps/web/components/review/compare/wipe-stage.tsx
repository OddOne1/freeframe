'use client'

import * as React from 'react'
import { useWipeSplit, WipeDivider } from './use-wipe-split'

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
  // Shared with the video stage — one divider implementation, not two.
  const { split, stageRef, onDividerDown } = useWipeSplit()
  const tf = transform ?? IDENTITY

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
      <WipeDivider split={split} onPointerDown={onDividerDown} />
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
