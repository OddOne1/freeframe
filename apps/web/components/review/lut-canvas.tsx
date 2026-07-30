'use client'

import * as React from 'react'
import { LutRenderer, type LutSource } from '@/lib/lut/webgl-lut'
import type { ParsedCube } from '@/lib/lut/cube-parser'

interface LutCanvasProps {
  /** The element actually being decoded — an <img> or the hidden <video>. */
  source: LutSource | null
  cube: ParsedCube | null
  width: number
  height: number
  /** Video needs a per-frame loop; a still image only redraws on change. */
  animated?: boolean
  className?: string
  style?: React.CSSProperties
}

/**
 * Draws `source` through `cube` into a canvas.
 *
 * For video the real <video> element stays in the DOM as the decode and
 * audio source (hls.js keeps driving it untouched) and is visually hidden;
 * this canvas is laid over the exact same box, so anything positioned
 * against that box — notably VideoFrameConstraint's annotation overlay —
 * keeps lining up without modification.
 */
export function LutCanvas({
  source,
  cube,
  width,
  height,
  animated = false,
  className,
  style,
}: LutCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const rendererRef = React.useRef<LutRenderer | null>(null)
  const [failed, setFailed] = React.useState(false)

  // One renderer per canvas, for the canvas's whole life. Recreating it per
  // frame would rebuild the shader program every time.
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    try {
      rendererRef.current = new LutRenderer(canvas)
    } catch {
      setFailed(true)
      return
    }
    return () => {
      rendererRef.current?.dispose()
      rendererRef.current = null
    }
  }, [])

  React.useEffect(() => {
    rendererRef.current?.setLut(cube)
  }, [cube])

  React.useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !source || failed || width <= 0 || height <= 0) return

    if (!animated) {
      renderer.render(source, width, height)
      return
    }

    // requestVideoFrameCallback fires once per *decoded* frame, so a 24fps
    // clip costs 24 draws/sec instead of the display's 60 — and never
    // redraws the same frame twice. rAF is the fallback where it's missing.
    const video = source as HTMLVideoElement
    let stop = false
    let rafId = 0
    let vfcId = 0
    const hasVfc = typeof (video as any).requestVideoFrameCallback === 'function'

    const draw = () => {
      if (stop) return
      renderer.render(source, width, height)
      if (hasVfc) {
        vfcId = (video as any).requestVideoFrameCallback(draw)
      } else {
        rafId = requestAnimationFrame(draw)
      }
    }
    draw()

    return () => {
      stop = true
      if (hasVfc && vfcId) (video as any).cancelVideoFrameCallback?.(vfcId)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [source, cube, width, height, animated, failed])

  if (failed) return null

  return <canvas ref={canvasRef} className={className} style={style} />
}
