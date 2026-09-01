'use client'

import * as React from 'react'
import { ImageFrameConstraint } from '@/components/review/image-frame-constraint'
import { COMPARE_MEDIA_CLASS, ComparePane, type ComparePaneTransform } from './compare-pane'

interface CompareImageStageProps {
  /** null while the stream URL is still resolving — same shape the overlay holds. */
  urlA?: string | null
  urlB?: string | null
  badgeA: string
  badgeB: string
  transform: ComparePaneTransform & { reset(): void }
  imgARef: React.RefObject<HTMLImageElement>
  imgBRef: React.RefObject<HTMLImageElement>
  /** Per-pane annotation display + authoring layer. */
  paneOverlayA?: React.ReactNode
  paneOverlayB?: React.ReactNode
}

/**
 * The two compare images, side by side — the image twin of CompareVideoStage,
 * and built on the same ComparePane so the two cannot size differently again.
 *
 * It was inline JSX inside compare-overlay.tsx, which is how it missed §110's
 * sizing fix and §112's per-pane clip: neither had any path to it. See
 * compare-pane.tsx for what that cost and what was measured.
 *
 * Wipe mode is NOT handled here — it stays in WipeViewer, because the two
 * modes differ in more than layout for images: wipe shows ONE annotation
 * clipped to its owning version's half of a single shared frame, where
 * side-by-side shows both, one per pane. Folding those together would be a
 * behaviour change, not a sizing fix. What they now share is the part that
 * actually drifted — the media sizing class.
 */
export function CompareImageStage({
  urlA, urlB, badgeA, badgeB, transform, imgARef, imgBRef, paneOverlayA, paneOverlayB,
}: CompareImageStageProps) {
  return (
    <div
      data-testid="sbs-image-stage"
      className="relative flex min-h-0 flex-1 items-stretch overflow-hidden bg-black"
      onDoubleClick={transform.reset}
    >
      <ComparePane
        isWipe={false}
        transform={transform}
        chrome={
          <span className="absolute left-3 top-3 z-10 rounded bg-sky-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {badgeA}
          </span>
        }
      >
        {urlA && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgARef} src={urlA} alt={badgeA} className={COMPARE_MEDIA_CLASS} draggable={false} />
            {/* Image-frame space, not pane space — the two panes letterbox
                differently whenever the versions differ in aspect ratio. */}
            <ImageFrameConstraint imgRef={imgARef}>{paneOverlayA}</ImageFrameConstraint>
          </>
        )}
      </ComparePane>

      {/* The static seam between the two halves. */}
      <div className="w-px bg-border" />

      <ComparePane
        isWipe={false}
        transform={transform}
        chrome={
          <span className="absolute right-3 top-3 z-10 rounded bg-emerald-500/90 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {badgeB}
          </span>
        }
      >
        {urlB && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgBRef} src={urlB} alt={badgeB} className={COMPARE_MEDIA_CLASS} draggable={false} />
            <ImageFrameConstraint imgRef={imgBRef}>{paneOverlayB}</ImageFrameConstraint>
          </>
        )}
      </ComparePane>
    </div>
  )
}
