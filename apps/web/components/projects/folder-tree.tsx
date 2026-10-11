'use client'

import React, { useState, useCallback } from 'react'
import {
  ChevronRight,
  FolderOpen,
  Folder as FolderIcon,
  Trash2,
  MoreHorizontal,
  Pencil,
  FolderPlus,
  Share2,
  Trash,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  CursorMenu,
  menuItemClass,
  menuItemDangerClass,
  type CursorMenuState,
} from '@/components/ui/cursor-menu'
import { cn } from '@/lib/utils'
import { dragCarriesFiles } from '@/hooks/use-file-drop-zone'
import { useFormatBytes } from '@/hooks/use-byte-units'
import type { FolderTreeNode } from '@/types'

/**
 * The ids from the top of the tree down to `folderId`, inclusive — the
 * chain that has to be open for that folder to be on screen at all.
 *
 * `[]` when there is no such folder: at the root (`null`), and on a cold
 * load, where the URL names a folder several seconds before `/folder-tree`
 * answers. The caller treats the empty result as "not yet", which is what
 * makes the deep-link case work rather than silently do nothing.
 */
export function folderPathIds(
  tree: FolderTreeNode[],
  folderId: string | null,
): string[] {
  if (!folderId) return []
  const walk = (nodes: FolderTreeNode[], trail: string[]): string[] | null => {
    for (const node of nodes) {
      const here = [...trail, node.id]
      if (node.id === folderId) return here
      const hit = walk(node.children, here)
      if (hit) return hit
    }
    return null
  }
  return walk(tree, []) ?? []
}

interface FolderTreeProps {
  tree: FolderTreeNode[]
  projectName: string
  currentFolderId: string | null // null = root
  showTrash: boolean
  onSelectFolder: (folderId: string | null) => void
  onShowTrash: () => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>
  onRenameFolder: (folderId: string, name: string) => Promise<void>
  onDeleteFolder: (folderId: string) => Promise<void>
  /** §223 — opens the project's own share dialog, preselected on this
   *  folder. Optional so a surface without share rights simply omits the
   *  menu entry rather than rendering one that cannot work. */
  onShareFolder?: (folderId: string, folderName: string) => void
  // Drag-drop targets
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
}

interface FolderNodeProps {
  node: FolderTreeNode
  depth: number
  currentFolderId: string | null
  /**
   * §227b — expansion is the TREE's state, not each row's.
   *
   * It was `useState(false)` per row, which is why an opened navigator
   * showed the project's top-level folders all collapsed while the bar
   * above it said `… / Video / Reaction_watchparty / Cam_B`: nothing had
   * ever told the rows that one of them was on the way to where you are.
   * A row cannot know that; only something holding the whole tree can.
   */
  isExpanded: (folderId: string) => boolean
  onToggleExpanded: (folderId: string) => void
  onSelectFolder: (folderId: string | null) => void
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>
  onRenameFolder: (folderId: string, name: string) => Promise<void>
  onDeleteFolder: (folderId: string) => Promise<void>
  onShareFolder?: (folderId: string, folderName: string) => void
  onDropItems?: (targetFolderId: string | null, assetIds: string[], folderIds: string[]) => void
}

