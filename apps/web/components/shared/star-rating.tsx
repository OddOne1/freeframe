'use client'

import * as React from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StarRatingProps {
  value?: number | null
  onChange?: (star: number) => void
  readOnly?: boolean
  size?: 'sm' | 'md'
  className?: string
}

const sizeClasses: Record<NonNullable<StarRatingProps['size']>, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-5 w-5',
}

export function StarRating({ value, onChange, readOnly = false, size = 'md', className }: StarRatingProps) {
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
              'transition-colors',
              readOnly ? 'cursor-default' : 'cursor-pointer',
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
