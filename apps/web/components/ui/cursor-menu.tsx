'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

/**
 * A Radix DropdownMenu opened at a cursor position (CLAUDE.md §28).
 *
 * Radix's purpose-built primitive for this is `@radix-ui/react-context-menu`,
 * which is NOT installed here — only `react-dropdown-menu` is. Adding it
 * would mean a lockfile change, and a dependency change to apps/web is
 * exactly what left the production `web` image unbuildable for eleven days
 * in §13c. So this uses the supported alternative instead: a real, empty
 * trigger element positioned at the cursor, which Radix then anchors to.
 *
 * This is anchoring, not hand-rolled positioning — collision detection,
 * flipping near a screen edge, focus handling, Escape and outside-click all
 * remain Radix's job. The only thing supplied is where to point at.
 */
export interface CursorMenuState {
  x: number
  y: number
}

export function CursorMenu({
  state,
  onClose,
  children,
  minWidth = 200,
}: {
  state: CursorMenuState | null
  onClose: () => void
  children: React.ReactNode
  minWidth?: number
}) {
  return (
    <DropdownMenu.Root
      open={state !== null}
      onOpenChange={(open) => { if (!open) onClose() }}
      modal={false}
    >
      <DropdownMenu.Trigger asChild>
        {/* Zero-size and invisible: it exists only to give Radix an anchor
            at the pointer. `fixed` because the coordinates are viewport
            ones, so a scrolled grid can't drag the menu out of place. */}
        <span
          aria-hidden
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          side="bottom"
          sideOffset={2}
          style={{ minWidth }}
          className="z-[100] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

/** Shared row styling, so every menu in this family looks identical. */
export const menuItemClass =
  'flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors'

export const menuItemDangerClass =
  'flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors'
