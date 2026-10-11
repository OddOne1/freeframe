'use client'

import * as React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Layers,
  Bell,
  Upload,
  User,
  ChevronsLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { useUploadStore } from '@/stores/upload-store'
import { useNotificationStore } from '@/stores/notification-store'
import { useSiteSettings } from '@/hooks/use-site-settings'
import { useThemeStore } from '@/stores/theme-store'
import { Avatar } from '@/components/shared/avatar'
import { NotificationDrawer } from './notification-drawer'
import { SidebarUserBlock } from './sidebar-user-block'

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
}

const navItems: NavItem[] = [
  { href: '/projects', label: 'Projects', icon: Layers },
]

interface SidebarProps {
  collapsed: boolean
  onToggle: () => void
  /** §224 — below `md` this is an off-canvas drawer; `collapsed` is the
   *  desktop rail preference and is deliberately not consulted there. */
  mobileOpen?: boolean
  onMobileClose?: () => void
}

export function Sidebar({
  collapsed,
  onToggle,
  mobileOpen = false,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname()
  const { user } = useAuthStore()
  const { files: uploadFiles, togglePanel, panelOpen } = useUploadStore()
  const { unreadCount, fetchNotifications } = useNotificationStore()
  const { orgName, logoDarkUrl, logoLightUrl } = useSiteSettings()
  const { resolvedTheme } = useThemeStore()
    // Pick logo based on resolved theme; fall back to the other if only one is set.
    // Uses resolvedTheme (not theme) because theme can be 'system', which never
    // strictly equals 'light' — that bug pinned the logo to the dark variant
    // whenever the user had 'system' selected instead of an explicit theme.
  const customLogo = resolvedTheme === 'light'
    ? (logoLightUrl ?? logoDarkUrl)
    : (logoDarkUrl ?? logoLightUrl)
  const [notifOpen, setNotifOpen] = React.useState(false)
  /**
   * §224 — whether rows show their labels and full-width hit areas.
   *
   * Not `!collapsed` any more: the mobile drawer is 244px wide, so a rail's
   * icon-only rows inside it would waste the width and leave nothing to aim
   * at. `mobileOpen` is false on every desktop render, so at `md`+ this is
   * exactly `!collapsed` and nothing about the rail changed.
   */
  const expanded = mobileOpen || !collapsed
  const activeUploads = uploadFiles.filter((f) => f.status === 'uploading' || f.status === 'pending' || f.status === 'paused' || f.status === 'processing').length

  // Fetch notifications on mount
  React.useEffect(() => { fetchNotifications() }, [fetchNotifications])

  return (
    <>
    {/* §224 — the scrim. Below `md` only, and only while the drawer is
        open: at `md`+ the sidebar is a rail in the layout and dimming the
        page behind it would make no sense.
        §224b — z-[45], above the project view's bottom tab bar (z-40).
        At z-30 the tab bar floated over the dimmed page looking live,
        and tapping it switched a pane nobody could see. */}
    {mobileOpen && (
      <div
        data-testid="mobile-nav-scrim"
        className="fixed inset-0 z-[45] bg-black/60 md:hidden"
        onClick={onMobileClose}
      />
    )}
    <aside
      data-testid="app-sidebar"
      className={cn(
        // h-dvh rather than h-screen, so the bottom section is reachable
        // inside iOS Safari's visible viewport (§224).
        // §224b — z-50 below `md`: the phone tab bar is fixed at z-40 and
        // comes later in the DOM, so at z-40 it painted over the foot of
        // this drawer and hid the whole user block. `md:z-30` below is
        // unchanged, so the desktop rail still sits where it did.
        'fixed left-0 top-0 z-50 flex h-dvh flex-col border-r border-nav-border',
        // bg-nav-bg defaults to the same token as the rest of the theme (see
        // globals.css) but can be overridden per theme in Branding settings ->
        // Theme colors.
        'bg-nav-bg transition-[width,transform] duration-200 overflow-hidden',
        // §224 — below `md`: a fixed-width drawer that slides in from the
        // left. `transform` rather than conditional rendering, so it
        // animates and so its contents keep their state while closed.
        'max-md:w-[244px] max-md:shadow-2xl',
        mobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full',
        // At `md`+, untouched: the rail/expanded widths and z-30 as before.
        'md:translate-x-0 md:z-30',
        collapsed ? 'md:w-[52px]' : 'md:w-[192px]',
        // The base width is the desktop one; `max-md:w-[244px]` above wins
        // below `md`. The drawer is never the 52px rail, which is why
        // `expanded` below is not simply `!collapsed`.
        collapsed ? 'w-[52px]' : 'w-[192px]',
      )}
    >
      {/* Logo — click to go home. h-11 (44px) to match the global Header
          bar's height (also h-11) so the border-b line here lines up with
          the Header's border-b across the whole app. */}
      <Link
        href="/projects"
        className={cn(
          'flex h-11 items-center shrink-0 border-b border-nav-border hover:bg-nav-text/10 transition-colors',
          !expanded ? 'justify-center px-0' : 'px-4 gap-2.5',
        )}
        title="Go to Projects"
      >
        {/* Logo: theme-aware custom logo, or default FreeFrame icons */}
        {customLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={customLogo}
            alt={orgName}
            className="h-7 w-7 shrink-0 object-contain rounded"
          />
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-dark"
            />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/logo-icon-dark.png"
              alt={orgName}
              className="h-7 w-7 shrink-0 object-contain logo-light"
            />
          </>
        )}
        {expanded && (
          <span className="text-sm font-semibold text-nav-text tracking-tight">
            {orgName}
          </span>
        )}
      </Link>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 px-2 space-y-0.5">
        {navItems.map((item) => {
          const isActive =
            item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => { setNotifOpen(false); onMobileClose?.() }}
              className={cn(
                'group relative flex items-center rounded-md transition-colors duration-100',
                !expanded ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9 max-md:h-11',
                isActive
                  ? 'bg-nav-text/15 text-nav-text'
                  : 'text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text',
              )}
              title={!expanded ? item.label : undefined}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={isActive ? 2 : 1.5} />
              {expanded && (
                <span className={cn('text-[13px]', isActive && 'font-medium')}>
                  {item.label}
                </span>
              )}
            </Link>
          )
        })}

        {/* Notifications button */}
        <button
          onClick={() => setNotifOpen((v) => !v)}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            !expanded ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9 max-md:h-11',
            notifOpen
              ? 'bg-nav-text/15 text-nav-text'
              : 'text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text',
          )}
          title={!expanded ? 'Notifications' : undefined}
        >
          <div className="relative shrink-0">
            <Bell className="h-[18px] w-[18px]" strokeWidth={notifOpen ? 2 : 1.5} />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-error px-0.5 text-[9px] font-bold text-white">
                {unreadCount}
              </span>
            )}
          </div>
          {expanded && (
            <span className={cn('text-[13px]', notifOpen && 'font-medium')}>
              Notifications
            </span>
          )}
        </button>

        {/* Uploads button */}
        <button
          onClick={() => { setNotifOpen(false); togglePanel() }}
          className={cn(
            'group relative flex w-full items-center rounded-md transition-colors duration-100',
            !expanded ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2.5 h-9 max-md:h-11',
            panelOpen
              ? 'bg-nav-text/15 text-nav-text'
              : 'text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text',
          )}
          title={!expanded ? 'Uploads' : undefined}
        >
          <div className="relative shrink-0">
            <Upload className="h-[18px] w-[18px]" strokeWidth={panelOpen ? 2 : 1.5} />
            {activeUploads > 0 && (
              <span className="absolute -top-1 -right-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-nav-text px-0.5 text-[9px] font-bold text-nav-bg">
                {activeUploads}
              </span>
            )}
          </div>
          {expanded && (
            <span className={cn('text-[13px]', panelOpen && 'font-medium')}>
              Uploads
            </span>
          )}
        </button>
      </nav>

      {/* Bottom section */}
      {/* §224b — below `md` this block holds the whole user menu, which on
          a short phone can be taller than what is left of the drawer; the
          cap plus its own scroll keeps Log out reachable without taking
          height away from the nav above. Both are `max-md:`, so the
          desktop rail's bottom section is untouched. */}
      <div className="border-t border-nav-border p-2 space-y-1 shrink-0 max-md:max-h-[70dvh] max-md:overflow-y-auto">
        {/* The avatar is a plain link now, not a menu (§46). Settings itself
            already gates what each user sees once they arrive, so the old
            per-role routing between /settings/admin and /settings/projects
            was picking a destination the destination already handles. Log
            out moved to the Profile page, which is where this lands. */}
        <Link
          href="/settings/profile"
          title={!expanded ? (user?.name ?? 'Account') : undefined}
          className={cn(
            'flex w-full items-center rounded-md text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text transition-colors',
            !expanded ? 'justify-center h-9 w-9 mx-auto' : 'gap-2.5 px-2 py-1.5 max-md:py-2.5',
          )}
        >
          <Avatar src={user?.avatar_url} name={user?.name} size="sm" />
          {expanded && (
            <div className="flex flex-col items-start overflow-hidden min-w-0">
              <span className="truncate text-[13px] font-medium text-nav-text leading-tight w-full text-left">
                {user?.name ?? 'User'}
              </span>
              <span className="truncate text-[10px] text-nav-text/50 leading-tight w-full text-left">
                {user?.email ?? ''}
              </span>
            </div>
          )}
        </Link>

        {/* Collapse toggle — desktop only (§224): below `md` there is no
            rail to collapse to, and the drawer is dismissed by the scrim,
            Escape or navigating. */}
        <button
          onClick={onToggle}
          data-testid="sidebar-collapse-toggle"
          className={cn(
            'flex w-full items-center rounded-md text-nav-text/50 hover:bg-nav-text/10 hover:text-nav-text transition-colors',
            'max-md:hidden', !expanded ? 'justify-center h-8 w-8 mx-auto' : 'gap-2 px-2.5 h-8',
          )}
          title={!expanded ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronsLeft className={cn('h-4 w-4 transition-transform', !expanded && 'rotate-180')} />
          {expanded && <span className="text-xs">Collapse</span>}
        </button>

        {/* §224b — mounted only while the drawer is open. It is `md:hidden`
            as well, but gating on `mobileOpen` keeps it out of every
            desktop render too.
            §227 — it is Log out now, and nothing else: the user row is the
            avatar link directly above, which the rail and the drawer share,
            and the settings sections live behind it on the Settings page
            rather than beside it in the drawer. Tapping the avatar row
            closes the drawer by itself — DashboardShell closes it on every
            pathname change. */}
        {mobileOpen && <SidebarUserBlock />}
      </div>
    </aside>

    {/* Notification Drawer */}
    <NotificationDrawer open={notifOpen} onClose={() => setNotifOpen(false)} />
  </>
  )
}
