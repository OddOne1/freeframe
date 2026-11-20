'use client'

/**
 * The Clips tab's grid size and text size: two compact segmented controls
 * for its toolbar, beside Sort and Group. Each segment is a toggle button
 * (aria-pressed) with a tooltip, in a labelled group.
 */
import * as React from 'react'
import { Grid2x2, Grid3x3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClipGridSize, ClipTextSize } from './clip-display'

interface Segment<V extends string> {
  value: V
  label: string
  content: React.ReactNode
}

const GRID_SEGMENTS: Segment<ClipGridSize>[] = [
  { value: 'small', label: 'Small grid', content: <Grid3x3 className="h-3.5 w-3.5" aria-hidden /> },
  { value: 'large', label: 'Large grid', content: <Grid2x2 className="h-3.5 w-3.5" aria-hidden /> },
]

// Three A's in rising sizes: the letters are the picture, the label says it.
const TEXT_SEGMENTS: Segment<ClipTextSize>[] = [
  { value: 'normal', label: 'Normal text', content: <span className="text-[11px] leading-none">A</span> },
  { value: 'large', label: 'Large text', content: <span className="text-[14px] leading-none">A</span> },
  { value: 'xlarge', label: 'Extra large text', content: <span className="text-[17px] leading-none">A</span> },
]

function SegmentedControl<V extends string>({
  label,
  value,
  segments,
  onChange,
  testId,
}: {
  label: string
  value: V
  segments: Segment<V>[]
  onChange: (v: V) => void
  testId: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className="inline-flex h-8 hover-none:h-11 items-center gap-0.5 rounded-md border border-border bg-bg-secondary p-0.5"
    >
      {segments.map((s) => {
        const on = s.value === value
        return (
          <button
            key={s.value}
            type="button"
            aria-pressed={on}
            aria-label={s.label}
            title={s.label}
            onClick={() => onChange(s.value)}
            className={cn(
              'flex h-full min-w-[1.75rem] hover-none:min-w-[2.5rem] items-center justify-center rounded px-1.5 font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              on ? 'bg-bg-hover text-text-primary' : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary',
            )}
          >
            {s.content}
          </button>
        )
      })}
    </div>
  )
}

export function ClipDisplayControls({
  gridSize,
  textSize,
  onGridSize,
  onTextSize,
}: {
  gridSize: ClipGridSize
  textSize: ClipTextSize
  onGridSize: (size: ClipGridSize) => void
  onTextSize: (size: ClipTextSize) => void
}) {
  return (
    <>
      <SegmentedControl
        label="Grid size"
        value={gridSize}
        segments={GRID_SEGMENTS}
        onChange={onGridSize}
        testId="clip-grid-size"
      />
      <SegmentedControl
        label="Text size"
        value={textSize}
        segments={TEXT_SEGMENTS}
        onChange={onTextSize}
        testId="clip-text-size"
      />
    </>
  )
}
