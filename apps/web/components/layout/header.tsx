'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { Search, ChevronRight, PanelRightClose, PanelRightOpen, Menu } from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { useViewStore } from '@/stores/view-store'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'

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
  const { labels, extraCrumbs } = useBreadcrumbStore()
  const urlCrumbs = buildBreadcrumbs(pathname, labels)
  const breadcrumbs = [...urlCrumbs, ...extraCrumbs.map((c) => ({ label: c.label, href: c.href ?? '' }))]

  return (
    // Chrome color (top bar). bg-nav-bg / border-nav-border / text-nav-text
    // default to the same tokens as the rest of the theme (see globals.css)
    // but can be overridden per theme in Branding settings -> Theme colors.
    // Hover/active tints use nav-text at low opacity rather than a hardcoded
    // white so they still read correctly if nav-bg ends up light-colored.
    <header className="sticky top-0 z-20 flex h-11 items-center justify-between border-b border-nav-border bg-nav-bg px-4">
      {/* §224 — the way into the nav when the sidebar is off-canvas.
          44px square, because this is the one control a phone user needs
          before anything else. */}
      {onMobileNavOpen && (
        <button
          onClick={onMobileNavOpen}
          aria-label="Open navigation"
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
        {/* Search trigger */}
        <button
          onClick={onSearchOpen}
          className="flex items-center gap-1.5 rounded-md border border-nav-border bg-nav-text/5 px-2.5 py-1 text-xs text-nav-text/70 hover:border-nav-text/50 hover:text-nav-text transition-colors"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-nav-border bg-nav-text/10 px-1 py-0.5 font-mono text-[10px] text-nav-text/70">
            <span>⌘</span>K
          </kbd>
        </button>

        {/* Panel toggle — only on project detail pages, not the listing.
            §224 — and only at `md`+: below that the project view's bottom
            tab bar owns the panel, so this would be a second control for
            the same thing that appears to do nothing (it writes
            `rightPanelOpen`, which the phone pane does not read). Fixing
            one dead button by adding another would not be a fix. */}
        {pathname !== '/projects' && (
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
