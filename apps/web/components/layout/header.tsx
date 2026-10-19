'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Search, ChevronRight, PanelRightClose, PanelRightOpen, Menu, Settings } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useViewStore } from '@/stores/view-store'
import { useRightPanelStore } from '@/stores/right-panel-store'
import { useBreadcrumbsFor } from '@/stores/breadcrumb-store'
import {
  useMobileViewSettingsStore,
  pathHasMobileViewSettings,
} from '@/stores/mobile-view-settings-store'

interface HeaderProps {
  onSearchOpen: () => void
  /** §224 — opens the off-canvas nav drawer. Only rendered below `md`,
   *  where the sidebar is not in the layout. */
  onMobileNavOpen?: () => void
}

const LABEL_MAP: Record<string, string> = {
  projects: 'Projects',
  notifications: 'Notifications',
  settings: 'Settings',
  new: 'New',
  upload: 'Upload',
}

/** Looks like a UUID (8-4-4-4-12 hex) */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

/**
 * Route path segments that are structural only and should not appear in the breadcrumb.
 * e.g. /projects/{id}/assets/{assetId} — "assets" is just a route prefix, not a meaningful label.
 */
const SKIP_SEGMENTS = new Set(['assets', 'collections'])

function buildBreadcrumbs(pathname: string, dynamicLabels: Record<string, string>): { label: string; href: string }[] {
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; href: string }[] = []

  let path = ''
  for (const segment of segments) {
    path += `/${segment}`
    // Skip structural route segments
    if (SKIP_SEGMENTS.has(segment)) continue
    // Skip UUID segments that don't have a label registered
    if (isUuid(segment) && !dynamicLabels[segment]) continue
    const label =
      dynamicLabels[segment] ??
      LABEL_MAP[segment] ??
      segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ')
    crumbs.push({ label, href: path })
  }

  return crumbs
}

