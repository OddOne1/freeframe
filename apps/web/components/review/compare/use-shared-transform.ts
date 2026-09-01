'use client'

import * as React from 'react'
import { containBox } from '@/lib/media-frame'

/**
 * Zoom percentages, as percentages of ACTUAL SIZE (1 media pixel = 1 screen
 * pixel at 100%), matching what "Actual size" means in the single-asset image
 * viewer. Fit is separate and is not a percentage — it is whatever scale makes
 * the media exactly fill its pane.
 */
export const ZOOM_STEPS = [0.1, 0.33, 0.5, 0.77, 1, 1.33, 1.5, 1.77, 2] as const

export interface MediaMetrics {
  /** Media's own pixel size. */
  intrinsicWidth: number
  intrinsicHeight: number
  /** The pane the media is laid out in. */
  boxWidth: number
  boxHeight: number
}

/**
 * One zoom/pan transform SHARED by both compare sides.
 *
 * Shared is a hard requirement, not a convenience: in wipe the two media
 * layers are overlaid and revealed by a clip, so two different zoom levels
 * would not be a comparison at all — the same feature would sit in two
 * different places either side of the divider. Side-by-side stays shared for
 * the same reason a comparison tool exists: differing zoom would make the two
 * panes incomparable by eye.
 *
 * The media fills its pane with `object-contain`, so the CSS transform is
 * relative to the already-fitted picture: scale 1 IS fit-to-pane. "100%" is
 * therefore not scale 1 — it is whatever scale makes one media pixel one
 * screen pixel, which depends on how much `object-contain` shrank the media
 * to begin with.
 */
export function useSharedTransform() {
  const [scale, setScale] = React.useState(1)
  const [tx, setTx] = React.useState(0)
  const [ty, setTy] = React.useState(0)
  // null = Fit. A number is a ZOOM_STEPS percentage.
  const [zoomPct, setZoomPct] = React.useState<number | null>(null)
  const [metrics, setMetrics] = React.useState<MediaMetrics | null>(null)
  const drag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const dragCleanup = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => dragCleanup.current?.(), [])

  /**
   * The transform scale at which the media renders at its true pixel size.
   *
   * `object-contain` has already scaled the media down (or up) to fit the
   * pane; this undoes exactly that. Null until the media has been measured —
   * with no intrinsic size there is no such thing as "actual size", and
   * guessing 1 would silently mean "fit" while claiming 100%.
   */
  const actualScale = React.useMemo(() => {
    if (!metrics) return null
    const { intrinsicWidth, intrinsicHeight, boxWidth, boxHeight } = metrics
    if (!intrinsicWidth || !intrinsicHeight || !boxWidth || !boxHeight) return null
    const box = containBox(intrinsicWidth, intrinsicHeight, boxWidth, boxHeight)
    if (!box.width) return null
    return intrinsicWidth / box.width
  }, [metrics])

  /** Re-derive the scale whenever the pane resizes, so a chosen percentage
   *  stays that percentage instead of drifting with the container. */
  React.useEffect(() => {
    if (zoomPct === null) { setScale(1); return }
    if (actualScale === null) return
    setScale(zoomPct * actualScale)
  }, [zoomPct, actualScale])

  const setZoom = React.useCallback((pct: number) => {
    setZoomPct(pct)
    setTx(0); setTy(0)
  }, [])

  const fit = React.useCallback(() => {
    setZoomPct(null)
    setScale(1); setTx(0); setTy(0)
  }, [])

  /** Wheel steps through the same fixed list the buttons offer, rather than
   *  running continuously — otherwise the readout shows a percentage the
   *  control cannot return to. */
  const onWheel = React.useCallback((e: { deltaY: number; preventDefault(): void }) => {
    e.preventDefault()
    if (actualScale === null) return
    setZoomPct((current) => {
      const currentIdx = current === null
        ? ZOOM_STEPS.indexOf(1 as (typeof ZOOM_STEPS)[number])
        : ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number])
      const idx = currentIdx === -1 ? ZOOM_STEPS.indexOf(1 as (typeof ZOOM_STEPS)[number]) : currentIdx
      const next = Math.min(Math.max(idx + (e.deltaY < 0 ? 1 : -1), 0), ZOOM_STEPS.length - 1)
      return ZOOM_STEPS[next]
    })
    setTx(0); setTy(0)
  }, [actualScale])

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    if (scale <= 1) return
    drag.current = { x: e.clientX, y: e.clientY, tx, ty }
    const move = (ev: PointerEvent) => {
      if (!drag.current) return
      setTx(drag.current.tx + (ev.clientX - drag.current.x))
      setTy(drag.current.ty + (ev.clientY - drag.current.y))
    }
    const up = () => {
      drag.current = null
      dragCleanup.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    dragCleanup.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [scale, tx, ty])

  const reset = fit

  const styleFor = React.useCallback(
    (): React.CSSProperties => ({
      transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
      transformOrigin: 'center center',
    }),
    [scale, tx, ty],
  )

  /**
   * Idempotent by VALUE, not by object identity.
   *
   * Callers measure on every ResizeObserver tick and pass a fresh object, so
   * an identity-based setter re-renders on every tick even when nothing moved
   * — and if the caller's effect happens to re-run each render (a ref whose
   * identity is not stable, which is exactly what a mocked player hook
   * produces), that is an unbounded loop rather than merely wasteful. It was:
   * this OOM'd the test worker.
   */
  const setMediaMetrics = React.useCallback((m: MediaMetrics | null) => {
    setMetrics((prev) => {
      if (prev === m) return prev
      if (!prev || !m) return m
      return prev.intrinsicWidth === m.intrinsicWidth
        && prev.intrinsicHeight === m.intrinsicHeight
        && prev.boxWidth === m.boxWidth
        && prev.boxHeight === m.boxHeight
        ? prev
        : m
    })
  }, [])

  return {
    scale, tx, ty, styleFor, onWheel, onPointerDown, reset,
    // Zoom control surface
    zoomPct, isFit: zoomPct === null, setZoom, fit,
    setMediaMetrics,
    canZoom: actualScale !== null,
  }
}
