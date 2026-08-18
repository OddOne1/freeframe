'use client'

import * as React from 'react'
import { getCachedLutThumbnail, renderLutThumbnail } from '@/lib/lut/lut-thumbnail'

/**
 * The reference frame rendered through one LUT, as a data URL, or null while
 * it's still being fetched/parsed/drawn (or if that failed).
 *
 * Never blocks the caller's own render: a list shows its names and sizes
 * immediately and the swatches fill in as each one lands. Pass a null id for
 * "no grade" — the caller shows the ungraded reference itself.
 */
export function useLutThumbnail(
  lutId: string | null,
  fileUrl?: string | null,
): string | null {
  const [src, setSrc] = React.useState<string | null>(() =>
    lutId ? getCachedLutThumbnail(lutId) : null,
  )

  React.useEffect(() => {
    if (!lutId) {
      setSrc(null)
      return
    }

    // Re-read on every id change, so scrolling a long list back to an
    // already-drawn row paints it immediately rather than re-rendering it,
    // and so a *different* LUT never briefly shows the previous one's swatch.
    const cached = getCachedLutThumbnail(lutId)
    setSrc(cached)
    if (cached) return

    let cancelled = false
    renderLutThumbnail(lutId, fileUrl)
      .then((next) => {
        if (!cancelled) setSrc(next)
      })
      .catch(() => {
        // Swallowed on purpose: the row keeps the empty placeholder the reset
        // above already put it in. A LUT whose .cube won't load, or a browser
        // without WebGL2, gets no swatch rather than an ungraded frame
        // presented as a grade.
      })

    return () => {
      cancelled = true
    }
  }, [lutId, fileUrl])

  return src
}
