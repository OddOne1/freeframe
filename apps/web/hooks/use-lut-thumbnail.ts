'use client'

import * as React from 'react'
import {
  getCachedLutPreview,
  getCachedLutThumbnail,
  renderLutPreview,
  renderLutThumbnail,
} from '@/lib/lut/lut-thumbnail'

type Reader = (lutId: string) => string | null
type Renderer = (lutId: string, fileUrl: string | null | undefined) => Promise<string>

export type LutFrameStatus = 'idle' | 'loading' | 'ready' | 'error'

interface LutFrame {
  src: string | null
  status: LutFrameStatus
}

function useRenderedFrame(
  read: Reader,
  draw: Renderer,
  lutId: string | null,
  fileUrl?: string | null,
): LutFrame {
  const [frame, setFrame] = React.useState<LutFrame>(() => {
    const cached = lutId ? read(lutId) : null
    return cached ? { src: cached, status: 'ready' } : { src: null, status: lutId ? 'loading' : 'idle' }
  })

  React.useEffect(() => {
    if (!lutId) {
      setFrame({ src: null, status: 'idle' })
      return
    }

    // Re-read on every id change, so scrolling a long list back to an
    // already-drawn row paints it immediately rather than re-rendering it,
    // and so a *different* LUT never briefly shows the previous one's frame.
    const cached = read(lutId)
    setFrame(cached ? { src: cached, status: 'ready' } : { src: null, status: 'loading' })
    if (cached) return

    let cancelled = false
    draw(lutId, fileUrl)
      .then((next) => {
        if (!cancelled) setFrame({ src: next, status: 'ready' })
      })
      .catch(() => {
        // Never rethrown: a LUT whose .cube won't load, or a browser without
        // WebGL2, gets no frame rather than an ungraded one presented as a
        // grade. A row swatch just stays an empty placeholder; the zoom
        // dialog reads the status and says so, because there a person
        // deliberately asked for this one frame.
        if (!cancelled) setFrame({ src: null, status: 'error' })
      })

    return () => {
      cancelled = true
    }
  }, [read, draw, lutId, fileUrl])

  return frame
}

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
  return useRenderedFrame(getCachedLutThumbnail, renderLutThumbnail, lutId, fileUrl).src
}

/**
 * The same frame at the zoom view's resolution — a separate render rather
 * than the row swatch scaled up, which is the whole point of the zoom.
 *
 * Returns the status too: this one is opened on purpose, one LUT at a time,
 * so it owes the user a spinner and a failure message rather than an empty
 * box that never fills.
 */
export function useLutPreview(
  lutId: string | null,
  fileUrl?: string | null,
): LutFrame {
  return useRenderedFrame(getCachedLutPreview, renderLutPreview, lutId, fileUrl)
}
