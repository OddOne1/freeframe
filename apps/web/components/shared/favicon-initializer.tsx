'use client'

import { useEffect } from 'react'
import { useSiteSettings } from '@/hooks/use-site-settings'

/**
 * Swaps the browser tab's favicon at runtime when a workspace has a custom
 * one configured. Next.js's file-based app/favicon.ico convention already
 * renders a <link rel="icon"> on every page load -- this only touches that
 * link (or adds one, if for whatever reason it's missing) once a custom
 * favicon URL comes back from the site-settings API, and leaves the default
 * completely alone when no custom favicon is set.
 */
export function FaviconInitializer() {
  const { faviconUrl } = useSiteSettings()

  useEffect(() => {
    if (!faviconUrl) return

    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = faviconUrl
  }, [faviconUrl])

  return null
}
