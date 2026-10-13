'use client'

import * as React from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/shared/avatar'
import { useAuthStore } from '@/stores/auth-store'
import { useVisibleSettingsNav } from '@/lib/settings-nav'

/**
 * `/settings` on a phone: the list of sections, master–detail (§229).
 *
 * The owner, looking at Settings on an iPhone: "The System/User Settings
 * don't work at all in mobile view, everything is squeezed together, the
 * menu on the left never disappears." The 224px sidebar was `flex` at
 * every width, so a 390px screen had ~134px left for the content — the
 * Platform Users table in his screenshot was cut off mid-name.
 *
 * So below `md` the sidebar does not exist and `/settings` IS the menu:
 * one row per section, and the section opens as a full-width page with a
 * "‹ Settings" header (rendered by the settings layout) to come back.
 *
 * The icons STAY, with their labels beside them — the owner's own note is
 * "we already have the icons on the different settings", and an icon-only
 * rail would be asking somebody to recognise Admin, Branding and LUTs from
 * a glyph. 52px rows: above the 44px touch floor, and tall enough that the
 * list reads as a menu rather than as a dense table.
 *
 * Gating is `useVisibleSettingsNav` — the same call the desktop sub-nav
 * makes, not a copy of its rule. A second gate here is how the two would
 * start disagreeing about who sees Admin.
 */
export function SettingsSectionList() {
  const { user } = useAuthStore()
  const visibleGroups = useVisibleSettingsNav()

  return (
    <div data-testid="settings-section-list">
      {/* Who this is. The desktop sidebar's header says the same thing in
          its own corner; on a phone the list is the whole screen, so the
          name and address belong at the top of it. */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-4">
        <Avatar src={user?.avatar_url} name={user?.name} colorSeed={user?.id} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">
            {user?.name ?? 'User'}
          </p>
          <p className="truncate text-xs text-text-tertiary">{user?.email ?? ''}</p>
        </div>
      </div>

      <nav className="p-2" aria-label="Settings sections">
        {visibleGroups.map((group, index) => (
          <div
            key={group[0].href}
            data-testid="settings-section-group"
            className={cn(
              // Same divider rule as the sidebar: the previous group's
              // bottom border, so it only exists between two groups that
              // are both showing.
              index > 0 && 'mt-2 border-t border-border pt-2',
            )}
          >
            {group.map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-testid="settings-section-row"
                  className="flex h-[52px] items-center gap-3 rounded-md px-3 text-sm text-text-primary transition-colors active:bg-bg-hover"
                >
                  <Icon
                    className="h-[18px] w-[18px] shrink-0 text-text-tertiary"
                    strokeWidth={1.5}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" />
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* The list is the last thing above the iPhone home indicator. */}
      <div className="h-[env(safe-area-inset-bottom)]" />
    </div>
  )
}
