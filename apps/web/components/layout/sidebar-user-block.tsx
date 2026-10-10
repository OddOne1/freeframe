'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogOut, HardDrive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useVisibleSettingsNav } from '@/lib/settings-nav'
import { useStorageSummary } from '@/hooks/use-storage-summary'
import { useFormatBytes } from '@/hooks/use-byte-units'

/**
 * Everything behind the avatar, for the screens that have no rail (§224b).
 *
 * On a desktop the avatar at the foot of the sidebar is a plain link to
 * /settings/profile (§46 removed the popup menu), and the Settings page's
 * own sub-nav is what offers Profile / Appearance / Admin / Branding and
 * the rest. Below `md` that rail is an off-canvas drawer, and §224 left
 * this block below the bottom tab bar — so a phone had no profile, no
 * admin entry, no storage and no way to sign out at all.
 *
 * The section list and its permission gate come from `useVisibleSettingsNav`,
 * the same hook the Settings sub-nav itself now reads, so an admin sees
 * Admin here exactly when they see it there. The storage figure comes from
 * `useStorageSummary`, which is the Projects settings page's own number.
 * Neither is re-derived here.
 *
 * `md:hidden`: at `md`+ the rail is back and this would be a second,
 * differently-shaped copy of the Settings page. Nothing about the desktop
 * sidebar changes.
 */
export function SidebarUserBlock({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  const { user, logout } = useAuthStore()
  const groups = useVisibleSettingsNav()
  const { usedBytes, personalTotalBytes, ownedProjects } = useStorageSummary()
  const formatBytes = useFormatBytes()

  const rowClass =
    'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors'

  return (
    <div data-testid="sidebar-user-block" className="md:hidden">
      {groups.map((group, index) => (
        <div
          key={group[0].href}
          data-testid="drawer-settings-group"
          className={cn('space-y-0.5', index > 0 && 'mt-1.5 border-t border-nav-border pt-1.5')}
        >
          {group.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href || pathname?.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  rowClass,
                  isActive
                    ? 'bg-nav-text/15 text-nav-text'
                    : 'text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text',
                )}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.5} />
                <span className={cn(isActive && 'font-medium')}>{item.label}</span>
              </Link>
            )
          })}
        </div>
      ))}

      {/* Storage, for the people it means something to: a user who owns no
          project has no allowance in use and nothing to report. Same
          number, same wording as the Projects settings page. */}
      {ownedProjects.length > 0 && (
        <div
          data-testid="drawer-storage"
          className="mt-1.5 flex items-center gap-2.5 border-t border-nav-border px-2.5 pb-1 pt-2.5 text-[13px] text-nav-text/60"
        >
          <HardDrive className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />
          <span>
            {formatBytes(usedBytes)} used of{' '}
            {personalTotalBytes !== null ? formatBytes(personalTotalBytes) : 'an unlimited'} total
          </span>
        </div>
      )}

      <button
        onClick={logout}
        className={cn(rowClass, 'mt-1.5 text-status-error hover:bg-status-error/10')}
      >
        <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />
        <span>Log out</span>
      </button>

      {/* The drawer's own bottom padding has to clear the iPhone home
          indicator; the sidebar sits above the tab bar now, so the tab
          bar's own inset padding is no longer doing it for this block. */}
      <div className="h-[env(safe-area-inset-bottom)]" />
      {user === null && <span className="sr-only">Not signed in</span>}
    </div>
  )
}
