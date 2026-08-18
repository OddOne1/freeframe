'use client'

import * as React from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SortDirection = 'asc' | 'desc'

/** What a column sorts by. Returning null/undefined sorts that row last in
 *  either direction — "no value" is not smaller than every value, it is
 *  absent, and burying it is what a reader expects. */
export type SortValue = string | number | boolean | null | undefined

export interface SortState<K extends string> {
  key: K
  direction: SortDirection
  /** Click a column: same key flips direction, a new key starts ascending. */
  toggle: (key: K) => void
}

function compare(a: SortValue, b: SortValue): number {
  const aMissing = a === null || a === undefined || a === ''
  const bMissing = b === null || b === undefined || b === ''
  if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === 'string' && typeof b === 'string') {
    // Locale compare, so "Ärger" files next to "Arger" rather than after Z,
    // and numeric so "Take 2" precedes "Take 10".
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  }
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1
}

/**
 * Local sort state plus the sorted rows.
 *
 * State is per-table on purpose (CLAUDE.md §40): two tables on one page sort
 * independently, and nothing here is worth persisting — re-sorting is one
 * click, unlike §38's collapse state, which is a multi-step reorganisation.
 */
export function useSortState<K extends string>(
  initialKey: K,
  initialDirection: SortDirection = 'asc',
): SortState<K> {
  // Key and direction in ONE state, not two. The two-state version calls
  // setDirection from inside setKey's updater, which is a side effect in an
  // updater -- exactly what React may invoke more than once. It was NOT
  // observed misbehaving here (including under StrictMode), so this is
  // avoidance rather than a fix, but a single transition is also simpler to
  // read than one spread across two setters.
  const [state, setState] = React.useState<{ key: K; direction: SortDirection }>({
    key: initialKey,
    direction: initialDirection,
  })

  const toggle = React.useCallback((next: K) => {
    setState((prev) => ({
      key: next,
      // A new column starts ascending; the same one reverses. Anything else
      // makes the first click on a fresh column feel random.
      direction: prev.key === next ? (prev.direction === 'asc' ? 'desc' : 'asc') : 'asc',
    }))
  }, [])

  return { key: state.key, direction: state.direction, toggle }
}

/** Order rows by one sort state. Exported for callers that apply the same
 *  sort to several lists (the LUT library sorts every group's contents from
 *  one control) rather than to a single table. */
export function sortRows<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => SortValue>,
  sort: Pick<SortState<K>, 'key' | 'direction'>,
): T[] {
  const accessor = accessors[sort.key]
  if (!accessor) return rows
  const factor = sort.direction === 'asc' ? 1 : -1
  // Missing values stay last in BOTH directions, so reversing the sort does
  // not float every blank to the top.
  return [...rows].sort((a, b) => {
    const av = accessor(a)
    const bv = accessor(b)
    const aMissing = av === null || av === undefined || av === ''
    const bMissing = bv === null || bv === undefined || bv === ''
    const ordered = compare(av, bv)
    if (aMissing !== bMissing) return ordered
    return ordered * factor
  })
}

export function useSort<T, K extends string>(
  rows: T[],
  accessors: Record<K, (row: T) => SortValue>,
  // NoInfer, so K is the full set of accessor keys rather than being
  // narrowed to whichever one happens to be the initial sort.
  initial: { key: NoInfer<K>; direction?: SortDirection },
): { sorted: T[]; sort: SortState<K> } {
  const sort = useSortState<K>(initial.key as K, initial.direction ?? 'asc')
  const sorted = React.useMemo(
    () => sortRows(rows, accessors, sort),
    // accessors is rebuilt on every render by most callers; the key and
    // direction are what actually change the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, sort.key, sort.direction],
  )
  return { sorted, sort }
}

function SortGlyph({ active, direction }: { active: boolean; direction: SortDirection }) {
  if (!active) {
    return <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-60" />
  }
  return direction === 'asc' ? (
    <ArrowUp className="h-3 w-3 shrink-0 text-accent" />
  ) : (
    <ArrowDown className="h-3 w-3 shrink-0 text-accent" />
  )
}

/**
 * A clickable table header cell.
 *
 * `aria-sort` on the cell is what makes this a sortable column to a screen
 * reader rather than a header that happens to contain a button.
 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  align = 'left',
  className,
}: {
  label: string
  sortKey: K
  sort: SortState<K>
  align?: 'left' | 'right'
  className?: string
}) {
  const active = sort.key === sortKey
  return (
    <th
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(
        'px-4 py-2.5 text-xs font-medium text-text-tertiary',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => sort.toggle(sortKey)}
        className={cn(
          'group inline-flex items-center gap-1 transition-colors hover:text-text-primary',
          active && 'text-text-primary',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <SortGlyph active={active} direction={sort.direction} />
      </button>
    </th>
  )
}

/** A plain header cell, for a column with no coherent single sort key.
 *  Exists so a table's header row reads as one thing rather than a mix of
 *  `<SortableTh>` and hand-written `<th>`. */
export function PlainTh({
  label,
  align = 'left',
  className,
}: {
  label: string
  align?: 'left' | 'right'
  className?: string
}) {
  return (
    <th
      className={cn(
        'px-4 py-2.5 text-xs font-medium text-text-tertiary',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {label}
    </th>
  )
}

/**
 * The same control outside a table — a row of small sort buttons.
 *
 * The LUT library is a list of cards, not a table, so it has no column
 * headers to click; this keeps the same affordance and the same hook rather
 * than growing a second sorting mechanism for it.
 */
export function SortControl<K extends string>({
  label,
  options,
  sort,
  className,
}: {
  label: string
  options: { key: K; label: string }[]
  sort: SortState<K>
  className?: string
}) {
  return (
    <div className={cn('flex items-center gap-1.5', className)} role="group" aria-label={label}>
      <span className="text-2xs uppercase tracking-wide text-text-tertiary">{label}</span>
      {options.map((option) => {
        const active = sort.key === option.key
        return (
          <button
            key={option.key}
            type="button"
            onClick={() => sort.toggle(option.key)}
            aria-pressed={active}
            className={cn(
              'group inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs transition-colors',
              active
                ? 'text-accent'
                : 'text-text-tertiary hover:text-text-primary',
            )}
          >
            {option.label}
            <SortGlyph active={active} direction={sort.direction} />
          </button>
        )
      })}
    </div>
  )
}
