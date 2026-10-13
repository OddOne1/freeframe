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
 * `display: none`.
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
        className="hidden md:block w-56 border-r border-border bg-bg-secondary shrink-0"
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
