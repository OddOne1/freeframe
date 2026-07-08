'use client'

import { useEffect } from 'react'
import { useSiteSettings } from '@/hooks/use-site-settings'
import {
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  deriveThemeTokens,
  buildCssText,
} from '@/lib/color-utils'

const STYLE_ID = 'custom-theme-colors'

/**
 * Injects a <style> tag overriding the per-theme CSS custom properties
 * (--bg-primary, --accent, --nav-bg, etc.) whenever a superadmin has set
 * custom colors in Branding settings -> Theme colors. Leaves globals.css's
 * own defaults (the original FreeFrame palette) untouched when nothing is
 * customized -- this is purely additive, no custom colors means no style
 * tag at all.
 */
export function ThemeColorsInitializer() {
  const { themeColors } = useSiteSettings()

  useEffect(() => {
    let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null

    if (!themeColors || (!themeColors.light && !themeColors.dark)) {
      styleEl?.remove()
      return
    }

    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = STYLE_ID
      document.head.appendChild(styleEl)
    }

    let css = ''
    if (themeColors.dark) {
      const merged = { ...DEFAULT_DARK_TOKENS, ...themeColors.dark }
      css += buildCssText(deriveThemeTokens(merged), '[data-theme="dark"]')
    }
    if (themeColors.light) {
      const merged = { ...DEFAULT_LIGHT_TOKENS, ...themeColors.light }
      css += buildCssText(deriveThemeTokens(merged), '[data-theme="light"]')
    }
    styleEl.textContent = css
  }, [themeColors])

  return null
}
