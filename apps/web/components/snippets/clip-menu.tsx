'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { EyeOff, MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The "more" menu on a clip card and in the player header. One item today,
 * the owner's "Hide source file"; the caller asks for confirmation.
 */
export function ClipMenu({
  assetName,
  onHideSource,
  className,
}: {
  assetName: string
  onHideSource: () => void
  className?: string
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label={`More actions for ${assetName}`}
        title="More"
        className={cn(
          'flex h-7 w-7 hover-none:h-10 hover-none:w-10 items-center justify-center rounded-md border border-border text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 data-[state=open]:bg-bg-hover data-[state=open]:text-text-primary',
          className,
        )}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className="z-[70] min-w-[13rem] max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-bg-secondary p-1 shadow-xl"
        >
          <DropdownMenu.Item
            onSelect={onHideSource}
            className="flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2 hover-none:py-3 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
          >
            <EyeOff className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
            <span className="min-w-0">
              <span className="block">Hide source file</span>
              <span className="block truncate text-xs text-text-tertiary" title={assetName}>
                {assetName}
              </span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
