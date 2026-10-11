'use client'

import * as React from 'react'
import { LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'

/**
 * The foot of the navigation drawer, on screens with no rail (§227).
 *
 * §224b put the ENTIRE settings list in here — Profile, Appearance,
 * Notifications, LUTs, Projects, Admin, Branding, Contact, plus a storage
 * row — because the advisor's specification asked for "whatever the
 * desktop avatar menu offers, including admin entries". That was the
 * advisor's mistake, not an implementation slip: the drawer exists so the
 * USER stays reachable on a phone, where §224 hid the avatar behind the
 * bottom tab bar. It was never meant to become a second Settings menu,
 * and a nav drawer that lists eight settings sections is one.
 *
 * So the drawer's bottom block is now the two things it was for:
 *
 *   - the user row — avatar, name, email — as ONE link to Settings. That
 *     row is the sidebar's own avatar link, directly above this component
 *     in `sidebar.tsx`: it is the same row the desktop rail shows, at every
 *     width, and duplicating it here for the drawer is how the two would
 *     start disagreeing about where the avatar goes. §229 turns the
 *     settings landing into a list on phones, which is where the sections
 *     belong — behind that one link, not beside it.
 *   - Log out, which is below, because signing out is not a settings
 *     section and the rail has nowhere else to put it on a phone.
 *
 * `useVisibleSettingsNav` is untouched and still lives in
 * lib/settings-nav.ts: the Settings page's own sub-nav reads it, which is
 * the surface that list was always for.
 *
 * `md:hidden`: at `md`+ the rail is back and the avatar row above is
 * reachable on its own, with Log out on the Profile page it leads to.
 */
export function SidebarUserBlock() {
  const { user, logout } = useAuthStore()

  return (
    <div data-testid="sidebar-user-block" className="md:hidden">
      <button
        onClick={logout}
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
          'text-status-error hover:bg-status-error/10',
        )}
      >
        <LogOut className="h-[18px] w-[18px] shrink-0" strokeWidth={1.5} />
        <span>Log out</span>
      </button>

      {/* The drawer's own bottom padding has to clear the iPhone home
          indicator. §227 removed the project view's bottom tab bar, so
          there is no longer any chance of another element's inset padding
          happening to cover this one. */}
      <div className="h-[env(safe-area-inset-bottom)]" />
      {user === null && <span className="sr-only">Not signed in</span>}
    </div>
  )
}
