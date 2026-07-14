'use client'

import { useEffect } from 'react'
import { useSiteSettings } from '@/hooks/use-site-settings'

/**
 * Swaps the browser tab's favicon at runtime when a workspace has a custom
 * one configured. Next.js's file-based app/favicon.ico convention already
 * renders a <link rel="icon"> on every page load, and generateMetadata in
 * app/layout.tsx now sets the correct custom one server-side for the very
 * first response too -- this component only needs to run when settings
 * change *after* that initial load (e.g. a superadmin uploads a new
 * favicon while a tab is already open), keeping an open tab in sync
 * without a full reload.
 *
 * Safari does not reliably repaint the tab icon when an existing
 * <link rel="icon">'s href is mutated in place -- it can keep showing the
 * old (or default) icon indefinitely. The fix that works consistently
 * across Chromium, Firefox and Safari is to remove every existing icon
 * link and insert a brand new element, so the browser treats it as a new
 * resource rather than an update to one it already resolved.
 */
export function FaviconInitializer() {
  const { faviconUrl } = useSiteSettings()

  useEffect(() => {
    if (!faviconUrl) return

    document.querySelectorAll<HTMLLinkElement>("link[rel~='icon']").forEach((el) => el.remove())

    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = faviconUrl
    document.head.appendChild(link)
  }, [faviconUrl])

  return null
}
