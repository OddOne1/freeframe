'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type { SiteSettingsResponse } from '@/types'

const SITE_SETTINGS_KEY = '/site-settings'

type LogoSide = 'dark' | 'light'

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
    const field = side === 'dark' ? 'logo_dark_s3_key' : 'logo_light_s3_key'
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      [field]: key,
    })
    await mutate(updated, false)
  }

  async function removeLogo(side: LogoSide): Promise<void> {
    const field = side === 'dark' ? 'logo_dark_s3_key' : 'logo_light_s3_key'
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      [field]: null,
    })
    await mutate(updated, false)
  }

  async function resetAll(): Promise<void> {
    const updated = await api.patch<SiteSettingsResponse>(SITE_SETTINGS_KEY, {
      org_name: 'FreeFrame',
      logo_dark_s3_key: null,
      logo_light_s3_key: null,
    })
    await mutate(updated, false)
  }

  return {
    isLoading,
    orgName: data?.org_name ?? 'FreeFrame',
    logoDarkUrl: data?.logo_dark_url ?? null,
    logoLightUrl: data?.logo_light_url ?? null,
    updateOrgName,
    uploadLogo,
    removeLogo,
    resetAll,
  }
}