function FolderNode({
  node,
  depth,
  currentFolderId,
  isExpanded,
  onToggleExpanded,
  onSelectFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
  onDropItems,
}: FolderNodeProps) {
  const formatBytes = useFormatBytes()
  // §223 — the menu's open state IS its anchor point, because there is no
  // separate closed/open position to keep in step: `null` is closed, a
  // coordinate pair is open there. Same shape the grid's context menus
  // already use, so one `CursorMenu` serves both the kebab button and
  // right-click without a second positioning path.
  const [menuAt, setMenuAt] = useState<CursorMenuState | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameName, setRenameName] = useState(node.name)
  const [isDragOver, setIsDragOver] = useState(false)
  const isActive = currentFolderId === node.id
  const expanded = isExpanded(node.id)

  const hasChildren = node.children.length > 0

  // Select and toggle, exactly as before — only WHERE the flag lives
  // changed. One consequence, named rather than discovered later: clicking
  // an already-open folder you are not yet in now navigates into it and it
  // stays open, because the seeding below re-adds the folder you are in.
  // You cannot be inside a folder and have its row closed, which is the
  // right answer; the row still collapses on a second click, once you are
  // there and the seeding has nothing new to say.
  const handleClick = useCallback(() => {
    onSelectFolder(node.id)
    if (hasChildren) onToggleExpanded(node.id)
  }, [node.id, hasChildren, onSelectFolder, onToggleExpanded])

  /**
   * §227b — the folder you are in is brought into view inside whatever is
   * scrolling, which below `xl` is the navigator's panel (`max-h` +
   * `overflow-y-auto`) and at `xl`+ is the sidebar column.
   *
   * `block: 'nearest'` is the whole point: it scrolls the closest
   * scrollable ancestor by the least amount that makes the row visible,
   * and does nothing at all when the row is already on screen — so the
   * desktop column, which is short enough not to scroll, does not move.
   * Optional-called because jsdom does not implement scrollIntoView
   * (measured), and a missing browser API must not break a render.
   */
  const rowRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!isActive) return
    rowRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [isActive])

  const handleRename = useCallback(async () => {
    if (renameName.trim() && renameName !== node.name) {
      await onRenameFolder(node.id, renameName.trim())
    }
    setRenaming(false)
  }, [renameName, node.id, node.name, onRenameFolder])

  // Drag-drop target
  const handleDragOver = useCallback((e: React.DragEvent) => {
      // §223 C.2 — an OS file drag is not an internal move, and the page
      // handles it. Without this guard a card dropped from Finder lit up
      // this ring as well as the page's own overlay, promising a move that
      // was never going to happen.
      if (dragCarriesFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setIsDragOver(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      if (dragCarriesFiles(e.dataTransfer)) return
      e.preventDefault()
      setIsDragOver(false)
      try {
        const data = JSON.parse(e.dataTransfer.getData('application/json'))
        onDropItems?.(node.id, data.assetIds ?? [], data.folderIds ?? [])
      } catch {
        // ignore
      }
    },
    [node.id, onDropItems],
  )

  return (
    <div>
      <div
        ref={rowRef}
        // The highlight is the two classes below; this says the same thing
        // where a test and a screen reader can both read it.
        aria-current={isActive ? 'true' : undefined}
        data-tree-folder={node.id}
        className={cn(
          'group flex items-center gap-1 px-2 py-1 rounded-md text-[13px] cursor-pointer transition-colors',
          isActive
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          isDragOver && 'ring-2 ring-accent/50 bg-accent/5',
        )}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuAt({ x: e.clientX, y: e.clientY })
        }}
      >
        {/* Expand chevron */}
        <span className={cn('shrink-0 transition-transform', expanded && 'rotate-90')}>
          {hasChildren ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <span className="w-3" />
          )}
        </span>

        {/* Icon */}
        {isActive || expanded ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        )}

        {/* Name */}
        {renaming ? (
          <input
            className="flex-1 min-w-0 bg-transparent border-b border-accent outline-none text-[13px] text-text-primary px-0.5"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRename()
              if (e.key === 'Escape') setRenaming(false)
            }}
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="truncate flex-1 min-w-0">{node.name}</span>
        )}

        {/* Item count */}
        {node.item_count > 0 && !renaming && (
          <span
            className="text-[10px] text-text-tertiary shrink-0"
            title={node.total_size_bytes > 0 ? formatBytes(node.total_size_bytes) : undefined}
          >
            {node.item_count}{node.total_size_bytes > 0 && ` · ${formatBytes(node.total_size_bytes)}`}
          </span>
        )}

        {/* Context menu button */}
        <button
          className="opacity-0 group-hover:opacity-100 shrink-0 h-5 w-5 hover-none:opacity-100 flex items-center justify-center rounded hover:bg-bg-hover transition-opacity"
          aria-label={`Folder options for ${node.name}`}
          onClick={(e) => {
            e.stopPropagation()
            // Anchored to the BUTTON's own box rather than the pointer, so
            // the popup lands in the same place however it was opened —
            // mouse, keyboard or touch. getBoundingClientRect returns
            // viewport coordinates, which is what CursorMenu's `fixed`
            // anchor expects; a scrolled sidebar needs no correction.
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setMenuAt({ x: r.left, y: r.bottom })
          }}
        >
          <MoreHorizontal className="h-3 w-3" />
        </button>
      </div>

      {/* §223 — a popup, not a block in the list.
          It used to render here, in normal flow, so opening it pushed every
          following folder (and this folder's own children) down by the
          menu's height: the row you were aiming at moved out from under the
          pointer. Portalled through CursorMenu, the list never reflows.

          CursorMenu is the project's existing Radix DropdownMenu wrapper
          (§28), so outside-click, Escape, focus trapping, arrow-key
          navigation and staying inside the viewport are all Radix's job
          here too — nothing about those is hand-rolled, and no new
          dependency was added. */}
      <CursorMenu state={menuAt} onClose={() => setMenuAt(null)} minWidth={176}>
        <DropdownMenu.Item
          className={menuItemClass}
          onSelect={() => {
            setRenaming(true)
            setRenameName(node.name)
          }}
        >
          <Pencil className="h-3.5 w-3.5" /> Rename
        </DropdownMenu.Item>
        <DropdownMenu.Item
          className={menuItemClass}
          onSelect={() => onCreateFolder('', node.id)}
        >
          <FolderPlus className="h-3.5 w-3.5" /> New Subfolder
        </DropdownMenu.Item>
        {onShareFolder && (
          <DropdownMenu.Item
            className={menuItemClass}
            onSelect={() => onShareFolder(node.id, node.name)}
          >
            <Share2 className="h-3.5 w-3.5" /> Create share link
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator className="my-1 border-t border-border" />
        <DropdownMenu.Item
          className={menuItemDangerClass}
          onSelect={() => {
            if (confirm(`Delete folder "${node.name}" and all its contents?`)) {
              void onDeleteFolder(node.id)
            }
          }}
        >
          <Trash className="h-3.5 w-3.5" /> Delete
        </DropdownMenu.Item>
      </CursorMenu>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <FolderNode
              key={child.id}
              node={child}
              depth={depth + 1}
              currentFolderId={currentFolderId}
              isExpanded={isExpanded}
              onToggleExpanded={onToggleExpanded}
              onSelectFolder={onSelectFolder}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onShareFolder={onShareFolder}
              onDropItems={onDropItems}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FolderTree({
  tree,
  projectName,
  currentFolderId,
  showTrash,
  onSelectFolder,
  onShowTrash,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
  onDropItems,
}: FolderTreeProps) {
  const [isDragOverRoot, setIsDragOverRoot] = useState(false)

  /**
   * §227b item 2 — the tree opens along the path to the folder you are in.
   *
   * The owner, from a real phone: inside "Video" (below `src`), the opened
   * navigator showed `Just Ride 2026` with `src` and `Podcast` both
   * collapsed — "the folder he is in is not visible and not highlighted".
   * Not the mock data: the mock tree contains exactly that chain. The
   * cause was that every row kept its own `useState(false)` and nothing
   * ever seeded it, in the navigator AND in the `xl`+ sidebar column,
   * which shares this component. So this is the one mechanism both get,
   * rather than a second implementation for the panel.
   *
   * Seeded ONCE per folder, not on every render of it:
   *
   *  - `tree` is SWR data, so its identity changes on every revalidation.
   *    Re-seeding on that would spring a folder the user had just
   *    collapsed back open, seconds later, for no reason they could see.
   *  - An empty path means the tree does not contain that folder YET — the
   *    deep-link case, where `?folder=` is known on the first render and
   *    `/folder-tree` answers later. Leaving `seeded` unset keeps trying
   *    until the tree arrives.
   *
   * Collapsing stays possible: the ids are only ever ADDED here, and
   * clicking a row still toggles it.
   */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(folderPathIds(tree, currentFolderId)),
  )
  const seededFor = React.useRef<string | null | undefined>(undefined)

  React.useEffect(() => {
    if (seededFor.current === currentFolderId) return
    const path = folderPathIds(tree, currentFolderId)
    if (currentFolderId !== null && path.length === 0) return
    seededFor.current = currentFolderId
    if (path.length === 0) return
    setExpandedIds((prev) => {
      if (path.every((id) => prev.has(id))) return prev
      const next = new Set(prev)
      for (const id of path) next.add(id)
      return next
    })
  }, [tree, currentFolderId])

  const isExpanded = useCallback((id: string) => expandedIds.has(id), [expandedIds])

  const onToggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  return (
    <div className="space-y-0.5">
      {/* Project root */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] cursor-pointer transition-colors',
          currentFolderId === null && !showTrash
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
          isDragOverRoot && 'ring-2 ring-accent/50 bg-accent/5',
        )}
        onClick={() => onSelectFolder(null)}
        onDragOver={(e) => {
          if (dragCarriesFiles(e.dataTransfer)) return
          e.preventDefault()
          setIsDragOverRoot(true)
        }}
        onDragLeave={() => setIsDragOverRoot(false)}
        onDrop={(e) => {
          if (dragCarriesFiles(e.dataTransfer)) return
          e.preventDefault()
          setIsDragOverRoot(false)
          try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'))
            onDropItems?.(null, data.assetIds ?? [], data.folderIds ?? [])
          } catch {}
        }}
      >
        <FolderOpen className="h-4 w-4 shrink-0" />
        <span className="truncate">{projectName}</span>
      </div>

      {/* Folder tree */}
      {tree.map((node) => (
        <FolderNode
          key={node.id}
          node={node}
          depth={1}
          currentFolderId={currentFolderId}
          isExpanded={isExpanded}
          onToggleExpanded={onToggleExpanded}
          onSelectFolder={onSelectFolder}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onShareFolder={onShareFolder}
          onDropItems={onDropItems}
        />
      ))}

      {/* Recently Deleted */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1 rounded-md text-[13px] cursor-pointer transition-colors mt-2',
          showTrash
            ? 'bg-accent/10 text-accent font-medium'
            : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover',
        )}
        onClick={onShowTrash}
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" />
        <span>Recently Deleted</span>
      </div>
    </div>
  )
}
