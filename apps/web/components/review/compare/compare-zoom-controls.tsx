'use client'

import * as React from 'react'
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ZOOM_STEPS } from './use-shared-transform'

interface CompareZoomControlsProps {
  zoomPct: number | null
  isFit: boolean
  canZoom: boolean
  setZoom(pct: number): void
  fit(): void
  className?: string
}

/**
 * Zoom for compare, in the bottom-right corner — the same place the
 * single-asset image viewer puts its own zoom controls, so the app has one
 * answer to "where is zoom".
 *
 * ONE control for BOTH panes, and the readout says so implicitly by there
 * being only one. Zoom is shared state (see useSharedTransform): two
 * independently zoomed panes would not be a comparison.
 */
export function CompareZoomControls({
  zoomPct, isFit, canZoom, setZoom, fit, className,
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

  const idx = zoomPct === null ? -1 : ZOOM_STEPS.indexOf(zoomPct as (typeof ZOOM_STEPS)[number])
  const step = (dir: 1 | -1) => {
    // From Fit, stepping starts at 100% — the only percentage that has a
    // fixed meaning regardless of pane size.
    const from = idx === -1 ? ZOOM_STEPS.indexOf(1 as (typeof ZOOM_STEPS)[number]) : idx
    setZoom(ZOOM_STEPS[Math.min(Math.max(from + dir, 0), ZOOM_STEPS.length - 1)])
  }

  const label = isFit ? 'Fit' : `${Math.round((zoomPct ?? 1) * 100)}%`

  return (
    <div
      ref={rootRef}
      data-testid="compare-zoom"
      className={cn('absolute bottom-4 right-4 z-20 flex items-center gap-1', className)}
    >
      {open && (
        <div
          role="listbox"
          aria-label="Zoom level"
          className="absolute bottom-full right-0 mb-1 min-w-[104px] rounded-lg border border-border bg-bg-elevated p-1 shadow-xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={isFit}
            onClick={() => { fit(); setOpen(false) }}
            className={cn('block w-full rounded px-2 py-1 text-left text-xs hover:bg-bg-hover',
              isFit ? 'text-accent' : 'text-text-secondary')}
          >
            Fit
          </button>
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
        disabled={!canZoom}
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
        disabled={!canZoom}
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
