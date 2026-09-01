'use client'

import * as React from 'react'

/**
 * The wipe divider's position and its drag behaviour.
 *
 * Extracted so the image stage and the video stage share one implementation:
 * the pointer maths (clamp to the stage's own box, listen on window so the
 * drag survives leaving the divider, tear the listeners down on unmount) is
 * the part that is easy to get subtly wrong, and it is identical for both.
 */
export function useWipeSplit(initial = 50) {
  const [split, setSplit] = React.useState(initial)
  const stageRef = React.useRef<HTMLDivElement>(null)
  const cleanup = React.useRef<(() => void) | null>(null)
  React.useEffect(() => () => cleanup.current?.(), [])

  const onDividerDown = React.useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    const move = (ev: PointerEvent) => {
      const rect = stageRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return
      setSplit(Math.min(Math.max(((ev.clientX - rect.left) / rect.width) * 100, 0), 100))
    }
    const up = () => {
      cleanup.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    cleanup.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  return { split, stageRef, onDividerDown }
}

/** The divider itself — one appearance for both stages. */
export function WipeDivider({ split, onPointerDown }: { split: number; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      data-testid="wipe-divider"
      data-split={String(Math.round(split))}
      onPointerDown={onPointerDown}
      className="absolute top-0 bottom-0 z-10 w-4 -translate-x-1/2 cursor-col-resize"
      style={{ left: `${split}%` }}
    >
      <div className="mx-auto h-full w-0.5 bg-white/90" />
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white p-1.5 shadow-lg">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="2">
          <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      </div>
    </div>
  )
}
