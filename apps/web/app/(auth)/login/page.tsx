'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { getAccessToken } from '@/lib/auth'
import { DEFAULT_LANDING_PATH, safeNext } from '@/lib/safe-next'
import { LoginForm } from '@/components/auth/login-form'
import type { SetupStatus } from '@/types'

export default function LoginPage() {
  const router = useRouter()

  useEffect(() => {
    // Redirect to setup if first-time setup is needed
    async function checkSetup() {
      try {
        const status = await api.get<SetupStatus>('/setup/status')
        if (status.needs_setup) {
          router.replace('/setup')
        }
      } catch {
        // ignore — proceed to show login
      }
    }

    // If already authenticated, set cookie and redirect to dashboard
    const token = getAccessToken()
    if (token) {
      document.cookie = `ff_access_token=${token}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax`
      // Where `middleware.ts` was taking you before it sent you here.
      //
      // §233b — through `safeNext`, never raw. This line used to be
      // `router.replace(from || '/projects')`, which followed whatever the
      // query string said: `/login?from=https://evil.com` was an open
      // redirect on the one page where "the address bar still says our
      // domain" is all a person has to go on, and it fires immediately
      // after the cookie above is set. Anything that is not a same-origin
      // path becomes DEFAULT_LANDING_PATH.
      const params = new URLSearchParams(window.location.search)
      router.replace(safeNext(params.get('from'), DEFAULT_LANDING_PATH))
      return
    }

    checkSetup()
  }, [router])

  return <LoginForm />
}
