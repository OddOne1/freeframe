'use client'

import * as React from 'react'
import * as Tabs from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'
import { ADMIN_TABS, type AdminTabValue } from './admin-tabs'

/**
 * The Admin area's tab strip (§229).
 *
 * Two shapes, one element: a row of pills that scrolls sideways on a
 * phone, and the ordinary underlined tab row this app already uses (see
 * the project settings page) from `md` up. Which one you get is a CSS
 * breakpoint on the triggers themselves — there is no second tree.
 *
 * `Tabs.List` is Radix's, so this is a real `role="tablist"` with
 * `role="tab"` children, arrow-key navigation, Home/End, and roving
 * tabindex. Written by hand it would be a row of buttons that a keyboard
 * walks through one Tab press at a time.
 *
 * The JavaScript here is about the SCROLLER and nothing else:
 *
 *  - the active pill is scrolled into view, because a deep link to
 *    `?tab=branding` on a 390px screen otherwise opens with the strip
 *    showing Users and no sign that the fifth tab is the live one. It is
 *    computed against the container rather than `scrollIntoView`, which
 *    would also scroll the page vertically to reach it;
 *  - the edge fades are shown only on the side that has something hidden
 *    behind them, so "this scrolls" is visible without painting a
 *    permanent gradient over a strip that is already fully in view.
 *
 * Both run below `md` as well as above it; above it the strip fits, so
 * both answers are "nothing to do" and nothing is painted.
 */
export function AdminTabStrip({
  value,
  onValueChange,
}: {
  value: AdminTabValue
  onValueChange: (next: AdminTabValue) => void
}) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ start: false, end: false })

  const measure = React.useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({
      start: el.scrollLeft > 1,
      end: max > 1 && el.scrollLeft < max - 1,
    })
  }, [])

  // Keep the live tab on screen. `block: 'nearest'` on scrollIntoView is
  // not enough — it still scrolls ancestors — so the offset is applied to
  // the scroller directly.
  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('[data-state="active"]')
    if (active) {
      const left = active.offsetLeft
      const right = left + active.offsetWidth
      if (left < el.scrollLeft) {
        el.scrollLeft = Math.max(0, left - 16)
      } else if (right > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = right - el.clientWidth + 16
      }
    }
    measure()
  }, [value, measure])

  React.useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    return () => {
      el.removeEventListener('scroll', measure)
      ro?.disconnect()
    }
  }, [measure])

  return (
    // `-mx-6` on the WRAPPER, not on the scroller: the fades are absolutely
    // positioned against this box, and with the negative margin one level
    // in they sat 24px short of the screen edge — a gradient that faded
    // into the page's gutter instead of into the edge the strip runs off.
    <div className="relative -mx-6 md:mx-0">
      <div
        ref={scrollerRef}
        data-testid="admin-tab-scroller"
        // `px-6` below `md`: the strip scrolls edge to edge of the screen
        // rather than inside the page's own 24px gutter, so the last pill
        // is not permanently half-hidden under the padding.
        className="overflow-x-auto px-6 md:overflow-visible md:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <Tabs.List
          aria-label="Admin sections"
          className="flex w-max min-w-full items-center gap-1.5 pb-0.5 md:w-auto md:gap-1 md:border-b md:border-border md:pb-0"
        >
          {ADMIN_TABS.map((t) => (
            <Tabs.Trigger
              key={t.value}
              value={t.value}
              data-testid={`admin-tab-${t.value}`}
              className={cn(
                // Phone: a 44px pill that never wraps.
                'h-11 shrink-0 whitespace-nowrap rounded-full px-3.5 text-sm transition-colors',
                'text-text-secondary hover:text-text-primary',
                'data-[state=active]:bg-accent/15 data-[state=active]:font-medium data-[state=active]:text-accent',
                // Desktop: the underlined row, and the pill styling off.
                'md:-mb-px md:h-auto md:rounded-none md:border-b-2 md:border-transparent md:px-3 md:py-2',
                'md:data-[state=active]:border-accent md:data-[state=active]:bg-transparent md:data-[state=active]:text-text-primary',
              )}
              onClick={() => onValueChange(t.value)}
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </div>

      {/* The fades. `aria-hidden` and `pointer-events-none`: they are a
          hint that the strip scrolls, not controls, and a tap must reach
          the pill underneath. `md:hidden` — above `md` the strip is a
          border, not a scroller. */}
      <div
        aria-hidden
        data-testid="admin-tab-fade-start"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-bg-primary via-bg-primary/80 to-transparent transition-opacity md:hidden',
          edges.start ? 'opacity-100' : 'opacity-0',
        )}
      />
      <div
        aria-hidden
        data-testid="admin-tab-fade-end"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-bg-primary via-bg-primary/80 to-transparent transition-opacity md:hidden',
          edges.end ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  )
}
