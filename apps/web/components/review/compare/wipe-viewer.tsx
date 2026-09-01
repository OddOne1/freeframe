'use client'

import * as React from 'react'
import { ImageFrameConstraint } from '@/components/review/image-frame-constraint'
import { WipeStage, type WipeTransform } from './wipe-stage'

interface WipeViewerProps {
  urlA: string
  urlB: string
  badgeA: string
  badgeB: string
  transform: WipeTransform
  /**
   * Extra stage layer rendered ABOVE both image layers, inside the shared
   * transform (annotation display). It is CLIPPED in screen space to the region
   * where its owning version is visible — side A left of the divider, side B
   * right (matching the B-image clip) — so a version's annotation never bleeds
   * onto the other version's half. `overlaySide` names that owning version.
   */
  overlay?: React.ReactNode
  overlaySide?: 'a' | 'b' | null
}

/**
 * Image wipe stage: A underneath, B on top clipped from the left by the divider.
 * The clip lives in SCREEN space (outside the shared transform) so the divider
 * line always matches the visible split, regardless of zoom/pan.
 *
 * The chrome itself lives in WipeStage, shared with the video stage.
 */
export function WipeViewer({ urlA, urlB, badgeA, badgeB, transform, overlay, overlaySide }: WipeViewerProps) {
  // Annotations are authored in image-frame space, so display has to measure the
  // owning version's <img> — the two versions can letterbox differently.
  const imgARef = React.useRef<HTMLImageElement>(null)
  const imgBRef = React.useRef<HTMLImageElement>(null)

  return (
    <WipeStage
      badgeA={badgeA}
      badgeB={badgeB}
      transform={transform}
      overlay={overlay}
      overlaySide={overlaySide}
      layerA={
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={imgARef} src={urlA} alt={badgeA} className="max-h-full max-w-full object-contain" draggable={false} />
      }
      layerB={
        // eslint-disable-next-line @next/next/no-img-element
        <img ref={imgBRef} src={urlB} alt={badgeB} className="max-h-full max-w-full object-contain" draggable={false} />
      }
      constrainOverlay={(side, children) => (
        // Keyed by side so switching owner remounts the constraint against that
        // version's <img> instead of holding the previous one's box. Both images
        // share this layer's coordinate space (every layer is `absolute inset-0`
        // of the stage), so the offsets line up.
        <ImageFrameConstraint key={side} imgRef={side === 'b' ? imgBRef : imgARef}>
          {children}
        </ImageFrameConstraint>
      )}
    />
  )
}
