'use client'

import * as React from 'react'

/**
 * Zoom percentages, relative to the media as FITTED IN THE CURRENT PANE.
 *
 * They used to be percentages of actual size — one media pixel per screen
 * pixel — which is an absolute footprint, so the same "100%" filled a
 * full-width wipe pane and overflowed a half-width side-by-side one. The
 * number claimed to mean something consistent and did not.
 *
 * Now 100% means "exactly fitted to this pane", so the number means the same
 * relative thing in both modes, and switching modes at any percentage can
 * neither overflow nor shrink unexpectedly.
 */
export const ZOOM_STEPS = [0.1, 0.33, 0.5, 0.77, 1, 1.33, 1.5, 1.77, 2] as const

/** 100% — the media exactly filling its pane. Also what Fit resets to. */
const FIT = 1

/**
 * One zoom/pan transform SHARED by both compare sides.
 *
 * Shared is a hard requirement, not a convenience: in wipe the two media
 * layers are overlaid and revealed by a clip, so two different zoom levels
 * would not be a comparison at all — the same feature would sit in two
 * different places either side of the divider. Side-by-side stays shared for
 * the same reason.
 *
 * NO MODE AWARENESS IS NEEDED, and that is the point of expressing the
 * percentage this way. The media is laid out with `object-contain`, which
 * already re-fits it to whatever pane it finds itself in — half-width in
 * side-by-side, full-width in wipe. A CSS scale on top of that is therefore
 * already relative to the current mode's frame, and re-fits on a mode switch
 * for free. The previous design had to measure the media and its pane on
 * every resize to convert a percentage into a scale; none of that machinery
 * exists any more, and neither does the render loop it was capable of.
 */
export function useSharedTransform() {
  const [zoomPct, setZoomPct] = React.useState<number>(FIT)
  const [tx, setTx] = React.useState(0)
  const [ty, setTy] = React.useState(0)
  const drag = React.useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const dragCleanup = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => dragCleanup.current?.(), [])

  // Percentages are relative to the fitted picture, so the percentage IS the
  // scale. No measurement, no conversion.
  const scale = zoomPct

  const setZoom = React.useCallback((pct: number) => {
    setZoomPct(pct)
    setTx(0); setTy(0)
  }, [])

  const fit = React.useCallback(() => {
    setZoomPct(FIT)
    setTx(0); setTy(0)
  }, [])

  /** Wheel steps through the same fixed list the buttons offer, rather than
   *  running continuously — otherwise the readout shows a percentage the
   *  control cannot return to. */
  const onWheel = React.useCallback((e: { deltaY: number; preventDefault(): void }) => {
    e.preventDefault()
    setZoomPct((current) => {
      const idx = ZOOM_STEPS.indexOf(current as (typeof ZOOM_STEPS)[number])
      const from = idx === -1 ? ZOOM_STEPS.indexOf(FIT) : idx
      return ZOOM_STEPS[Math.min(Math.max(from + (e.deltaY < 0 ? 1 : -1), 0), ZOOM_STEPS.length - 1)]
    })
    setTx(0); setTy(0)
  }, [])

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    // Panning only means something once the media is larger than its pane.
    if (scale <= FIT) return
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

  return {
    scale, tx, ty, styleFor, onWheel, onPointerDown, reset,
    zoomPct, isFit: zoomPct === FIT, setZoom, fit,
  }
}
