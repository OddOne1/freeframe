'use client'

import * as React from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StarRatingProps {
  value?: number | null
  onChange?: (star: number) => void
  readOnly?: boolean
  size?: 'sm' | 'md'
  /**
   * Grow every star to a 44px hit area under `hover: none` (§228).
   *
   * On by default, because the place this component is editable and matters
   * is the viewer's Fields tab, where voting is the point and a 14px star
   * is not something a finger can hit.
   *
   * §228b item 1 — the asset card passes `false`. Five 44px stars is a
   * 220px bar, and the card's chip is anchored over the top of a thumbnail
   * that is 82-354px wide with the selection checkbox in the opposite
   * corner: it covered the one control that starts a multi-selection on a
   * phone. The card's rating is a DISPLAY on touch (`readOnly` as well as
   * this), and voting happens in the viewer.
   */
  touchTargets?: boolean
  className?: string
}

const sizeClasses: Record<NonNullable<StarRatingProps['size']>, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
}

export function StarRating({
  value,
  onChange,
  readOnly = false,
  size = 'md',
  touchTargets = true,
  className,
}: StarRatingProps) {
  const [hovered, setHovered] = React.useState<number | null>(null)
  const displayValue = hovered ?? value ?? 0
  const starSize = sizeClasses[size]

  return (
    <div
      className={cn('flex items-center gap-0.5', className)}
      onMouseLeave={() => setHovered(null)}
    >
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= displayValue
        return (
          <button
            key={star}
            type="button"
            disabled={readOnly}
            onMouseEnter={() => !readOnly && setHovered(star)}
            onClick={(e) => {
              e.stopPropagation()
              if (!readOnly) onChange?.(star)
            }}
            className={cn(
              'flex items-center justify-center transition-colors',
              readOnly
                ? 'cursor-default'
                // §228 — a 14px star is not a touch target. Only when the
                // rating is EDITABLE: a read-only row of stars is a
                // display, and growing those would push the voter
                // breakdown rows apart for no gain. §228b — and only when
                // the caller wants the target at all; see `touchTargets`.
                : touchTargets
                  ? 'cursor-pointer hover-none:h-11 hover-none:w-11'
                  : 'cursor-pointer',
            )}
          >
            <Star
              className={cn(
                starSize,
                filled ? 'fill-status-warning text-status-warning' : 'fill-transparent text-text-tertiary',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