export function Header({ onSearchOpen, onMobileNavOpen }: HeaderProps) {
  const pathname = usePathname()
  const { rightPanelOpen, toggleRightPanel } = useViewStore()
  // §232 item 2 — does the page currently on screen have a right panel?
  const panelAvailable = useRightPanelStore((s) => s.available)
  // §227 — scoped to THIS pathname. The Header never unmounts on a route
  // change, and the crumbs are written by the pages, so an unscoped read
  // appended an asset's folder path and name to every page the user went
  // to next: `Settings > Admin > src > Video > ... > A010C030....MXF`, and
  // on a phone, which shows only the last crumb, the Projects list read
  // `> Fabio_close`. The store now keeps the pathname each entry was
  // written for and this hands back only the matching one.
  const { labels, extraCrumbs } = useBreadcrumbsFor(pathname)
  // §227 — the phone view-settings pane, which §224 opened from a bottom
  // tab bar that no longer exists on the project view.
  const viewSettingsOpen = useMobileViewSettingsStore((s) => s.open)
  const toggleViewSettings = useMobileViewSettingsStore((s) => s.toggle)
  const hasViewSettings = pathHasMobileViewSettings(pathname)
  const urlCrumbs = buildBreadcrumbs(pathname, labels)
  const breadcrumbs = [...urlCrumbs, ...extraCrumbs.map((c) => ({ label: c.label, href: c.href ?? '' }))]

  return (
    // Chrome color (top bar). bg-nav-bg / border-nav-border / text-nav-text
    // default to the same tokens as the rest of the theme (see globals.css)
    // but can be overridden per theme in Branding settings -> Theme colors.
    // Hover/active tints use nav-text at low opacity rather than a hardcoded
    // white so they still read correctly if nav-bg ends up light-colored.
    // `data-app-header` is a scope, not a style: §230's compact-landscape
    // block slims this bar to 36px and un-hides the `≡`, and it needs one
    // selector that cannot be tidied away as an unused utility class.
    <header
      data-app-header
      className="sticky top-0 z-20 flex h-11 items-center justify-between border-b border-nav-border bg-nav-bg px-4"
    >
      {/* §224 — the way into the nav when the sidebar is off-canvas.
          44px square, because this is the one control a phone user needs
          before anything else. */}
      {onMobileNavOpen && (
        <button
          data-testid="header-nav-open"
          onClick={onMobileNavOpen}
          aria-label="Open navigation"
          // §230 — still `md:hidden`. In compact landscape the rail is the
          // §227 drawer at 844px wide too, and the CSS block puts this back
          // rather than a JS branch: the button is always RENDERED (the
          // shell passes the handler at every width), so what changes is
          // only whether it is drawn.
          className="md:hidden -ml-2 mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-nav-text/70 hover:bg-nav-text/10 hover:text-nav-text transition-colors"
        >
          <Menu className="h-5 w-5" />
        </button>
      )}

      {/* Breadcrumbs. `min-w-0` + truncation so a long project name cannot
          push the right-hand actions off a 390px screen (§224). */}
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px]">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1
          return (
            <React.Fragment key={`${crumb.href}-${index}`}>
              {index > 0 && (
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-nav-text/40',
                    // Hidden below `sm` unless it precedes the last crumb,
                    // which is the only one shown there.
                    !isLast && 'hidden sm:block',
                  )}
                />
              )}
              {isLast ? (
                <span className="truncate font-medium text-nav-text">{crumb.label}</span>
              ) : crumb.href ? (
                <Link
                  href={crumb.href}
                  className="hidden truncate text-nav-text/70 transition-colors hover:text-nav-text sm:block"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="hidden truncate text-nav-text/70 sm:block">{crumb.label}</span>
              )}
            </React.Fragment>
          )
        })}
      </nav>

      {/* Right side actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {/* §227 — the cogwheel: card size, thumbnail scale, layout, aspect
            ratio, card info, titles, flatten folders, fields and sort, as a
            full-screen pane. It replaces the bottom tab bar's Settings tab,
            which went with the bar (the owner's decision: Assets /
            Comments / Settings only make sense inside an asset).

            Immediately LEFT of Search, as asked, which is why it is the
            first child of this group rather than appended after it.

            `md:hidden`: at `md`+ every one of those controls is back in
            the toolbar's own two popovers, which render the SAME
            components the pane does — a second route to them here would
            be a duplicate, not a convenience. Project and folder pages
            only; `pathHasMobileViewSettings` is what decides that, and
            the pane itself lives in projects/[id]/page.tsx. */}
        {hasViewSettings && (
          <button
            data-testid="header-view-settings"
            onClick={toggleViewSettings}
            aria-label="View settings"
            aria-expanded={viewSettingsOpen}
            title="View settings"
            className={cn(
              // 44px, the same target as the hamburger on the other side.
              'md:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors',
              viewSettingsOpen
                ? 'bg-nav-text/15 text-nav-text'
                : 'text-nav-text/70 hover:bg-nav-text/10 hover:text-nav-text',
            )}
          >
            <Settings className="h-5 w-5" />
          </button>
        )}

        {/* Search trigger.
            §229 — `hover-none:h-9`: the box is 36x24 and it is the only
            sub-36px target left on four of the Settings pages at 390px.
            Touch-only, so the mouse keeps the 24px chip exactly as it
            is at every width. */}
        <button
          onClick={onSearchOpen}
          className="flex items-center gap-1.5 rounded-md border border-nav-border bg-nav-text/5 px-2.5 py-1 text-xs text-nav-text/70 hover:border-nav-text/50 hover:text-nav-text transition-colors hover-none:h-9 hover-none:px-3"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-nav-border bg-nav-text/10 px-1 py-0.5 font-mono text-[10px] text-nav-text/70">
            <span>⌘</span>K
          </kbd>
        </button>

        {/* Panel toggle — only where there IS a panel to toggle.
            §232 item 2 — the condition was `pathname !== '/projects'`,
            which was wrong in both directions once the project/folder
            view's panel was removed: it would still render here with
            nothing to open (the §224 "dead toggle" bug all over again),
            and it was ALREADY rendering on /assets, /notifications, every
            /settings page and /projects/{id}/collections, none of which
            has ever had a panel — nothing but the project page reads
            `rightPanelOpen`.
            The page that renders a panel says so instead, through
            `right-panel-store`. Today that is the share-link Settings /
            Activity panel and nothing else.
            §224 — and still only at `md`+: below that the panel is not
            rendered at any width. */}
        {panelAvailable && (
          <button
            onClick={toggleRightPanel}
            className={cn(
              // 44px on touch, 28px with a mouse: this is the control §224
              // exists to fix, so it has to be hittable with a thumb.
              'hidden md:flex h-7 w-7 items-center justify-center rounded-md transition-colors hover-none:h-11 hover-none:w-11',
              rightPanelOpen
                ? 'text-accent-foreground bg-nav-text/15'
                : 'text-nav-text/60 hover:bg-nav-text/10 hover:text-nav-text',
            )}
            title={rightPanelOpen ? 'Hide panel' : 'Show panel'}
            aria-label={rightPanelOpen ? 'Hide panel' : 'Show panel'}
            aria-pressed={rightPanelOpen}
          >
            {rightPanelOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </header>
  )
}
