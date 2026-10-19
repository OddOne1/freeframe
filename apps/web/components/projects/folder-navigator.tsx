'use client'

import * as React from 'react'
import { ChevronDown, FolderTree as FolderTreeIcon } from 'lucide-react'
import { FolderTree } from './folder-tree'
import { cn } from '@/lib/utils'

/**
 * How many ancestors the bar names before it starts eliding from the left.
 *
 * Two, because "Just Ride 2026 / Podcast" is the shape the owner asked
 * for and a four-deep chain on a 390px bar leaves no room for the folder
 * you are actually in.
 */
const MAX_ANCESTORS = 2

/**
 * Where the bar says you are: the ancestors it will print, and the folder
 * you are in.
 *
 * Truncation happens from the LEFT and at SEGMENT granularity — the
 * current folder is the one thing that must always be legible, so the
 * ancestors are what gets dropped, oldest first, and `…` says so. CSS
 * ellipsis then handles whatever still does not fit, which is why this
 * returns the pieces rather than a string: a single truncated string
 * would ellipsise at its END and eat exactly the segment that matters.
 */
export function shortPath(segments: string[]): { prefix: string[]; current: string } {
  const current = segments[segments.length - 1] ?? ''
  const ancestors = segments.slice(0, -1)
  const shown = ancestors.slice(-MAX_ANCESTORS)
  return {
    prefix: shown.length < ancestors.length ? ['…', ...shown] : shown,
    current,
  }
}

/**
 * The folder navigator (§227), below `xl`.
 *
 * §224 put the folder tree behind a "Podcast ▾" text button and opened it
 * as a Radix Dialog: a floating sheet with its own "FOLDERS ✕" title bar
 * and a full-screen scrim. The owner, from a real phone: it is not clear
 * that "Video ▾" is a folder tree at all, and when it opens it becomes a
 * popup instead of expanding downwards.
 *
 * So this is a full-width BAR, flush under the header and in the header's
 * own colours (`bg-nav-bg` / `border-nav-border` / `text-nav-text`, the
 * tokens `header.tsx` uses — by default `--nav-bg` IS `--bg-secondary`,
 * which is what §224's sheet painted, so this is the same colour until
 * someone overrides the chrome in Branding, at which point the bar follows
 * the header rather than drifting from it). A tree icon says what it is,
 * the path says where you are, and the chevron rotates.
 *
 * No Radix Dialog. The reason is the portal: Dialog renders into
 * document.body, which is precisely what made §224's tree float, and
 * anchoring a portalled element to a bar means measuring the bar and
 * mirroring its width — fighting the primitive to undo the one thing it
 * was doing. What Dialog brought that is worth keeping is Escape, the
 * scrim click and the focus trap; the first two are four lines below, and
 * the third is worth less here than it costs: this panel is attached to
 * its trigger in the reading order, so Tab walks from the bar into the
 * tree and out the other side on its own. A Radix Collapsible would give
 * the height animation and nothing else — no scrim, no Escape, no outside
 * click — so it would not have removed any of the code below either.
 *
 * `FolderTree` is rendered with exactly the props the sidebar column
 * passes, so §223's per-folder menu (rename, new subfolder, create share
 * link), the trash row and the drag-drop targets come along unchanged.
 *
 * `extra` is for whatever belongs BELOW the tree in the panel — §227 item
 * 5 puts Share Links and Storage there, because below `xl` the left
 * column that held them does not exist and nothing else led to them.
 */
