'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Share2, Download, Link as LinkIcon, Pencil, Trash2 } from 'lucide-react'
import { menuItemClass, menuItemDangerClass } from '@/components/ui/cursor-menu'

/**
 * The single-asset action list, shared by the card's "..." button and its
 * right-click menu (CLAUDE.md §28).
 *
 * Extracted rather than duplicated: the requirement is that right-click
 * offers exactly what the kebab offers, and two copies of a menu drift.
 * One list means they cannot.
 *
 * Each item renders only when its handler exists. The grid passes
 * `undefined` for actions the current role can't perform, so this is also
 * what keeps both surfaces permission-correct — see page.tsx's
 * canShare/canEditAssets gates.
 */
export interface AssetMenuActions {
  onShare?: () => void
  onDownload?: () => void
  onRename?: () => void
  onDelete?: () => void
  /** Absent server-side rendering, where window.location has no origin. */
  assetUrl?: string | null
}

export function AssetMenuItems({ onShare, onDownload, onRename, onDelete, assetUrl }: AssetMenuActions) {
  const canCopyUrl = Boolean(assetUrl)
  // A separator above nothing is a stray line; each group tracks whether
  // anything before it actually rendered.
  const hasTop = Boolean(onShare)
  const hasMiddle = Boolean(onDownload) || canCopyUrl
  const hasBottom = Boolean(onRename) || Boolean(onDelete)

  return (
    <>
      {onShare && (
        <DropdownMenu.Item onSelect={onShare} className={menuItemClass}>
          <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
          Create Share Link
        </DropdownMenu.Item>
      )}

      {hasTop && hasMiddle && <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />}

      {onDownload && (
        <DropdownMenu.Item onSelect={onDownload} className={menuItemClass}>
          <Download className="h-3.5 w-3.5 text-text-tertiary" />
          Download
        </DropdownMenu.Item>
      )}
      {canCopyUrl && (
        <DropdownMenu.Item
          onSelect={() => { navigator.clipboard.writeText(assetUrl as string) }}
          className={menuItemClass}
        >
          <LinkIcon className="h-3.5 w-3.5 text-text-tertiary" />
          Copy Asset URL
        </DropdownMenu.Item>
      )}

      {(hasTop || hasMiddle) && hasBottom && (
        <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />
      )}

      {onRename && (
        <DropdownMenu.Item onSelect={onRename} className={menuItemClass}>
          <Pencil className="h-3.5 w-3.5 text-text-tertiary" />
          Rename
        </DropdownMenu.Item>
      )}
      {onDelete && (
        <DropdownMenu.Item onSelect={onDelete} className={menuItemDangerClass}>
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </DropdownMenu.Item>
      )}
    </>
  )
}
