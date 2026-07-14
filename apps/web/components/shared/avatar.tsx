'use client'

import * as React from 'react'
import * as RadixAvatar from '@radix-ui/react-avatar'
import { cn, resolveApiMediaUrl } from '@/lib/utils'

type AvatarSize = 'sm' | 'md' | 'lg'

interface AvatarProps {
  src?: string | null
  name?: string | null
  /** Stable identifier (e.g. user id) used to derive a consistent fallback
   *  color. Falls back to name if not provided -- either way the same
   *  person always gets the same color; it is not re-randomized on every
   *  render or page reload. */
  colorSeed?: string | null
  size?: AvatarSize
  className?: string
}

const sizeClasses: Record<AvatarSize, string> = {
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-sm',
}

function getInitials(name?: string | null): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase()
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
}

/** Deterministic hash -> HSL color. The same seed always produces the same
 *  color, so a person's avatar color stays consistent across sessions
 *  instead of changing on every reload. */
function colorForSeed(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  const hue = Math.abs(hash) % 360
  return 'hsl(' + hue + ', 58%, 45%)'
}

export function Avatar({ src, name, colorSeed, size = 'md', className }: AvatarProps) {
// Relative /stream/... proxy paths need an absolute API URL to render in <img>.
const resolvedSrc = resolveApiMediaUrl(src)
const seed = colorSeed || name || '?'
const fallbackColor = colorForSeed(seed)
  return (
    <RadixAvatar.Root
      className={cn(
        'relative inline-flex items-center justify-center rounded-full overflow-hidden shrink-0',
        sizeClasses[size],
        className,
      )}
      style={resolvedSrc ? undefined : { backgroundColor: fallbackColor }}
    >
      {resolvedSrc && (
        <RadixAvatar.Image
          src={resolvedSrc}
          alt={name ?? 'Avatar'}
          className="h-full w-full object-cover"
        />
      )}
      <RadixAvatar.Fallback
        className="flex h-full w-full items-center justify-center font-medium text-white"
        delayMs={0}
      >
        {getInitials(name)}
      </RadixAvatar.Fallback>
    </RadixAvatar.Root>
  )
}
