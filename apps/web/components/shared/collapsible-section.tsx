'use client'

import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/** localStorage key prefix. Namespaced so a section's key can be read at a
 *  glance in devtools and cleared as a group. */
const KEY_PREFIX = 'ff-collapse-'

/**
 * Collapse state that survives a reload.
 *
 * Read in a layout effect rather than a useState initializer: this renders on
 * the server too, where localStorage does not exist, and seeding state from it
 * would be a hydration mismatch. A layout effect applies the stored value
 * before the browser paints, so a section stored as collapsed does not flash
 * open first.
 */
function useCollapsed(
  storageKey: string | undefined,
  defaultCollapsed: boolean,
  onChange?: (collapsed: boolean) => void,
): [boolean, () => void] {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed)

  const useIsomorphicLayoutEffect =
    typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

  useIsomorphicLayoutEffect(() => {
    if (!storageKey) return
    try {
      const stored = window.localStorage.getItem(KEY_PREFIX + storageKey)
      if (stored === '1' || stored === '0') {
        setCollapsed(stored === '1')
        // Told on the restore too, not only on a click: a parent that
        // summarises what is folded up underneath it has no other way to
        // learn about state restored from a previous session.
        onChangeRef.current?.(stored === '1')
      }
    } catch {
      // Private mode, or storage disabled. The section still collapses, it
      // just forgets -- which is strictly better than not rendering.
    }
  }, [storageKey])

  // A ref, so a caller passing an inline arrow does not re-run the restore
  // effect on every render.
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  const toggle = React.useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      onChangeRef.current?.(next)
      if (storageKey) {
        try {
          window.localStorage.setItem(KEY_PREFIX + storageKey, next ? '1' : '0')
        } catch {
          // As above.
        }
      }
      return next
    })
  }, [storageKey])

  return [collapsed, toggle]
}

interface CollapsibleSectionProps {
  /** Rendered inside the toggle button. */
  title: React.ReactNode
  /** Shown beside the title. Omit for a section where a count means nothing. */
  count?: number
  /**
   * Suffix of the localStorage key (`ff-collapse-` is prepended). Omit for a
   * section that should always start from `defaultCollapsed`.
   */
  storageKey?: string
  defaultCollapsed?: boolean
  /**
   * `block` is the bordered card with a header bar that Settings → Admin's
   * user tables use; `plain` is a bare heading, for the LUT and Projects
   * lists that already sit inside their own containers.
   */
  tone?: 'block' | 'plain'
  /** Rendered after the toggle, right-aligned, OUTSIDE the button -- a button
   *  cannot legally contain another one. */
  actions?: React.ReactNode
  /**
   * Shown beside the count when this section is expanded but something
   * inside it is collapsed (§41). The count is a total, and a nested
   * collapsed group makes it look like rows went missing; this says they
   * are hidden, not gone.
   */
  hiddenNote?: React.ReactNode
  /** Fired when this section folds or unfolds, including when a stored state
   *  is restored on mount — for a parent that summarises what is hidden
   *  underneath it (§41). */
  onCollapsedChange?: (collapsed: boolean) => void
  /**
   * Replaces the title inside the header, leaving a chevron-only toggle
   * beside it. Exists for one case: a section whose title is being edited
   * inline, where the name has to become an `<input>` that cannot live inside
   * the toggle button.
   */
  titleOverride?: React.ReactNode
  className?: string
  children: React.ReactNode
}

/**
 * One collapsible section, with its open/closed state remembered per key.
 *
 * Extracted from Settings → Admin's `UserGroupBlock`, which was the only
 * implementation of this pattern in the app; Admin now renders through this
 * too rather than being left as a fourth divergent copy (CLAUDE.md §38 --
 * this codebase has a repeated history of two copies of one idea drifting).
 */
export function CollapsibleSection({
  title,
  count,
  storageKey,
  defaultCollapsed = false,
  tone = 'plain',
  actions,
  hiddenNote,
  onCollapsedChange,
  titleOverride,
  className,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, toggle] = useCollapsed(storageKey, defaultCollapsed, onCollapsedChange)
  const block = tone === 'block'

  const chevron = (
    <ChevronDown
      className={cn(
        'h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform',
        collapsed && '-rotate-90',
      )}
    />
  )

  const label = block ? (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
      {title}
      {count !== undefined && ` (${count})`}
    </span>
  ) : (
    <>
      <span className="text-sm font-semibold text-text-primary">{title}</span>
      {/* Parenthesised, matching the `block` tone's own "(3)" -- and it has to
          live inside a text run that a screen reader will separate from the
          title, since accessible-name computation trims each element's
          whitespace and would otherwise say "Ungrouped3". */}
      {count !== undefined && (
        <span className="text-xs text-text-tertiary">{`(${count})`}</span>
      )}
    </>
  )

  return (
    <div
      className={cn(
        block && 'rounded-lg border border-border bg-bg-secondary overflow-x-auto',
        className,
      )}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div
        className={cn(
          'flex items-center gap-2',
          block && 'bg-bg-tertiary/60 px-4 py-2',
        )}
      >
        {titleOverride === undefined ? (
          // <h2><button aria-expanded> is the disclosure pattern: the section
          // keeps a real heading in the document outline, and the button is
          // what gets pressed. (A heading inside a button would be invalid --
          // a button may only contain phrasing content.)
          <h2 className={cn('min-w-0', block ? 'flex-1' : 'contents')}>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              className={cn(
                'flex min-w-0 items-center gap-2 text-left transition-colors',
                block ? 'w-full py-0' : 'rounded hover:opacity-80',
              )}
            >
              {chevron}
              {label}
            </button>
          </h2>
        ) : (
          <>
            <button
              type="button"
              onClick={toggle}
              aria-expanded={!collapsed}
              aria-label={collapsed ? 'Expand section' : 'Collapse section'}
              className="shrink-0 rounded transition-colors hover:opacity-80"
            >
              {chevron}
            </button>
            {titleOverride}
          </>
        )}
        {hiddenNote && !collapsed && (
          <span className="text-2xs text-text-tertiary">{hiddenNote}</span>
        )}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>

      {!collapsed && children}
    </div>
  )
}
