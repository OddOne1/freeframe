'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One folder in the open chain, root first — the shape `folderTrail` has. */
export interface TrailFolder {
  id: string
  name: string
}

export interface BackTarget {
  /** Where "up one level" is. A real URL, never a history instruction. */
  href: string
  /** The parent's name, for the label and the accessible name. */
  parentName: string
}

/**
 * Where the folder view's Back button goes (§228d item 3).
 *
 * Derived from the SAME `folderTrail` the header breadcrumb and the folder
 * navigator are built from — one walk of the tree, three readers (§227) —
 * so "what is the parent" cannot start disagreeing between them. The trail
 * is root-first and ENDS with the folder that is open, so the parent is its
 * second-to-last entry.
 *
 * Three cases, and the third is the one worth stating:
 *
 *   deep folder   trail [A, B, C]  ->  /projects/{id}?folder=B
 *   top folder    trail [A]        ->  /projects/{id}          (project root)
 *   project root  trail []         ->  /projects               (the list)
 *
 * The project root case is why the button is never hidden: "up" always has
 * a destination, and a control that appears and disappears as you walk the
 * tree is a control you cannot learn. The owner asked for it to be
 * "viewable for every size window" — this is the same answer for depth.
 *
 * A URL and not `router.back()`, for the reason §179 gives for the viewer's
 * own Back: this page is routinely opened cold (a shared link, a refresh, a
 * new tab, a deep link with ?folder=), and the history stack only holds the
 * right entry when the user clicked their way here. `router.back()` would
 * pass a click test and send a cold visitor to whatever they were reading
 * before FreeFrame.
 */
export function folderBackTarget(
  projectId: string,
  projectName: string,
  trail: TrailFolder[],
): BackTarget {
  if (trail.length === 0) return { href: '/projects', parentName: 'Projects' }
  const parent = trail[trail.length - 2]
  return parent
    ? { href: `/projects/${projectId}?folder=${parent.id}`, parentName: parent.name }
    : { href: `/projects/${projectId}`, parentName: projectName }
}

/**
 * "← Back to {parent}" at the top of the folder/asset view (§228d item 3).
 *
 * The owner: "in the folder/assets window there needs to be a back button
 * right above the first text or item. This button needs to be viewable for
 * every size window, not just mobile. For mobile it needs to be smaller
 * though. The back button also needs an icon that makes it instantly
 * recognizable."
 *
 * `ArrowLeft`, not a chevron and not the navigator's tree glyph: a
 * left-pointing arrow is the one icon that means "back" on both platforms
 * and in every file manager, and the navigator bar directly above already
 * spends a chevron on "expand" — two chevrons pointing different ways in
 * 40px is what made the §224 bar unreadable.
 *
 * Sizes, both in Tailwind rather than in a `useIsPhone()` branch: this is a
 * purely VISUAL difference, and `use-media-query.ts` is explicit that the
 * JS hook exists only where a different tree has to mount. A class the
 * server and the client agree on costs no hydration flip.
 *
 *   < 768   28px tall, `text-xs`, icon + "Back"
 *   >= 768  32px tall, `text-sm`, icon + "Back to {parent}"
 *
 * The parent's name is `md:inline` because at 320px "Back to Reaction_
 * watchparty" is the whole row; the ACCESSIBLE name keeps it at every
 * width, so a screen reader is never told just "Back".
 *
 * `tap-target-44` (§227b) is the invisible 44px hit box. Padding would have
 * grown a 28px control the owner asked to be smaller than the desktop one;
 * the pseudo-element paints nothing and is out of flow, so the gap to the
 * first card below (12px) absorbs the 8px it reaches down by, and nothing
 * overlaps the card's own hit area.
 */
export function FolderBackButton({
  href,
  parentName,
  className,
  compact = false,
}: BackTarget & {
  className?: string
  /**
   * §230 item 3 — the variant that shares a 40px row with the path.
   *
   * A VARIANT, not a second component: the href, the `data-testid` and
   * the accessible name are the ones above, computed by the same
   * `folderBackTarget`, so "where does Back go" cannot start differing
   * between a phone on its side and every other screen. What changes is
   * size and what text is drawn — this sits beside the folder path
   * rather than under the toolbar's line, and the path already says
   * which folder you are in, so repeating "to {parent}" next to it would
   * spend half the row saying it twice.
   *
   * `data-compact-back` is the hook the compact-landscape block in
   * globals.css hangs the 36px floor on. The class pair below cannot do
   * that part on its own: `.tap-target-44`'s `::before` is 44px square
   * and would reach 2px past a 40px row into the trigger beside it.
   */
  compact?: boolean
}) {
  return (
    <Link
      href={href}
      data-testid="folder-back"
      data-compact-back={compact ? '' : undefined}
      aria-label={`Back to ${parentName}`}
      className={cn(
        'tap-target-44 relative inline-flex w-fit shrink-0 items-center gap-1.5 self-start rounded-md',
        compact
          ? 'h-9 pl-1.5 pr-2 text-[13px]'
          : 'h-7 px-2 text-xs md:h-8 md:px-2.5 md:text-sm',
        'font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-primary',
        className,
      )}
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">
        Back
        {/* "where it fits": the name is hidden below `md` and truncates
            above it, so a folder named after a camera roll cannot push the
            row. Inside the same span as the word, so the space between
            them is a space and not a flex gap.
            §230 — and hidden in the compact row at every width, where the
            path standing next to it already names the folder. */}
        {!compact && <span className="hidden md:inline">{` to ${parentName}`}</span>}
      </span>
    </Link>
  )
}
