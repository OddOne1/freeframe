'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import { resolveApiMediaUrl } from '@/lib/utils'
import type { ThemeColorTokens } from '@/lib/color-utils'
import type { SiteSettingsResponse } from '@/types'

const SITE_SETTINGS_KEY = '/site-settings'

type LogoSide = 'dark' | 'light' | 'login'
type ColorTheme = 'light' | 'dark'

const LOGO_FIELD: Record<LogoSide, string> = {
  dark: 'logo_dark_s3_key',
  light: 'logo_light_s3_key',
  login: 'logo_login_s3_key',
}

/**
 * Site-wide branding settings (org name + per-theme logo), shared across the
 * whole app via SWR's cache — every component calling this hook reads/writes
 * the same underlying data, so an update in the branding settings page shows
 * up in the sidebar (and anywhere else) without any extra plumbing.
 */
export function useSiteSettings() {
  const { data, isLoading, mutate } = useSWR<SiteSettingsResponse>(
    SITE_SETTINGS_KEY,
    (key: string) => api.get<SiteSettingsResponse>(key),
  )

  async function updateOrgName(orgName: string): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      org_name: orgName,
    })
    await mutate(updated, false)
  }

  async function uploadLogo(side: LogoSide, file: File): Promise<void> {
    const { upload_url, key } = await api.post<{ upload_url: string; key: string }>(
      `/site-settings/logo-upload?side=${side}`,
    )
    const putResponse = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: file,
    })
    if (!putResponse.ok) {
      throw new Error(`Logo upload failed: ${putResponse.statusText}`)
    }
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      [LOGO_FIELD[side]]: key,
    })
    await mutate(updated, false)
  }

  async function removeLogo(side: LogoSide): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      [LOGO_FIELD[side]]: null,
    })
    await mutate(updated, false)
  }

  async function uploadFavicon(file: File): Promise<void> {
    const { upload_url, key } = await api.post<{ upload_url: string; key: string }>(
      '/site-settings/favicon-upload',
    )
    const putResponse = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: file,
    })
    if (!putResponse.ok) {
      throw new Error(`Favicon upload failed: ${putResponse.statusText}`)
    }
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      favicon_s3_key: key,
    })
    await mutate(updated, false)
  }

  async function removeFavicon(): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      favicon_s3_key: null,
    })
    await mutate(updated, false)
  }

  /** Merges a partial set of base-token overrides into one theme's custom colors. */
  async function updateThemeColors(theme: ColorTheme, tokens: Partial<ThemeColorTokens>): Promise<void> {
    const current = data?.theme_colors ?? {}
    const updatedColors = {
      ...current,
      [theme]: { ...(current[theme] ?? {}), ...tokens },
    }
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      theme_colors: updatedColors,
    })
    await mutate(updated, false)
  }

  /** Clears one theme's custom colors (falls back to the original palette), or both if no theme is given. */
  async function resetThemeColors(theme?: ColorTheme): Promise<void> {
    let updatedColors: Record<string, unknown> | null
    if (!theme) {
      updatedColors = null
    } else {
      const current = { ...(data?.theme_colors ?? {}) }
      delete current[theme]
      updatedColors = Object.keys(current).length > 0 ? current : null
    }
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      theme_colors: updatedColors,
    })
    await mutate(updated, false)
  }

  async function resetAll(): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      org_name: 'FreeFrame',
      logo_dark_s3_key: null,
      logo_light_s3_key: null,
      logo_login_s3_key: null,
      favicon_s3_key: null,
      theme_colors: null,
    })
    await mutate(updated, false)
  }

  return {
    isLoading,
    orgName: data?.org_name ?? 'FreeFrame',
    // Backend hands back relative /stream/... proxy paths (see
    // apps/api/routers/site_settings.py::_to_response) — same as thumbnail_url
    // elsewhere in this app, they need the API origin prefixed before use in
    // an <img src>, otherwise the browser resolves them against the Next.js
    // frontend origin instead of the FastAPI backend and 404s.
    logoDarkUrl: resolveApiMediaUrl(data?.logo_dark_url ?? null),
    logoLightUrl: resolveApiMediaUrl(data?.logo_light_url ?? null),
    logoLoginUrl: resolveApiMediaUrl(data?.logo_login_url ?? null),
    faviconUrl: resolveApiMediaUrl(data?.favicon_url ?? null),
    themeColors: data?.theme_colors ?? null,
    updateOrgName,
    uploadLogo,
    removeLogo,
    uploadFavicon,
    removeFavicon,
    updateThemeColors,
    resetThemeColors,
    resetAll,
  }
}
