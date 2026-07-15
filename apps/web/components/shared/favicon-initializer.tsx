'use client'

import { useEffect } from 'react'
import { useSiteSettings } from '@/hooks/use-site-settings'

// Marker attribute so this component can find and remove *only* the extra
// link element it created itself -- never the one Next's App Router
// head-metadata system rendered from generateMetadata's icons field in
// app/layout.tsx. That SSR'd link is part of React's own fiber tree and
// tracked across client-side navigations; removing it out from under React
// crashes the app on the next route change with "TypeError: null is not an
// object (evaluating '(n=n.stateNode).parentNode.removeChild')" -- a full
// page reload always looked fine (fresh fiber tree), which made this easy
// to miss in testing. A previous version of this component did exactly
// that and had to be fixed.
const REFRESH_MARKER = 'data-ff-favicon-refresh'

/**
 * Swaps the browser tab's favicon at runtime when a workspace has a custom
 * one configured. Next.js's file-based app/favicon.ico convention already
 * renders a default <link rel="icon"> on every page load, and
 * generateMetadata in app/layout.tsx now sets the correct custom one
 * server-side for the very first response too -- this component only
 * needs to run when settings change *after* that initial load (e.g. a
 * superadmin uploads a new favicon while a tab is already open elsewhere),
 * keeping an open tab in sync without a full reload.
 *
 * Two things happen on every faviconUrl change:
 * 1. The React/SSR-owned <link rel="icon"> has its href mutated in place
 *    (safe -- never removed, so React's own reconciliation is untouched).
 * 2. A second, separately marked <link rel="icon"> -- created and owned
 *    entirely by this component -- is removed and re-inserted fresh. Since
 *    React never rendered this element, doing this is always safe, and
 *    Safari treats a brand-new DOM insertion as a genuinely new resource,
 *    which works around Safari's known failure to repaint the tab icon on
 *    an in-place href mutation alone. It's appended after the primary
 *    link so it takes priority in the browsers that respect DOM order for
 *    same-priority icon links.
 */
export function FaviconInitializer() {
  const { faviconUrl } = useSiteSettings()

  useEffect(() => {
    if (!faviconUrl) return

    // 1. Mutate the SSR-owned link in place -- React keeps ownership.
    const primary = document.querySelector<HTMLLinkElement>("link[rel~='icon']:not([" + REFRESH_MARKER + "])")
    if (primary && primary.href !== faviconUrl) {
      primary.href = faviconUrl
    }

    // 2. Remove and recreate only our own marked link -- React never
    //    tracks this element, so this is safe on every navigation.
    document.querySelectorAll<HTMLLinkElement>('link[' + REFRESH_MARKER + ']').forEach((el) => el.remove())
    const refreshLink = document.createElement('link')
    refreshLink.rel = 'icon'
    refreshLink.href = faviconUrl
    refreshLink.setAttribute(REFRESH_MARKER, '')
    document.head.appendChild(refreshLink)
  }, [faviconUrl])

  return null
}
