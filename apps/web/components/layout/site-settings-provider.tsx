'use client'

import * as React from 'react'
import { SWRConfig } from 'swr'
import { SITE_SETTINGS_KEY } from '@/hooks/use-site-settings'
import type { SiteSettingsResponse } from '@/types'

/**
 * Seeds SWR with server-fetched branding so the first paint is already
 * right (§178).
 *
 * `fallback` rather than a prop drilled into the sidebar: `useSiteSettings`
 * is called from several places (sidebar, branding settings, the favicon
 * initializer), all keyed on the same '/site-settings' string, and SWR's
 * fallback feeds every one of them from one value. Passing the logo down as
 * a prop would fix the sidebar and leave the others fetching cold.
 *
 * It is a FALLBACK, not a freeze: SWR still revalidates on mount, so a logo
 * changed elsewhere still arrives. It only decides what is rendered in the
 * gap the client fetch used to leave empty.
 *
 * `value` is null when the backend was unreachable at render time. Seeding
 * nothing is then correct — the client fetch behaves exactly as it did
 * before, including its fallback to the bundled default.
 */
export function SiteSettingsProvider({
  value,
  children,
}: {
  value: SiteSettingsResponse | null
  children: React.ReactNode
}) {
  const fallback = React.useMemo(
    () => (value ? { [SITE_SETTINGS_KEY]: value } : {}),
    [value],
  )
  return <SWRConfig value={{ fallback }}>{children}</SWRConfig>
}