export function FolderNavigator({
  segments,
  actions,
  extra,
  leading,
  className,
  ...treeProps
}: React.ComponentProps<typeof FolderTree> & {
  /**
   * Where we are, root first: the project name, then each open folder.
   * The page builds it, because the page is what knows whether we are in
   * a folder, in the trash or looking at share links.
   */
  segments: string[]
  /** Project actions ("···"), which share the bar's right end on phones. */
  actions?: React.ReactNode
  /**
   * §230 item 3 — what stands to the LEFT of the trigger in this bar.
   *
   * One slot, used by one caller for one thing: the folder view's Back
   * button, in compact landscape, where its own row underneath the
   * toolbar costs 44px of a 390px screen that has none to spare. It is a
   * node rather than a `showBack` flag because Back's target is derived
   * from `folderTrail` by the page (§228d), and this bar has never known
   * anything about the tree it is showing a path for.
   *
   * Outside the trigger `<button>`, never inside it: a link nested in a
   * button is not a link, and Back and "open the tree" are two different
   * destinations that have to stay two different targets.
   */
  leading?: React.ReactNode
  /**
   * Rendered inside the panel, under the tree. A render prop rather than
   * a node, because what goes there has to be able to CLOSE the panel:
   * picking a share link shows it in the main view, and leaving the tree
   * over the thing it just opened is the §224 bug in another place.
   */
  extra?: (close: () => void) => React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const { prefix, current } = shortPath(segments)
  const fullPath = segments.join(' / ')

  // Escape closes it. One of the four ways out the owner asked for — the
  // others are the bar itself, the scrim, and selecting a folder.
  React.useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    // `relative` so the panel below can be `top-full`: attached to this
    // bar, the full width of it, rather than placed anywhere.
    // `z-30` so the panel and its scrim paint over the grid; the tablet
    // right-panel drawer is z-40 and still wins, which is right.
    <div
      data-testid="folder-navigator"
      className={cn(
        // `h-12` on THIS element, not on the row inside it: Tailwind's
        // preflight sets `box-sizing: border-box`, so 48px here INCLUDES
        // the bottom border — exactly as §224's row did. Measured, because
        // one pixel of difference moves the whole grid below it and the
        // tablet band is supposed to be untouched.
        'relative z-30 h-12 shrink-0 border-b border-nav-border bg-nav-bg',
        className,
      )}
    >
      {/* The bar's own height is §224's row height to the pixel, so
          everything below sits where it did and the tablet band
          (768–1279) is unchanged apart from the bar itself. The TRIGGER
          inside is h-11: 44px, the touch target this control needs. */}
      <div className="flex h-full items-center">
        {leading && (
          // `pl-1` so the first thing in the row is not flush against the
          // screen edge; the compact-landscape block replaces it with the
          // reduced safe-area inset where there is a cutout to clear.
          <div data-testid="folder-navigator-leading" className="flex shrink-0 items-center pl-1">
            {leading}
          </div>
        )}
        <button
          data-testid="folder-navigator-trigger"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="folder-navigator-panel"
          // The visible path is abbreviated; the accessible name is not.
          aria-label={`Folders: ${fullPath}`}
          title={fullPath}
          // h-11 = 44px. This is the primary navigation control below `xl`.
          className="flex h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-nav-text/10"
        >
          <FolderTreeIcon className="h-[18px] w-[18px] shrink-0 text-nav-text/70" strokeWidth={1.75} />

          {/* The path. `min-w-0` on the ancestors and `shrink-0` on the
              current folder is what makes the squeeze fall on the left:
              flexbox takes the space back from the ancestors first, and
              only the current name's own `truncate` applies after that. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
            {prefix.length > 0 && (
              <span className="min-w-0 truncate text-[13px] text-nav-text/55">
                {prefix.join(' / ')} /
              </span>
            )}
            <span className="max-w-full shrink-0 truncate text-[15px] font-semibold text-nav-text">
              {current}
            </span>
          </span>

          <ChevronDown
            data-testid="folder-navigator-chevron"
            className={cn(
              'h-4 w-4 shrink-0 text-nav-text/60 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
        </button>

        {actions}
      </div>

      {open && (
        <>
          {/* The scrim starts at the BAR's bottom edge and sits UNDER the
              panel, so what reads as dimmed is exactly the content below
              the panel: the bar stays lit, because it is still the live
              control, and the panel paints over its own share of the
              scrim. `absolute`, not `fixed`, so at tablet widths the
              navigation rail beside this column is not dimmed either —
              nothing about the rail is part of this view. */}
          <div
            data-testid="folder-navigator-scrim"
            onClick={() => setOpen(false)}
            className="absolute inset-x-0 top-full z-10 h-[100dvh] bg-black/50"
          />

          {/* Attached, full width, flush, no title bar and no ✕: the bar
              closes it, so a second close control would be a third way to
              do one thing. A short slide down rather than a height
              animation — `animate-slide-down` is the project's own
              keyframe (tailwind.config.ts), and it is honest about what it
              does, unlike §224's `data-[state=open]:animate-in` classes,
              which this codebase has no plugin to define. */}
          <div
            id="folder-navigator-panel"
            data-testid="folder-navigator-panel"
            className={cn(
              'absolute inset-x-0 top-full z-20 animate-slide-down',
              'max-h-[min(60dvh,calc(100dvh-5.5rem))] overflow-y-auto',
              'border-b border-nav-border bg-nav-bg shadow-xl',
            )}
          >
            <div className="p-3">
              {/* Selecting a folder closes the panel — otherwise the tree
                  sits over the grid it has just navigated to. Wrapped
                  here rather than changed inside FolderTree, which has no
                  business knowing what it is mounted in. */}
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
            {extra && (
              <div data-testid="folder-navigator-extra" className="border-t border-nav-border">
                {extra(() => setOpen(false))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
