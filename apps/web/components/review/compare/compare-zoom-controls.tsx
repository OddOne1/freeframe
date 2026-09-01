'use client'

import * as React from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ZOOM_STEPS } from './use-shared-transform'

interface CompareZoomControlsProps {
  zoomPct: number
  isFit: boolean
  setZoom(pct: number): void
  fit(): void
  className?: string
}

/**
 * Zoom for compare.
 *
 * NORMAL FLOW, not absolutely positioned over the stage. It used to sit
 * `absolute bottom-4 right-4` inside the stage, where a zoomed-in video
 * painted straight over it — and, with nothing clipping the overflow, could
 * intercept its clicks. It now lives in a row of its own above the scrubber,
 * which no amount of zoom can reach.
 *
 * ONE control for BOTH panes. Zoom is shared state (see useSharedTransform):
 * two independently zoomed panes would not be a comparison.
 */
export function CompareZoomControls({
  zoomPct, isFit, setZoom, fit, className,
}: CompareZoomControlsProps) {
  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const idx = ZOOM_STEPS.indexOf(zoomPct as (typeof ZOOM_STEPS)[number])
  const step = (dir: 1 | -1) => {
    const from = idx === -1 ? ZOOM_STEPS.indexOf(1 as (typeof ZOOM_STEPS)[number]) : idx
    setZoom(ZOOM_STEPS[Math.min(Math.max(from + dir, 0), ZOOM_STEPS.length - 1)])
  }

  // 100% now MEANS fitted, so the readout says so rather than showing two
  // names for one state. Fit is no longer a separate entry in the list — it
  // would be a duplicate of 100% — but the Fit button stays, because it also
  // clears any pan.
  const label = `${Math.round(zoomPct * 100)}%${isFit ? ' · Fit' : ''}`

  return (
    <div
      ref={rootRef}
      data-testid="compare-zoom"
      className={cn('relative flex items-center gap-1', className)}
    >
      {open && (
        <div
          role="listbox"
          aria-label="Zoom level"
          className="absolute bottom-full right-0 mb-1 min-w-[104px] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl"
        >
          {ZOOM_STEPS.map((s) => (
            <button
              key={s}
              type="button"
              role="option"
              aria-selected={!isFit && zoomPct === s}
              onClick={() => { setZoom(s); setOpen(false) }}
              className={cn('block w-full rounded px-2 py-1 text-left text-xs tabular-nums hover:bg-bg-hover',
                !isFit && zoomPct === s ? 'text-accent' : 'text-text-secondary')}
            >
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => step(-1)}
        className="flex h-8 w-8 items-center justify-center rounded border border-border bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-testid="compare-zoom-label"
        aria-label="Zoom level"
        onClick={() => setOpen((p) => !p)}
        className="flex h-8 min-w-[52px] items-center justify-center rounded border border-border bg-bg-elevated/90 px-2 text-xs font-medium tabular-nums text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary"
      >
        {label}
      </button>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => step(1)}
        className="flex h-8 w-8 items-center justify-center rounded border border-border bg-bg-elevated/90 text-text-secondary backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-40"
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="Fit to pane"
        onClick={fit}
        className={cn('flex h-8 w-8 items-center justify-center rounded border border-border bg-bg-elevated/90 backdrop-blur-sm transition-colors hover:bg-bg-hover hover:text-text-primary',
          isFit ? 'text-accent' : 'text-text-secondary')}
      >
        <Maximize2 className="h-4 w-4" />
      </button>
    </div>
  )
}
