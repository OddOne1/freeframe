'use client'

import * as React from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { X, Download, MoreHorizontal, Layers, Share2, Trash2, FolderInput, FolderIcon, Check, Film, Music, Image as ImageIcon, Images, Pencil, FolderPlus, Upload, CheckSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFormatBytes } from '@/hooks/use-byte-units'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/shared/avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { AssetCard } from './asset-card'
import { AssetMenuItems } from './asset-menu-items'
import { CursorMenu, menuItemClass, menuItemDangerClass, type CursorMenuState } from '@/components/ui/cursor-menu'
import { FolderCard } from './folder-card'
import { FolderBackButton, type BackTarget } from './folder-back-button'
import { AppearancePopover } from './appearance-popover'
import { SortPopover } from './sort-popover'
import { MoveToDialog } from './move-to-dialog'
import { useViewStore } from '@/stores/view-store'
import { usePointerGesture, cardKeyIntent } from '@/hooks/use-pointer-gesture'
import type { Asset, AssetStatus, User, Folder, FolderTreeNode } from '@/types'

const assetTypeIcons: Record<string, React.ElementType> = {
  video: Film,
  audio: Music,
  image: ImageIcon,
  image_carousel: Images,
}

const statusOrder: Record<AssetStatus, number> = {
  in_review: 0,
  in_progress: 1,
  draft: 2,
  approved: 3,
  rejected: 4,
  archived: 5,
}

interface AssetGridProps {
  assets: Asset[]
  projectId: string
  isLoading?: boolean
  assignees?: Record<string, User>
  thumbnails?: Record<string, string>
  versionCounts?: Record<string, number>
  authorNames?: Record<string, string>
  fileSizes?: Record<string, number>
  /** asset id -> folder path label (e.g. "Test / Sub"), used when Flatten Folders is on */
  folderPaths?: Record<string, string>
  onUpload?: () => void
  /**
   * §232 item 2 — there is no `onAssetSelect` / `selectedAssetId` pair any
   * more. They existed to feed the project view's right panel: a plain
   * click told the page which asset to inspect, and the page rang the
   * selected card. With the panel gone and a plain click opening the
   * asset, nothing is left to tell and nothing to ring. Multi-selection
   * (the checkbox, cmd, shift) is this component's own state, as it
   * always was, and the bulk bar is still its one readout.
   */
  onAssetOpen?: (asset: Asset) => void
  folders?: Folder[]
  currentFolderId?: string | null
  onFolderOpen?: (folder: Folder) => void
  onFolderRename?: (folderId: string, name: string) => Promise<void>
  onFolderDelete?: (folderId: string) => Promise<void>
  // §223 — `void`, not `Promise<void>`: nothing here awaits it, and the
  // single page-level handler that both folder menus now share is a
  // plain state update.
  onFolderShare?: (folderId: string, folderName: string) => void
  onDropToFolder?: (targetFolderId: string, assetIds: string[], folderIds: string[]) => void
  /** Share selection mode */
  shareMode?: boolean
  onShareModeChange?: (active: boolean) => void
  onCreateShareLink?: (selectedAssetIds: string[], selectedFolderIds: string[]) => void
  /** Bulk actions */
  onBulkDelete?: (assetIds: string[], folderIds: string[]) => void
  onBulkMove?: (assetIds: string[], folderIds: string[], targetFolderId: string | null) => void
  onBulkDownload?: (assetIds: string[], folderIds: string[]) => void
  /** Empty-canvas right-click → New Folder (§28). Supplied only when the
   *  role may create one, mirroring the toolbar's canCreateFolder gate. */
  onNewFolder?: () => void
  projectName?: string
  folderTree?: FolderTreeNode[]
  onAssetShare?: (asset: Asset) => void
  onAssetDownload?: (asset: Asset) => void
  onAssetRename?: (asset: Asset) => void
  onAssetDelete?: (asset: Asset) => void
  /** Actions rendered on the right side of the navigator bar */
  actions?: React.ReactNode
  /**
   * §228d item 3 — where "up one level" goes, or nothing.
   *
   * Passed in rather than worked out here: the parent is read off the
   * project page's `folderTrail`, which is the one walk of the tree the
   * breadcrumb and the folder navigator already share (§227). A second
   * lookup in this component would be a second answer to "what is the
   * parent" waiting to disagree with them.
   *
   * Optional, so the /assets page — one flat list of every asset in every
   * project, with no folder to be above — renders exactly what it did.
   */
  backTo?: BackTarget
  /** Whether the current user can vote (reviewer role or higher) */
  canVote?: boolean
  onAssetVote?: (asset: Asset, stars: number) => void
}

/**
 * Column counts live in app/globals.css as CONTAINER queries, keyed off
 * `data-size` (§50). They used to be Tailwind `grid-cols-N` classes keyed to
 * the viewport, which is what made a card shrink when the 360px side panel
 * opened: the column count stayed put while the container lost 360px, so
 * every 1fr track narrowed.
 *
 * XS is denser than S at every breakpoint (§51); the numbers moved to CSS
 * unchanged.
 *
 * The tradeoff is real and worth naming: holding card size constant in less
 * width means the column count drops instead — fewer cards visible and more
 * scrolling when the panel is open. That is the direction that was asked
 * for, but it is a trade, not a free win.
 */
const gridClass = 'asset-grid'

// Aspect ratio classes
const aspectMap = {
  landscape: 'aspect-[16/10]',
  square: 'aspect-square',
  portrait: 'aspect-[3/4]',
}

