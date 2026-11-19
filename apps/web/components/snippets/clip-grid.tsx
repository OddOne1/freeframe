'use client'

/**
 * The SocialSnippet clips grid. An opened card spans the whole width, and it
 * opens in place: it takes the full width of the row it was already in. The
 * cards that shared that row with it (the left-hand card, when it was on the
 * right) move to the row directly below, followed by the rest in their
 * original order. No card from a later row moves up, which is what the old
 * dense flow did when it backfilled the slot the opened card left.
 *
 * The grid fits as many columns as its width allows (auto-fill, each at
 * least 31rem, never wider than the grid), so a narrow window shows one,
 * a laptop two and a wide screen three or more. The number of columns is
 * read from the grid's own computed layout, not from a breakpoint copied
 * out of the class list, so it follows the CSS at any count.
 */
import * as React from 'react'

/**
 * `items` with the one at `expandedIndex` moved to the start of its row in
 * a grid of `columns` columns, and everything else in its original order.
 * With one column, or nothing open, `items` comes back unchanged.
 */
export function expandedRowOrder<T>(items: readonly T[], expandedIndex: number, columns: number): T[] {
  if (expandedIndex < 0 || expandedIndex >= items.length || columns <= 1) return [...items]
  const rowStart = expandedIndex - (expandedIndex % columns)
  if (rowStart === expandedIndex) return [...items]
  return [
    ...items.slice(0, rowStart),
    items[expandedIndex],
    ...items.slice(rowStart, expandedIndex),
    ...items.slice(expandedIndex + 1),
  ]
}

/**
 * How many column tracks a computed `grid-template-columns` value has:
 * "512px 512px" is 2. `repeat(n, …)` (an unresolved value) counts as n and
 * line names are ignored. "none", empty, or anything unreadable is 1.
 */
export function countGridColumns(template: string | null | undefined): number {
  const value = (template ?? '').replace(/\[[^\]]*\]/g, ' ').trim()
  if (!value || value === 'none') return 1
  let count = 0
  let depth = 0
  let token = ''
  const flush = () => {
    const t = token.trim()
    token = ''
    if (!t) return
    const repeat = /^repeat\(\s*(\d+)\s*,/.exec(t)
    count += repeat ? Number(repeat[1]) : 1
  }
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (depth === 0 && /\s/.test(ch)) flush()
    else token += ch
  }
  flush()
  return Math.max(1, count)
}

// Layout effects warn on the server; this grid only measures in the browser.
const useBrowserLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/** The grid's current column count, kept in step with its size. */
function useGridColumns(ref: React.RefObject<HTMLElement>): number {
  const [columns, setColumns] = React.useState(1)
  useBrowserLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setColumns(countGridColumns(window.getComputedStyle(el).gridTemplateColumns))
    read()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return columns
}

/**
 * As many columns as fit, each at least 31rem (the closed card's two
 * columns, picture and text, need about that) and at most the grid's own
 * width, so a single column never overflows a narrow window. auto-fill,
 * not auto-fit: a short row keeps card-sized columns instead of
 * stretching one card across the page. An opened card's `col-span-full`
 * still spans every column. The card's `clip-wide:` variant
 * (tailwind.config.ts) sits just under this minimum.
 */
export const CLIP_GRID_CLASS = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,31rem),1fr))]'

export interface ClipGridProps<T> {
  items: readonly T[]
  keyOf: (item: T) => string
  expandedKey: string | null
  children: (item: T) => React.ReactNode
  className?: string
}

export function ClipGrid<T>({ items, keyOf, expandedKey, children, className }: ClipGridProps<T>) {
  const ref = React.useRef<HTMLDivElement>(null)
  const columns = useGridColumns(ref)
  const expandedIndex = expandedKey === null ? -1 : items.findIndex((item) => keyOf(item) === expandedKey)
  const ordered = expandedRowOrder(items, expandedIndex, columns)
  return (
    // Plain row flow, never dense: a later card must not backfill an earlier row.
    <div ref={ref} data-clip-grid="" className={className ?? CLIP_GRID_CLASS}>
      {ordered.map((item) => (
        <React.Fragment key={keyOf(item)}>{children(item)}</React.Fragment>
      ))}
    </div>
  )
}
