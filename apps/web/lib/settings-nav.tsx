'use client'

import { User, Bell, Shield, Palette, Brush, FolderKanban, LifeBuoy, SwatchBook } from 'lucide-react'
import type * as React from 'react'
import { useAuthStore } from '@/stores/auth-store'
import { useHasProjectPrivilege } from '@/hooks/use-project-privilege'

export interface SettingsNavItem {
  href: string
  label: string
  icon: React.ElementType
  adminOnly?: boolean
  // Projects tab: visible to superadmins AND superuser/admin/owner on at
  // least one project (its own non-superadmin branch), not admin-only.
  projectPrivilegeOnly?: boolean
}

/**
 * Grouped rather than flat, so a divider belongs to a group instead of
 * sitting at a fixed index. Every item here is gated individually, and
 * Projects/Admin/Branding are all conditional — an index-counted separator
 * would leave a stray line whenever the item beside it is hidden.
 * A group renders no divider when it has no visible items at all.
 */
export const settingsNavGroups: SettingsNavItem[][] = [
  [
    { href: '/settings/profile', label: 'Profile', icon: User },
    { href: '/settings/appearance', label: 'Appearance', icon: Palette },
    { href: '/settings/notifications', label: 'Notifications', icon: Bell },
    // Ungated: a personal LUT library is the user's own, not project- or
    // admin-scoped.
    { href: '/settings/luts', label: 'LUTs', icon: SwatchBook },
  ],
  [
    { href: '/settings/projects', label: 'Projects', icon: FolderKanban, projectPrivilegeOnly: true },
  ],
  [
    { href: '/settings/admin', label: 'Admin', icon: Shield, adminOnly: true },
    { href: '/settings/branding', label: 'Branding', icon: Brush, adminOnly: true },
  ],
  [
    // Ungated, and last: reaching a human is not an admin feature.
    { href: '/settings/contact', label: 'Contact', icon: LifeBuoy },
  ],
]

/**
 * The settings sections THIS user may see, grouped, with empty groups
 * dropped (§224b).
 *
 * Lifted out of app/(dashboard)/settings/layout.tsx unchanged, because the
 * phone navigation drawer now offers the same sections and a second copy
 * of "is this person an admin" is how two surfaces start disagreeing about
 * it. The Settings sub-nav and the drawer now read one list through one
 * gate; whoever can see Admin in the sidebar can see it in the drawer, by
 * construction rather than by both remembering the same rule.
 */
export function useVisibleSettingsNav(): SettingsNavItem[][] {
  const { isSuperAdmin } = useAuthStore()
  const hasProjectPrivilege = useHasProjectPrivilege()

  // Filter first, then drop empty groups, so the dividers at the call site
  // can be a simple "every group after the first" rule.
  return settingsNavGroups
    .map((group) =>
      group.filter((item) => {
        if (item.adminOnly && !isSuperAdmin) return false
        if (item.projectPrivilegeOnly && !hasProjectPrivilege) return false
        return true
      }),
    )
    .filter((group) => group.length > 0)
}
