'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useVisibleSettingsNav } from '@/lib/settings-nav'

/* §224b — `SettingsNavItem`, `settingsNavGroups` and the gate that
 * filters them now live in lib/settings-nav.tsx, because the phone
 * navigation drawer shows the same sections and must agree with this one
 * about who may see Admin. Nothing about the list or the gate changed in
 * the move. */

/**
 * §229 — master–detail below `md`, the sidebar layout at `md` and above.
 * §230 — ...and in COMPACT LANDSCAPE, whatever the width.
 *
 * ── §230 item 1: what was wrong, measured ──────────────────────────────
 *
 * The owner, on a real iPhone on its side: "only landscape view in the
 * system settings is acting weird when scrolling, as you can see the UI
 * seems to change." His screenshot shows the right-hand content cut off
 * at one y with a different background below it.
 *
 * Reproduced in Chromium at 844x390 with touch emulation, against this
 * file as §229 left it. There were TWO scrollers stacked on one screen:
 *
 *   the shell's content div   y=44  h=346  scrollHeight 396  (50px over)
 *   this file's `main`        y=44  h=346  scrollHeight 1372
 *
 * The 50px belongs to the `aside`. Its nav is 325px tall and starts 71px
 * down, so in a 346px box it runs to y=440 — and the `aside` had no
 * `overflow` of its own, so that overflow grew the SHELL's scroller
 * instead. A finger on the left half therefore scrolled the shell, which
 * moves this whole `flex h-full` box up: measured, `main` went from
 * y=44/bottom=390 to y=-6/bottom=340, leaving 50px of the shell's own
 * background under the content. That is the line in his screenshot. A
 * finger on the right half scrolled `main` instead. Two scrollers, and
 * which one moves depends on where the finger lands — "the UI changes".
 *
 * Not the cause, checked and stated because it was the other candidate:
 * nothing in this subtree or in the shell is sized in `vh`. The shell is
 * `h-dvh`, and emulating the toolbar collapse (390 -> 500 -> 390 while
 * scrolled) re-measured correctly every time. What the collapse DOES do
 * is make the 50px of sidebar overflow appear and disappear — at 500px of
 * height the nav fits and the outer scroller is not scrollable at all —
 * so on a real phone the second scroller comes and goes mid-gesture.
 *
 * Two fixes, both here:
 *
 *   - the `aside` scrolls its own overflow (`min-h-0 overflow-y-auto`).
 *     Structural: a short window can no longer push a settings sidebar
 *     into the shell's scroller at ANY size, compact landscape or not.
 *   - in compact landscape the `aside` is not displayed at all, so there
 *     is exactly one scroller left on the screen. That rule is in
 *     globals.css next to §228c's block; see it for why it is written
 *     `:root [data-settings-touch] ...` rather than as a utility.
 *
 * Two things change on a phone and nothing changes on a desktop:
 *
 *   - the `aside` is `hidden md:block`. It used to be `flex`'s first child
 *     at every width, which is the owner's complaint: 224px of a 390px
 *     screen spent on a menu, leaving the Platform Users table ~134px.
 *   - a "‹ Settings" header appears above the section, `md:hidden`, so
 *     the list at `/settings` is reachable from every section page.
 *
 * Both are CSS breakpoints — `display: none` on a desktop, no JavaScript,
 * no hydration branch, and therefore nothing that can paint one layout
 * and then swap to the other. The ONE JS breakpoint in this area is on
 * `/settings` itself (page.tsx, which has to choose between rendering the
 * list and redirecting) and in the Admin users table (a card is a
 * different tree, not a restyled row).
 *
 * At ≥1024px the rendered box tree is identical to what it was: an
 * `aside` that is `display: block` either way, and a header that is
 * `display: none`. `overflow-y-auto` on the `aside` adds no box and no
 * scrollbar at any width where the nav fits, which is every desktop and
 * tablet size this is measured at.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const { user } = useAuthStore()
  const visibleGroups = useVisibleSettingsNav()

  // `/settings` itself is the list on a phone, so it is the one route that
  // gets no back header — it would point at itself.
  const isSectionList = pathname === '/settings'
  const activeItem = visibleGroups
    .flat()
    .find(
      (item) => pathname === item.href || pathname?.startsWith(item.href + '/'),
    )

  return (
    // `data-settings-touch` is the scope for §229's one stylesheet rule,
    // at the end of globals.css: a 36px floor under every control in
    // Settings, on touch screens only. It is an attribute rather than a
    // class so nothing can "tidy" it away as an unused utility.
    <div data-settings-touch className="flex h-full">
      {/* Settings Sidebar — `md`+ only (§229). */}
      <aside
        data-testid="settings-sidebar"
        // §230 — `min-h-0 overflow-y-auto`: a flex child's min-height is
        // its content by default, so without `min-h-0` this box refuses
        // to be shorter than its nav and the overflow lands on whatever
        // scrolls above it. Together they keep a too-tall sidebar inside
        // its own column. See the measurements at the top of this file.
        className="hidden md:block min-h-0 overflow-y-auto w-56 border-r border-border bg-bg-secondary shrink-0"
      >
        <div className="p-4 border-b border-border">
          <h2 className="text-sm font-semibold text-text-primary">Settings</h2>
          <p className="text-xs text-text-tertiary mt-0.5">
            {user?.name ?? 'User'}
          </p>
        </div>

        <nav className="p-2">
          {visibleGroups.map((group, index) => (
            <div
              key={group[0].href}
              data-testid="settings-nav-group"
              className={cn(
                'space-y-0.5',
                // The divider is the previous group's bottom border, so it
                // only ever exists between two groups that are both showing.
                index > 0 && 'mt-2 border-t border-border pt-2',
              )}
            >
              {group.map((item) => {
                const isActive =
                  pathname === item.href || pathname?.startsWith(item.href + '/')
                const Icon = item.icon

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                      isActive
                        ? 'bg-bg-hover text-text-primary font-medium'
                        : 'text-text-secondary hover:bg-bg-hover/70 hover:text-text-primary',
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
        </nav>
      </aside>

      {/* Settings Content */}
      <main className="flex-1 overflow-y-auto">
        {/* The way back up to the list, on phones only. A real `<Link>`
            rather than `router.back()`: Back is the browser's, and a
            section reached from a deep link or a reload has no history to
            go back to — this has to work there too. One history entry per
            navigation, and the list is never skipped. */}
        {!isSectionList && (
          <div
            data-testid="settings-back-header"
            // Opaque, not `/95`: the Admin tab strip scrolls underneath this and
            // showed through as a row of ghost pills.
            className="md:hidden sticky top-0 z-20 flex items-center gap-1 border-b border-border bg-bg-primary px-2 py-1.5"
          >
            <Link
              href="/settings"
              className="flex h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-2 text-sm text-text-secondary transition-colors active:bg-bg-hover"
            >
              <ChevronLeft className="h-4 w-4" />
              Settings
            </Link>
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
              {activeItem?.label ?? ''}
            </span>
          </div>
        )}
        {children}
      </main>
    </div>
  )
}
