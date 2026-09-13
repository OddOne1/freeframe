'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import { resolveApiMediaUrl } from '@/lib/utils'
import type { ThemeColorTokens } from '@/lib/color-utils'
import type { SiteSettingsResponse } from '@/types'

/** Exported so the server-seeded SWR fallback keys on exactly this string
 *  (§178) — a mismatched literal there would silently seed nothing. */
export const SITE_SETTINGS_KEY = '/site-settings'

type LogoSide = 'dark' | 'light' | 'login'
type ColorTheme = 'light' | 'dark'

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

  // Uploaded straight through the API (see apps/api/routers/site_settings.py
  // ::upload_site_logo) rather than a presigned browser->S3 PUT -- AIStor is
  // only reachable over plain HTTP on the LAN, so a direct presigned URL
  // handed to this https:// page gets blocked as mixed content in browsers
  // without an override already set for this origin. One request now does
  // the upload and persists the *_s3_key server-side, instead of
  // upload-URL + PUT + PATCH.
  async function uploadLogo(side: LogoSide, file: File): Promise<void> {
    const formData = new FormData()
    formData.append('file', file)
    const updated = await api.upload<SiteSettingsResponse>(
            `/site-settings/logo-upload?side=${side}`,
      formData,
    )
    await mutate(updated, false)
  }

  async function uploadFavicon(file: File): Promise<void> {
    const formData = new FormData()
    formData.append('file', file)
    const updated = await api.upload<SiteSettingsResponse>('/site-settings/favicon-upload', formData)
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

  /** Platform-wide total storage cap (superadmin-only in practice --
   * PATCH /site-settings 403s for anyone else). null clears it (no cap). */
  async function updateTotalStorageLimit(bytes: number | null): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      total_storage_limit_bytes: bytes,
    })
    await mutate(updated, false)
  }

  /**
   * Back to the default workspace name and palette.
   *
   * §178 — the four `*_s3_key` nulls this used to send are gone. A brand
   * image, once set, is never cleared: the backend ignores a null for those
   * columns (see BRAND_IMAGE_FIELDS in routers/site_settings.py), so sending
   * them would have been a request that quietly did nothing. Not sending
   * them is what makes this function's name honest about its own scope.
   * `removeLogo`/`removeFavicon` are gone from this hook for the same
   * reason — a clear-to-empty that cannot happen should not be callable.
   */
  async function resetAll(): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      org_name: 'FreeFrame',
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
    totalStorageLimitBytes: data?.total_storage_limit_bytes ?? null,
    // Null for non-superadmins/anonymous callers -- see SiteSettingsResponse.
    totalStorageUsedBytes: data?.total_storage_used_bytes ?? null,
    updateOrgName,
    uploadLogo,
    uploadFavicon,
    updateThemeColors,
    resetThemeColors,
    updateTotalStorageLimit,
    resetAll,
  }
}
