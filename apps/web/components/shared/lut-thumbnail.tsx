'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { useLutThumbnail } from '@/hooks/use-lut-thumbnail'
import { REFERENCE_IMAGE_SRC } from '@/lib/lut/lut-thumbnail'
import type { Lut } from '@/types'

interface LutThumbnailProps {
  /** Pass null for the "None" / no-grade row: it shows the reference frame
   *  ungraded, which is what makes the graded swatches beside it readable. */
  lut: Pick<Lut, 'id' | 'file_url'> | null
  /** Size and shape come from the caller — the reference frame is 3:2, so
   *  the two current call sites use h-8 w-12 and h-4 w-6. */
  className?: string
}

/**
 * A fixed reference frame rendered through this LUT — a glance-preview of
 * roughly what the grade does, not a picture of anything.
 *
 * Decorative: every call site sits next to the LUT's own name, so the image
 * carries no alt text of its own.
 */
export function LutThumbnail({ lut, className }: LutThumbnailProps) {
  const graded = useLutThumbnail(lut?.id ?? null, lut?.file_url)
  const src = lut ? graded : REFERENCE_IMAGE_SRC

  return (
    <span
      data-testid="lut-thumbnail"
      className={cn(
        'block shrink-0 overflow-hidden rounded border border-border bg-bg-tertiary',
        className,
      )}
    >
      {src && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          aria-hidden="true"
          // An <img> is natively draggable with no attribute set (CLAUDE.md
          // §24b), and that drag wins over a draggable ancestor's -- which
          // would break dragging a Settings row by its swatch.
          draggable={false}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  )
}