export function AssetGrid({
  assets,
  projectId,
  isLoading = false,
  assignees = {},
  thumbnails = {},
  versionCounts = {},
  authorNames = {},
  fileSizes = {},
  folderPaths = {},
  onUpload,
  onAssetOpen,
  folders,
  currentFolderId,
  onFolderOpen,
  onFolderRename,
  onFolderDelete,
  onFolderShare,
  onDropToFolder,
  shareMode = false,
  onShareModeChange,
  onCreateShareLink,
  onBulkDelete,
  onBulkMove,
  onBulkDownload,
  onNewFolder,
  projectName = 'Project',
  folderTree = [],
  onAssetShare,
  onAssetDownload,
  onAssetRename,
  onAssetDelete,
  actions,
  backTo,
  canVote = false,
  onAssetVote,
}: AssetGridProps) {
  const formatBytes = useFormatBytes()
  /**
   * §232 item 1 — one click opens, whatever made it; one click toggles
   * once a selection exists; a click that ended a drag does nothing.
   *
   * ONE instance for every card and row this grid renders: the gesture
   * being judged is the one in flight, and there is only ever one of
   * those. See hooks/use-pointer-gesture.ts.
   */
  const gesture = usePointerGesture()
  const [selectedAssetIds, setSelectedAssetIds] = React.useState<Set<string>>(new Set())
  const [selectedFolderIds, setSelectedFolderIds] = React.useState<Set<string>>(new Set())
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false)
  /**
   * §99 — the anchor a shift-click measures its range from.
   *
   * Set by every deliberate single-item click, modified or not, which is
   * what makes a second shift-click extend from where you last were rather
   * than from wherever the previous range happened to end.
   */
  const [lastClickedId, setLastClickedId] = React.useState<string | null>(null)

  /**
   * Right-click menu state (§28). Lives here, not on the card, because the
   * only thing that knows the current multi-selection is the grid — and
   * what a right-click should act on depends entirely on that.
   */
  const [contextMenu, setContextMenu] = React.useState<
    (CursorMenuState & { mode: 'asset' | 'bulk' | 'canvas'; asset?: Asset }) | null
  >(null)

  // Legacy alias
  const selectedIds = selectedAssetIds

  // Clear selection when share mode changes
  React.useEffect(() => {
    if (!shareMode) return
    setSelectedAssetIds(new Set())
    setSelectedFolderIds(new Set())
  }, [shareMode])

  const {
    layout,
    cardSize,
    aspectRatio,
    thumbnailScale,
    showCardInfo,
    titleLines,
    flattenFolders,
    setFlattenFolders,
    showFileSize,
    showUploader,
    sortKey,
    sortDirection,
  } = useViewStore()

  const toggleAssetSelect = (assetId: string) => {
    setSelectedAssetIds((prev) => {
      const next = new Set(prev)
      if (next.has(assetId)) next.delete(assetId)
      else next.add(assetId)
      return next
    })
  }

  const toggleFolderSelect = (folderId: string) => {
    setSelectedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  /** useCallback so the navigation effect below can depend on it honestly.
   *  A plain function is a new identity every render, and an effect keyed on
   *  that would clear the selection on every render — i.e. make selecting
   *  anything impossible. The three setters are stable by React's contract,
   *  so the empty dep list is correct rather than a lie. */
  const clearSelection = React.useCallback(() => {
    setSelectedAssetIds(new Set())
    setSelectedFolderIds(new Set())
    setLastClickedId(null)
  }, [])

  /**
   * A selection belongs to the folder it was made in.
   *
   * Selecting three clips in A and navigating to B used to leave those ids
   * in state: the bulk bar stayed up claiming "3 Items selected" with
   * nothing on screen selected, and Download/Move/Delete would then act on
   * files the user could no longer see. Nothing cleared it — the only
   * existing reset was the shareMode effect above.
   *
   * `projectId` is in the deps as well as `currentFolderId`, because this
   * grid can outlive a project switch. Neither mount site passes
   * `key={projectId}`, and the project page reads its id from `useParams()`
   * — so /projects/A -> /projects/B is a same-route transition that React
   * reconciles into the SAME component instance. That is the identical
   * trap §29 documented for `currentFolderId` itself, one level up.
   *
   * Clearing on mount (when both are first defined) is a deliberate no-op:
   * the sets are already empty then.
   */
  React.useEffect(() => {
    clearSelection()
  }, [currentFolderId, projectId, clearSelection])

  /**
   * Standard desktop right-click semantics (§28):
   *
   *  - on an asset already in the selection  -> act on the whole selection
   *  - on an asset outside it                -> REPLACE the selection with
   *                                             just that asset, then act
   *                                             on it alone
   *
   * The second rule is the one that is easy to skip and surprising to
   * lose: without it, right-clicking a different asset would silently
   * operate on whatever was selected before.
   */
  const handleAssetContextMenu = (asset: Asset, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const inSelection = selectedAssetIds.has(asset.id)
    if (inSelection && selectedAssetIds.size + selectedFolderIds.size > 1) {
      setContextMenu({ x: e.clientX, y: e.clientY, mode: 'bulk' })
      return
    }
    if (!inSelection) {
      setSelectedAssetIds(new Set([asset.id]))
      setSelectedFolderIds(new Set())
    }
    setContextMenu({ x: e.clientX, y: e.clientY, mode: 'asset', asset })
  }

  const totalSelected = selectedAssetIds.size + selectedFolderIds.size

  /**
   * §227b, extended to every pointer by §232 — once anything is selected,
   * a CLICK toggles instead of opening.
   *
   * The standard multi-select rule, and the one that makes single-click
   * open safe rather than destructive: the checkbox (or cmd-click) starts
   * a selection, and from then on the whole card is the toggle, until the
   * selection is cleared with Escape, the bulk bar's ✕, or a click on
   * empty space. Nothing can navigate away from a selection by accident.
   *
   * Share mode counts as a selection for assets — it is a selection mode,
   * and a click that navigated into the viewer would make picking what to
   * share impossible. For FOLDERS it does not, because in share mode the
   * wrapper below already owns the folder toggle; counting it twice would
   * toggle and untoggle in one click.
   */
  const tapTogglesAssets = shareMode || totalSelected > 0
  const tapTogglesFolders = !shareMode && totalSelected > 0

  const selectedTotalSize = Array.from(selectedAssetIds).reduce((sum, id) => sum + (fileSizes[id] ?? 0), 0)

  const filtered = React.useMemo(() => {
    let result = [...assets]

    if (sortKey !== 'custom') {
      result.sort((a, b) => {
        let cmp = 0
        if (sortKey === 'date') {
          cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
        } else if (sortKey === 'name') {
          cmp = a.name.localeCompare(b.name)
        } else if (sortKey === 'status') {
          cmp = statusOrder[a.status] - statusOrder[b.status]
        } else if (sortKey === 'type') {
          cmp = a.asset_type.localeCompare(b.asset_type)
        } else if (sortKey === 'votes') {
          cmp = (a.avg_rating ?? 0) - (b.avg_rating ?? 0)
        }
        return sortDirection === 'asc' ? cmp : -cmp
      })
    }

    return result
  }, [assets, sortKey, sortDirection])

  const showFolders = !flattenFolders && folders && folders.length > 0

  /**
   * §101 — the modifier half of a click, shared by every entry point.
   *
   * Returns true when a modifier was held and the selection has been
   * changed; false for a plain click, which each caller then finishes in
   * its own way. That split is the whole point: a plain click on the card
   * body now OPENS the asset (§232) and the checkbox must never do that,
   * but shift and cmd have to mean the same thing on both — and must
   * never open, which is what makes a selection buildable with a mouse.
   *
   * §99 put this logic only on the card body. The checkbox — the visible
   * "select" control, and the more natural target — silently plain-toggled
   * whatever was held, in two separate implementations that each ignored
   * the event.
   */
  const applyModifierSelection = (asset: Asset, e: React.MouseEvent): boolean => {
    if (e.shiftKey) {
      // Stops the browser turning a shift-click near text into a text
      // selection sweep across the page.
      e.preventDefault()
      const ids = filtered.map((a) => a.id)
      const to = ids.indexOf(asset.id)
      const from = lastClickedId ? ids.indexOf(lastClickedId) : -1
      setSelectedAssetIds((prev) => {
        const next = new Set(prev)
        if (to < 0) return next
        // No anchor yet — nothing has been clicked, or the anchor has been
        // filtered out from under us. Behaves as a plain single-select
        // rather than doing nothing, which would read as a broken click.
        if (from < 0) {
          next.add(asset.id)
          return next
        }
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        for (let i = lo; i <= hi; i++) next.add(ids[i])
        return next
      })
      // ADDITIVE, and the range is measured over `filtered` — the array
      // actually rendered, in the active sort order. Over the raw `assets`
      // prop a range would join whatever happens to sit between them in
      // load order, which is not what is on screen under any non-default
      // sort.
      //
      // Re-anchoring here is for consistency rather than observable
      // behaviour: because ranges are additive, the union of
      // range(anchor, x) with what is already selected is the same
      // whichever of two already-selected endpoints the anchor is. It is
      // kept because the alternative — an anchor that only some clicks
      // move — is the kind of rule that becomes wrong the moment ranges
      // stop being purely additive.
      setLastClickedId(asset.id)
      return true
    }
    if (e.metaKey || e.ctrlKey) {
      toggleAssetSelect(asset.id)
      setLastClickedId(asset.id)
      return true
    }
    return false
  }

  /**
   * A click on the card BODY or a list ROW, in either layout (§232 item 1).
   *
   * ONE function for all four surfaces. §227b had the rule written out
   * inline at each of them, which is how the folder row ended up with a
   * different answer from the folder card; there is one answer left to get
   * wrong now.
   *
   * Order matters and is the whole safety argument:
   *   1. a drag, or the tail of a double-click -> nothing at all
   *   2. a modified click -> selection only, never an open
   *   3. a selection is on screen -> toggle, never an open
   *   4. otherwise -> open
   */
  const handleAssetActivate = (asset: Asset, e: React.MouseEvent) => {
    const intent = gesture.tapIntent(e, { selectionActive: tapTogglesAssets })
    if (intent === 'ignore') return
    if (applyModifierSelection(asset, e)) return
    if (intent === 'toggle') {
      toggleAssetSelect(asset.id)
      setLastClickedId(asset.id)
      return
    }
    onAssetOpen?.(asset)
  }

  /** The same for a folder row. Folders have no range of their own — the
   *  shift range is measured over the rendered ASSET list — so a modified
   *  click toggles rather than ranging. */
  const handleFolderActivate = (folder: Folder, e: React.MouseEvent) => {
    const intent = gesture.tapIntent(e, { selectionActive: tapTogglesFolders })
    if (intent === 'ignore') return
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      e.preventDefault()
      toggleFolderSelect(folder.id)
      return
    }
    if (intent === 'toggle') { toggleFolderSelect(folder.id); return }
    onFolderOpen?.(folder)
  }

  /**
   * A click on the selection CHECKBOX, in either view.
   *
   * Never opens the side panel, under any modifier or none — that is the
   * one behaviour that has to stay checkbox-specific no matter how much of
   * the rest is shared.
   */
  const handleCheckboxClick = (asset: Asset, e: React.MouseEvent) => {
    if (applyModifierSelection(asset, e)) return
    toggleAssetSelect(asset.id)
    setLastClickedId(asset.id)
  }

  /**
   * §99 — "all" means all VISIBLE.
   *
   * Over `filtered` because that is the rendered list. Worth being exact
   * about what that does and does not buy: `filtered` only SORTS — the
   * search and status filters live in page.tsx and narrow `assets` before
   * it ever arrives here. So today this selects the same SET as the raw
   * prop would, and the guarantee §99 asks for ("all visible, not all in
   * the project") is delivered upstream, not by this line. It reads from
   * the rendered list anyway, so it stays correct if filtering ever moves
   * into this component.
   *
   * Folders are included when they are actually on screen. Bulk delete and
   * move already accept both, and a Select All that quietly skipped the
   * folders sitting right above the assets would be lying about the word.
   * `showFolders` is the same condition that renders them, so a flattened
   * view selects only assets.
   */
  const selectAllVisible = React.useCallback(() => {
    setSelectedAssetIds(new Set(filtered.map((a) => a.id)))
    setSelectedFolderIds(new Set(showFolders ? folders!.map((f) => f.id) : []))
  }, [filtered, showFolders, folders])

  /**
   * Cmd/Ctrl+A, scoped so it never steals a real field's select-all.
   *
   * A `window` listener is the right place — the grid has no focusable
   * container of its own, and scoping to one would mean the shortcut only
   * worked after clicking the grid, which is not how select-all behaves
   * anywhere else. The guard is on what currently has focus instead.
   */
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'a' && e.key !== 'A') return
      if (!(e.metaKey || e.ctrlKey)) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (shareMode) return
      e.preventDefault()
      selectAllVisible()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectAllVisible, shareMode])

  /**
   * Escape clears the selection (§232 item 1).
   *
   * NEW — it did nothing before. It is listed as one of the things that
   * "must stay possible", and single-click open is what makes it matter:
   * a selection now changes what every click in the view does, so there
   * has to be a one-key way out of that mode. The bulk bar's ✕ was the
   * only one.
   *
   * It yields to anything that owns Escape more strongly: an open dialog
   * (Move to…, rename, delete) or an open menu should close on Escape,
   * not have the selection pulled out from under the thing it is about
   * to act on. `preventDefault` is deliberately NOT called, so Radix's
   * own document-level handlers are untouched either way.
   */
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="dialog"],[role="menu"],[role="alertdialog"]')) return
      const el = document.activeElement as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      clearSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clearSelection])


  /**
   * The head of the content column: the toolbar row, then Back (§228e).
   *
   * ONE definition and ONE render site for the button, rather than two
   * copies toggled with `hidden`/`md:hidden`. A duplicate is a duplicate
   * DOM node, a duplicate tab stop and a duplicate `data-testid`, and the
   * two copies drift the first time one of them is edited. Here Back comes
   * after the toolbar in DOM order at EVERY width, so DOM order, tab order
   * and visual order are the same order.
   *
   * Below `md` the toolbar row is `display: none` (§224b), and a
   * `display: none` child of a `gap-3` flex column contributes neither a
   * box nor a gap — so the phone layout is exactly what it was: Back, then
   * "5 FOLDERS". At `md`+ the two swap places, and because the column's
   * gap is the same 12px above and below, the first card lands on the same
   * pixel it did before.
   *
   * Rendered by the loaded view AND by the loading skeleton below, so
   * grid, list, empty folder and skeleton cannot place Back differently:
   * there is only one placement left to get wrong.
   */
  const columnHead = (
    <>
      {/* ─── Navigator Bar (Frame.io style) ─────────────────────────────── */}
      {!shareMode && (
        <div
          data-testid="navigator-bar"
          className={cn(
            // §224b — `hidden md:flex`, not `flex`. Below `md` every child
            // of this bar is itself hidden (the two popovers live in the
            // phone Settings tab, the actions in the project header's
            // "···" menu), so what rendered on a phone was an empty row
            // with a bottom border: a divider band with nothing in it
            // between the folder name and "3 FOLDERS".
            'hidden md:flex items-center gap-1 flex-wrap border-b border-border pb-2.5',
            // The container-query steps in globals.css only make sense
            // when there is an action group to make room for; the /assets
            // page renders this bar without one and should keep the plain
            // single row at every width.
            actions && 'toolbar-crowded',
          )}
        >
          {/* Left group: Appearance + Fields + Sort.
              §224 — hidden below `md`: these two popovers are the phone
              Settings tab's contents, which renders the SAME controls
              rather than a second set, so showing them here as well would
              be two routes to one setting on the smallest screen. */}
          {/* `md:contents` rather than `md:flex`: at `md`+ the wrapper
              dissolves and these three become direct flex children of the
              bar again, exactly as before — a real flex wrapper added its
              own gap and shifted the row 4px, which a desktop that must
              look unchanged cannot afford.
              §224b — `toolbar-left` gives the narrow container-query step
              something to materialise the box for: `display: contents`
              becomes a real flex column so Appearance sits above Sort.
              The class carries no styles of its own, so the wide case is
              still exactly `display: contents`. */}
          <div className="toolbar-left hidden md:contents">
            <AppearancePopover />

            <div className="toolbar-divider h-4 w-px bg-border mx-0.5" />

            <SortPopover />
          </div>

          <div className="flex-1" />

          {/* Right group: action buttons passed from parent */}
          {actions && (
            <div className="toolbar-actions flex items-center gap-2">
              {actions}
            </div>
          )}
        </div>
      )}

      {/* ─── Up one level (§228d item 3, moved by §228e) ───────────────
          Directly BELOW the toolbar row and its divider line, directly
          ABOVE the first label ("5 FOLDERS"), the first row or the empty
          state. §228d had it above the toolbar, which on a phone is the
          same place — the toolbar row is `hidden md:flex` there, so Back
          still lands right above "5 FOLDERS" — but at `md`+ it put a
          control that belongs to the folder you are IN above a row of
          page chrome. The owner asked for it under the line.

          `self-start` and `w-fit`: in a `flex-col` the default would
          stretch it across the column and give it a 390px hover target. */}
      {backTo && <FolderBackButton {...backTo} />}
    </>
  )

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {/* The same head as the loaded view, in the same order, so neither
            Back nor the first row of cards jumps the moment the assets
            arrive. The toolbar's own controls (Appearance, Sort, and the
            actions passed in) read no asset data, so they are usable while
            the grid loads instead of appearing a beat later and pushing
            everything down. */}
        {columnHead}
        <div className={cn(gridClass, 'gap-4')} data-size={cardSize}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className={cn('animate-pulse rounded-lg bg-bg-tertiary', aspectMap[aspectRatio])} />
              <div className="h-4 w-3/4 animate-pulse rounded bg-bg-tertiary" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-bg-tertiary" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const selectedAssetList = () => Array.from(selectedAssetIds)
  const selectedFolderList = () => Array.from(selectedFolderIds)

  return (
    <div
      className="flex flex-col gap-3 relative"
      /**
       * A click on genuinely empty space clears the selection (§232
       * item 1). NEW — nothing cleared it before except the bulk bar's ✕
       * and a folder change.
       *
       * The same "is this actually blank?" test the right-click handler
       * below uses, widened to the list rows and to anything
       * interactive: the bulk bar, the share bar and the toolbar popovers
       * are all children of this element, and a click on one of them is
       * not a click on the canvas. It only ever CLEARS, so the worst a
       * missed case can do is leave a selection standing.
       */
      onClick={(e) => {
        if (totalSelected === 0) return
        const target = e.target as HTMLElement
        if (
          target.closest(
            '[data-asset-card],[data-folder-card],[data-asset-row],[data-folder-row],' +
            'button,a,input,textarea,select,label,[role="menu"],[role="dialog"]',
          )
        ) {
          return
        }
        clearSelection()
      }}
      onContextMenu={(e) => {
        // Only genuinely empty space. A right-click on a card is handled by
        // the card's own handler, which stops propagation — but a click on
        // a folder tile or the selection bar must not be mistaken for
        // canvas either, so this checks what was actually hit.
        const target = e.target as HTMLElement
        if (target.closest('[data-asset-card],[data-folder-card],[data-no-canvas-menu]')) return
        // Nothing to offer means no menu at all, rather than an empty box.
        if (!onNewFolder && !onUpload) return
        e.preventDefault()
        setContextMenu({ x: e.clientX, y: e.clientY, mode: 'canvas' })
      }}
    >
      {/* ─── Share Selection Mode Bar ──────────────────────────────────── */}
      {shareMode && (
        <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 px-4 py-2.5">
          <span className="text-sm font-medium text-text-primary">
            Select items to share
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                clearSelection()
                onShareModeChange?.(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={totalSelected === 0}
              onClick={() => {
                onCreateShareLink?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
                clearSelection()
                onShareModeChange?.(false)
              }}
            >
              Create Share Link
            </Button>
          </div>
        </div>
      )}

      {columnHead}

      {/* ─── Grid view: folders section ──────────────────────────────── */}
      {showFolders && layout === 'grid' && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
              {folders!.length} {folders!.length === 1 ? 'Folder' : 'Folders'}
            </span>
          </div>
          <div className={cn(gridClass, 'gap-3')} data-size={cardSize}>
            {folders!.map((folder) => {
              const isFolderSelected = selectedFolderIds.has(folder.id)
              return (
                <div
                  key={folder.id}
                  className={cn(
                    'group/folder relative',
                    isFolderSelected && 'ring-2 ring-accent rounded-lg',
                  )}
                  onClick={shareMode ? (e) => { e.stopPropagation(); toggleFolderSelect(folder.id) } : undefined}
                >
                  <button
                    // §227b — the folder card's checkbox gets the asset
                    // card's treatment: a name, so a test and a screen
                    // reader can both find it, and a 44px hit area around
                    // the 20px box.
                    aria-label={isFolderSelected ? `Deselect ${folder.name}` : `Select ${folder.name}`}
                    className={cn(
                      'tap-target-44 absolute top-2 left-2 z-10 h-5 w-5 rounded border flex items-center justify-center transition-all',
                      isFolderSelected
                        ? 'bg-accent border-accent text-white opacity-100'
                        : 'bg-black/40 border-white/30 text-transparent opacity-0 group-hover/folder:opacity-100 hover-none:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleFolderSelect(folder.id) }}
                  >
                    {isFolderSelected && <Check className="h-3 w-3" />}
                  </button>
                  <FolderCard
                    folder={folder}
                    onOpen={shareMode ? () => {} : onFolderOpen!}
                    // §232 item 1 — one click opens a folder card the way
                    // it opens an asset card, on every pointer. The card
                    // itself decides, because the gesture lands on IT.
                    selectionActive={tapTogglesFolders}
                    onToggleSelect={shareMode ? undefined : () => toggleFolderSelect(folder.id)}
                    onRename={shareMode ? undefined : onFolderRename}
                    onDelete={shareMode ? undefined : onFolderDelete}
                    onShare={shareMode ? undefined : onFolderShare}
                    onDropItems={shareMode ? undefined : onDropToFolder}
                  />
                </div>
              )
            })}
          </div>
          {filtered.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-text-tertiary font-medium uppercase tracking-wider">
                {filtered.length} {filtered.length === 1 ? 'Asset' : 'Assets'}
              </span>
            </div>
          )}
        </>
      )}

      {/* ─── Assets (grid) ───────────────────────────────────────────── */}
      {filtered.length === 0 && (!folders || folders.length === 0) ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Layers}
            title="No assets"
            description="Upload your first asset to get started."
            action={onUpload ? { label: 'Upload', onClick: onUpload } : undefined}
          />
        </div>
      ) : filtered.length === 0 && flattenFolders && folders && folders.length > 0 ? (
        <div className="rounded-lg border border-border bg-bg-secondary">
          <EmptyState
            icon={Layers}
            title={`${folders.length} folder${folders.length === 1 ? '' : 's'} hidden by Flatten Folders`}
            description="Turn off Flatten Folders in Appearance to see and open them."
            action={{ label: 'Show Folders', onClick: () => setFlattenFolders(false) }}
          />
        </div>
      ) : layout === 'grid' && filtered.length > 0 ? (
        <div className={cn(gridClass, 'gap-3')} data-size={cardSize}>
          {filtered.map((asset) => (
            <div
              key={asset.id}
              className="rounded-lg transition-all cursor-pointer"
              // §232 item 1 — one click opens the asset, whatever made the
              // click. The pointer-down position is recorded here and read
              // by the click that follows, so a drag that ends on this card
              // cannot be mistaken for a click on it. No `onDoubleClick`:
              // the first click has already opened it.
              onPointerDown={gesture.onPointerDown}
              onClick={(e) => handleAssetActivate(asset, e)}
              tabIndex={0}
              onKeyDown={(e) => {
                const intent = cardKeyIntent(e)
                if (intent === 'open') onAssetOpen?.(asset)
                else if (intent === 'toggle') { toggleAssetSelect(asset.id); setLastClickedId(asset.id) }
              }}
            >
              <AssetCard
                asset={asset}
                projectId={projectId}
                versionCount={versionCounts[asset.id]}
                assignee={asset.assignee_id ? assignees[asset.assignee_id] : null}
                authorName={asset.created_by_name ?? (asset.created_by ? authorNames[asset.created_by] : undefined)}
                thumbnailUrl={thumbnails[asset.id]}
                fileSize={fileSizes[asset.id] ?? null}
                selected={selectedAssetIds.has(asset.id)}
                onSelect={(e) => handleCheckboxClick(asset, e)}
                showInfo={showCardInfo}
                showFileSize={showFileSize}
                showUploader={showUploader}
                titleLines={titleLines}
                aspectRatio={aspectRatio}
                thumbnailScale={thumbnailScale}
                onShare={onAssetShare ? () => onAssetShare(asset) : undefined}
                onDownload={onAssetDownload ? () => onAssetDownload(asset) : undefined}
                onRename={onAssetRename ? () => onAssetRename(asset) : undefined}
                onDelete={onAssetDelete ? () => onAssetDelete(asset) : undefined}
                onContextMenu={(e) => handleAssetContextMenu(asset, e)}
                canVote={canVote}
                onVote={onAssetVote ? (stars) => onAssetVote(asset, stars) : undefined}
                folderPath={flattenFolders ? folderPaths[asset.id] : undefined}
                onDragStart={(e: React.DragEvent) => {
                  const ids = selectedAssetIds.has(asset.id)
                    ? Array.from(selectedIds)
                    : [asset.id]
                  e.dataTransfer.setData(
                    'application/json',
                    JSON.stringify({ assetIds: ids, folderIds: [] }),
                  )
                  e.dataTransfer.effectAllowed = 'move'
                }}
              />
            </div>
          ))}
        </div>
      ) : layout === 'list' && (showFolders || filtered.length > 0) ? (
        /* ─── Unified list view (folders + assets) ─────────────────── */
        <div className="rounded-lg border border-border overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-4 px-3 py-2 border-b border-border bg-bg-secondary/50 text-[10px] text-text-tertiary font-medium uppercase tracking-wider">
            <div className="h-10 w-10 shrink-0" />
            <div className="flex-1 min-w-0">Name</div>
            {showUploader && <div className="hidden md:block w-32">Uploader</div>}
            {showFileSize && <div className="hidden sm:block w-24 text-right">Size</div>}
            <div className="hidden md:block w-10 text-center">Ver.</div>
            <div className="hidden sm:block w-28">Date</div>
            <div className="w-8 shrink-0" />
            <div className="w-8 shrink-0" />
          </div>

          {/* Folder rows */}
          {showFolders && folders!.map((folder, i) => {
            const isFolderSelected = selectedFolderIds.has(folder.id)
            return (
              <div
                key={folder.id}
                // A handle for the tests. The grid's own right-click
                // handler keys off `data-folder-card`, which this row has
                // never carried; that is left exactly as it is.
                data-folder-row={folder.id}
                className={cn(
                  'group flex items-center gap-4 px-3 py-2.5 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== folders!.length - 1 || filtered.length > 0 ? 'border-b border-border' : '',
                  isFolderSelected && 'bg-accent/5',
                )}
                // §232 item 1 — the one surface where a plain mouse click
                // already opened; it now shares the single rule with the
                // other three instead of carrying a `mouseClickOpens`
                // exception of its own.
                onPointerDown={gesture.onPointerDown}
                onClick={(e) => handleFolderActivate(folder, e)}
                tabIndex={0}
                onKeyDown={(e) => {
                  const intent = cardKeyIntent(e)
                  if (intent === 'open') onFolderOpen?.(folder)
                  else if (intent === 'toggle') toggleFolderSelect(folder.id)
                }}
              >
                {/* Folder icon with checkbox overlay — aligned with asset thumbnail */}
                <div className="relative h-10 w-10 shrink-0 rounded-md bg-bg-tertiary flex items-center justify-center overflow-hidden">
                  <FolderIcon className="h-5 w-5 text-text-tertiary/60" />
                  <button
                    // §227b — named and finger-sized, like the asset
                    // row's. 40px of thumbnail is not 44.
                    aria-label={isFolderSelected ? `Deselect ${folder.name}` : `Select ${folder.name}`}
                    className={cn(
                      'tap-target-44 absolute inset-0 flex items-center justify-center transition-all',
                      isFolderSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 hover-none:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleFolderSelect(folder.id) }}
                  >
                    <div className={cn(
                      'h-4 w-4 rounded border flex items-center justify-center transition-all',
                      isFolderSelected
                        ? 'bg-accent border-accent text-white'
                        : 'bg-black/40 border-white/40 text-transparent',
                    )}>
                      {isFolderSelected && <Check className="h-2.5 w-2.5" />}
                    </div>
                  </button>
                </div>

                {/* Name */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate leading-snug">{folder.name}</p>
                  <p className="text-xs text-text-tertiary mt-0.5">{folder.item_count ?? 0} item{(folder.item_count ?? 0) !== 1 ? 's' : ''}</p>
                </div>

                {/* Uploader placeholder */}
                {showUploader && <div className="hidden md:block w-32 text-xs text-text-tertiary">—</div>}

                {/* Size placeholder */}
                {showFileSize && <div className="hidden sm:block w-24 text-right text-sm text-text-tertiary">—</div>}

                {/* Version placeholder */}
                <div className="hidden md:block w-10 text-center text-xs text-text-tertiary">—</div>

                {/* Date */}
                <div className="hidden sm:block w-28 text-xs text-text-tertiary shrink-0">
                  {new Date(folder.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>

                {/* Assignee placeholder — keeps column alignment */}
                <div className="w-8 shrink-0" />

                {/* Context menu */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 hover-none:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={4}
                        className="z-[100] min-w-[160px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {onFolderShare && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderShare(folder.id, folder.name)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          >
                            <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
                            Create share link
                          </DropdownMenu.Item>
                        )}
                        {onFolderRename && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderRename(folder.id, folder.name)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer outline-none transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5 text-text-tertiary" />
                            Rename
                          </DropdownMenu.Item>
                        )}
                        {onFolderDelete && (
                          <DropdownMenu.Item
                            onSelect={() => onFolderDelete(folder.id)}
                            className="flex items-center gap-2.5 mx-1 px-2.5 py-2 rounded-lg text-sm text-status-error hover:bg-status-error/10 cursor-pointer outline-none transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </DropdownMenu.Item>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            )
          })}
          {filtered.map((asset, i) => {
            const thumb = thumbnails[asset.id]
            const assignee = asset.assignee_id ? assignees[asset.assignee_id] : null
            const fileSize = fileSizes[asset.id]
            const versionCount = versionCounts[asset.id]
            const author = asset.created_by_name ?? (asset.created_by ? authorNames[asset.created_by] : undefined)
            const TypeIcon = assetTypeIcons[asset.asset_type] ?? ImageIcon
            return (
              <div
                key={asset.id}
                data-asset-row={asset.id}
                onPointerDown={gesture.onPointerDown}
                onClick={(e) => handleAssetActivate(asset, e)}
                tabIndex={0}
                onKeyDown={(e) => {
                  const intent = cardKeyIntent(e)
                  if (intent === 'open') onAssetOpen?.(asset)
                  else if (intent === 'toggle') { toggleAssetSelect(asset.id); setLastClickedId(asset.id) }
                }}
                className={cn(
                  'group flex items-center gap-4 px-3 py-2 transition-colors hover:bg-bg-hover cursor-pointer',
                  i !== filtered.length - 1 && 'border-b border-border',
                  selectedAssetIds.has(asset.id) && 'bg-accent/5',
                )}
              >
                {/* Square thumbnail with checkbox overlay */}
                <div className="relative h-10 w-10 shrink-0 rounded-md bg-bg-tertiary overflow-hidden flex items-center justify-center">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt={asset.name} className="h-full w-full object-cover" />
                  ) : (
                    <TypeIcon className="h-6 w-6 text-text-tertiary/60" />
                  )}
                  <button
                    // §101 — the grid's checkbox has carried this label
                    // since it was written; the list's had none at all, so
                    // it announced as an unnamed button. Matching them is
                    // both the fix and the only semantic handle a test has
                    // on this control.
                    aria-label={selectedAssetIds.has(asset.id)
                      ? `Deselect ${asset.name}` : `Select ${asset.name}`}
                    className={cn(
                      'tap-target-44 absolute inset-0 flex items-center justify-center transition-all',
                      selectedAssetIds.has(asset.id) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 hover-none:opacity-100',
                    )}
                    onClick={(e) => { e.stopPropagation(); handleCheckboxClick(asset, e) }}
                  >
                    <div className={cn(
                      'h-4 w-4 rounded border flex items-center justify-center transition-all',
                      selectedAssetIds.has(asset.id)
                        ? 'bg-accent border-accent text-white'
                        : 'bg-black/40 border-white/40 text-transparent',
                    )}>
                      {selectedAssetIds.has(asset.id) && <Check className="h-2.5 w-2.5" />}
                    </div>
                  </button>
                </div>
                {/* Name + status */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate leading-snug">{asset.name}</p>
                  {flattenFolders && folderPaths[asset.id] && (
                    <p className="text-2xs text-text-tertiary truncate mt-0.5">{folderPaths[asset.id]}</p>
                  )}
                </div>
                {/* Uploader */}
                {showUploader && (
                  <div className="hidden md:block w-32 text-xs text-text-tertiary truncate shrink-0">
                    {author || '—'}
                  </div>
                )}
                {/* File size */}
                {showFileSize && (
                  <div className="hidden sm:block w-24 text-right text-sm text-text-tertiary tabular-nums shrink-0">
                    {fileSize ? formatBytes(fileSize) : '—'}
                  </div>
                )}
                {/* Version */}
                <div className="hidden md:block w-10 text-center text-xs text-text-tertiary tabular-nums shrink-0">
                  {versionCount ? `v${versionCount}` : 'v1'}
                </div>
                {/* Date */}
                <div className="hidden sm:block w-28 text-xs text-text-tertiary shrink-0">
                  {new Date(asset.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                {/* Assignee */}
                <div className="w-8 shrink-0 flex justify-center">
                  {assignee && <Avatar src={assignee.avatar_url} name={assignee.name} size="sm" />}
                </div>
                {/* Context menu — hidden until hover.
                    §232 item 2 — the SAME `AssetMenuItems` the grid card
                    and the right-click menu use. This row carried its own
                    hand-written copy of the five entries, and the copy had
                    drifted: every entry rendered unconditionally and
                    called an optional handler, so a viewer — who is given
                    no `onAssetShare` / `onAssetRename` / `onAssetDelete`
                    (page.tsx's canShare / canEditAssets gates) — was
                    offered Create Share Link, Rename and Delete here and
                    they silently did nothing. With the right panel gone
                    this menu is where Share and Download now live, so it
                    has to be the gated list, not a lookalike.

                    Behaviour kept from the copy: "Copy Asset URL" uses
                    `asset.project_id` rather than the grid's `projectId`
                    prop, which matters on /assets where `projectId` is
                    the empty string. */}
                <div className="w-8 shrink-0 flex justify-center opacity-0 group-hover:opacity-100 hover-none:opacity-100 transition-opacity">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        onClick={(e) => e.stopPropagation()}
                        className="flex h-6 w-6 items-center justify-center rounded hover:bg-bg-hover text-text-tertiary hover:text-text-primary transition-colors outline-none"
                      >
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        align="end"
                        sideOffset={4}
                        className="z-[100] min-w-[200px] rounded-xl border border-border bg-bg-elevated shadow-2xl py-1.5 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <AssetMenuItems
                          onShare={onAssetShare ? () => onAssetShare(asset) : undefined}
                          onDownload={onAssetDownload ? () => onAssetDownload(asset) : undefined}
                          onRename={onAssetRename ? () => onAssetRename(asset) : undefined}
                          onDelete={onAssetDelete ? () => onAssetDelete(asset) : undefined}
                          assetUrl={
                            typeof window !== 'undefined'
                              ? `${window.location.origin}/projects/${asset.project_id}/assets/${asset.id}`
                              : null
                          }
                        />
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {/* Bottom selection action bar (Frame.io style) */}
      {!shareMode && totalSelected > 0 && (
        <div className="sticky bottom-0 z-20 flex items-center gap-3 rounded-lg border border-border bg-bg-elevated px-4 py-2.5 shadow-xl">
          <button onClick={clearSelection} className="text-text-tertiary hover:text-text-primary transition-colors">
            <X className="h-4 w-4" />
          </button>
          <span className="text-sm text-text-primary font-medium">
            {totalSelected} Item{totalSelected !== 1 ? 's' : ''} selected
          </span>
          {selectedTotalSize > 0 && (
            <span className="text-xs text-text-tertiary">
              &middot; {formatBytes(selectedTotalSize)}
            </span>
          )}
          <div className="flex-1" />
          {/* §99 — extends the current selection to everything visible.
              NOTE: this bar only exists once something is selected, so from
              a standing start the shortcut is the way in. Deliberate rather
              than overlooked — see the build report. */}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={selectAllVisible}
          >
            <CheckSquare className="h-4 w-4" /> Select all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => onBulkDelete?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
          {onBulkMove && (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => setMoveDialogOpen(true)}>
              <FolderInput className="h-4 w-4" /> Move to
            </Button>
          )}
          {onCreateShareLink && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                onCreateShareLink(Array.from(selectedAssetIds), Array.from(selectedFolderIds))
                clearSelection()
              }}
            >
              <Share2 className="h-4 w-4" /> Share
            </Button>
          )}
          {(selectedAssetIds.size > 0 || selectedFolderIds.size > 0) && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => onBulkDownload?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds))}
            >
              <Download className="h-4 w-4" /> Download
            </Button>
          )}
        </div>
      )}

      {/* ─── Right-click menu (§28) ───────────────────────────────────
          One menu, three modes. Every entry is the SAME handler the
          existing button uses, and is rendered only when that handler was
          supplied — which is how a role that can't delete via the kebab
          can't delete via right-click either. */}
      <CursorMenu state={contextMenu} onClose={() => setContextMenu(null)}>
        {contextMenu?.mode === 'asset' && contextMenu.asset && (
          <AssetMenuItems
            onShare={onAssetShare ? () => onAssetShare(contextMenu.asset as Asset) : undefined}
            onDownload={onAssetDownload ? () => onAssetDownload(contextMenu.asset as Asset) : undefined}
            onRename={onAssetRename ? () => onAssetRename(contextMenu.asset as Asset) : undefined}
            onDelete={onAssetDelete ? () => onAssetDelete(contextMenu.asset as Asset) : undefined}
            assetUrl={
              typeof window !== 'undefined' && contextMenu.asset
                ? `${window.location.origin}/projects/${projectId}/assets/${contextMenu.asset.id}`
                : null
            }
          />
        )}

        {contextMenu?.mode === 'bulk' && (
          <>
            <DropdownMenu.Label className="px-3 py-1.5 text-2xs uppercase tracking-wide text-text-tertiary">
              {totalSelected} selected
            </DropdownMenu.Label>
            {onCreateShareLink && (
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  onCreateShareLink(selectedAssetList(), selectedFolderList())
                  clearSelection()
                }}
              >
                <Share2 className="h-3.5 w-3.5 text-text-tertiary" />
                Create Share Link
              </DropdownMenu.Item>
            )}
            {onBulkDownload && (
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => onBulkDownload(selectedAssetList(), selectedFolderList())}
              >
                <Download className="h-3.5 w-3.5 text-text-tertiary" />
                Download
              </DropdownMenu.Item>
            )}
            {onBulkMove && (
              <DropdownMenu.Item className={menuItemClass} onSelect={() => setMoveDialogOpen(true)}>
                <FolderInput className="h-3.5 w-3.5 text-text-tertiary" />
                Move to…
              </DropdownMenu.Item>
            )}
            {onBulkDelete && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border mx-1" />
                <DropdownMenu.Item
                  className={menuItemDangerClass}
                  onSelect={() => onBulkDelete(selectedAssetList(), selectedFolderList())}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </DropdownMenu.Item>
              </>
            )}
          </>
        )}

        {contextMenu?.mode === 'canvas' && (
          <>
            {onNewFolder && (
              <DropdownMenu.Item className={menuItemClass} onSelect={onNewFolder}>
                <FolderPlus className="h-3.5 w-3.5 text-text-tertiary" />
                New Folder
              </DropdownMenu.Item>
            )}
            {onUpload && (
              <DropdownMenu.Item className={menuItemClass} onSelect={onUpload}>
                <Upload className="h-3.5 w-3.5 text-text-tertiary" />
                Upload
              </DropdownMenu.Item>
            )}
          </>
        )}
      </CursorMenu>

      <MoveToDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        projectName={projectName}
        tree={folderTree}
        currentFolderId={currentFolderId ?? null}
        movingFolderIds={Array.from(selectedFolderIds)}
        onMove={(targetFolderId) => {
          onBulkMove?.(Array.from(selectedAssetIds), Array.from(selectedFolderIds), targetFolderId)
          clearSelection()
        }}
      />
    </div>
  )
}
