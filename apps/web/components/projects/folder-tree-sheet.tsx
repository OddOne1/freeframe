'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, X } from 'lucide-react'
import { FolderTree } from './folder-tree'
import { cn } from '@/lib/utils'

/**
 * The folder tree as a sheet dropped from the top (§224).
 *
 * Below `xl` the 288px sidebar column is either gone (below `lg`, where
 * subfolders were unreachable altogether — the reported bug) or too wide to
 * justify (768–1279px). The owner's decision: the project/folder name at
 * the top becomes the way in — "Podcast ▾" opens the tree.
 *
 * It renders `FolderTree` itself, with the same props the sidebar passes,
 * so the rename / new subfolder / create-share-link menu (§223) and the
 * drag-drop targets come along unchanged. Nothing is forked: if the tree
 * grows a row type or a menu entry, this gets it for free.
 *
 * A Radix Dialog rather than a Popover: this is a sheet with a scrim that
 * can be most of the screen tall, and Dialog is the primitive that already
 * handles the scroll lock, the focus trap, Escape and the scrim click.
 */
export function FolderTreeSheet({
  label,
  className,
  ...treeProps
}: React.ComponentProps<typeof FolderTree> & {
  /** What the trigger shows — the open folder's name, or the project's. */
  label: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          data-testid="folder-tree-sheet-trigger"
          className={cn(
            // 44px tall: this is the primary navigation control on a phone.
            'flex h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-left',
            'text-[15px] font-semibold text-text-primary',
            'hover:bg-bg-hover transition-colors',
            className,
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-text-tertiary" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        {/* Anchored to the top, which is what "a dropdown from the top"
            means here, and capped so a deep tree scrolls rather than
            running off the bottom of the screen. */}
        <Dialog.Content
          data-testid="folder-tree-sheet"
          className="fixed inset-x-0 top-0 z-50 max-h-[80dvh] overflow-y-auto rounded-b-2xl border-b border-border bg-bg-secondary pb-3 shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-top-4 data-[state=open]:slide-in-from-top-4"
        >
          <div className="sticky top-0 flex h-11 items-center justify-between border-b border-border bg-bg-secondary px-4">
            <Dialog.Title className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              Folders
            </Dialog.Title>
            <Dialog.Close
              aria-label="Close folders"
              className="-mr-2 flex h-11 w-11 items-center justify-center text-text-tertiary transition-colors hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          {/* Selecting a folder closes the sheet — otherwise the tree stays
              over the grid it just navigated to. Wrapped rather than
              changed inside FolderTree, which has no business knowing it is
              in a sheet. */}
          <div className="p-3">
            <FolderTree
              {...treeProps}
              onSelectFolder={(id) => {
                treeProps.onSelectFolder(id)
                setOpen(false)
              }}
              onShowTrash={() => {
                treeProps.onShowTrash()
                setOpen(false)
              }}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
