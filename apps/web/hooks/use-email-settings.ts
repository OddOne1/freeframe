'use client'

import useSWR from 'swr'
import { api } from '@/lib/api'
import type { EmailSettingsResponse, EmailSettingsUpdate, TestEmailResponse } from '@/types'

const KEY = '/email-settings'

/**
 * Mail configuration, superadmin-only on both read and write.
 *
 * Unlike `useSiteSettings`, this must never be called from a public page —
 * the endpoint 403s for anyone who isn't a superadmin, and the data it
 * carries is deliberately not part of the public branding payload.
 */
export function useEmailSettings() {
  const { data, isLoading, mutate } = useSWR<EmailSettingsResponse>(
    KEY,
    (key: string) => api.get<EmailSettingsResponse>(key),
  )

  async function update(patch: EmailSettingsUpdate): Promise<void> {
    const updated = await api.patch<EmailSettingsResponse>(KEY, patch)
    await mutate(updated, false)
  }

  async function sendTest(toEmail: string): Promise<TestEmailResponse> {
    return api.post<TestEmailResponse>(`${KEY}/test`, { to_email: toEmail })
  }

  return { settings: data, isLoading, update, sendTest, mutate }
}
