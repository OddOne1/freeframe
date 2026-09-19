'use client'

import { useRouter } from 'next/navigation'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import type { LoginResponse, TwoFactorRequiredResponse, User } from '@/types'

/**
 * Thrown by `login()` when the password was right but a second factor is
 * outstanding (§197).
 *
 * A throw rather than a union return, deliberately. This hook's contract is
 * "log in and land on the dashboard" — a `Promise<void>` that ends in a
 * redirect. Returning a challenge would make the success case and the
 * not-finished case indistinguishable to a caller that does not check, which
 * is exactly the mistake being fixed here: the old code read `access_token`
 * off a response that might not have one and stored `undefined`. An
 * unhandled throw is loud; an ignored return value is silent.
 *
 * `challenge` carries the pending token, so a caller that wants to finish
 * the login can drive /auth/2fa/verify-login from it — see the login form
 * for what that looks like.
 */
export class TwoFactorRequiredError extends Error {
  challenge: TwoFactorRequiredResponse

  constructor(challenge: TwoFactorRequiredResponse) {
    super('Two-factor authentication required')
    this.name = 'TwoFactorRequiredError'
    this.challenge = challenge
  }
}

export interface UseAuthReturn {
  /** Current authenticated user, or null if not logged in */
  user: User | null
  /** Whether the user has a valid session */
  isAuthenticated: boolean
  /** Whether the user has super-admin privileges */
  isSuperAdmin: boolean
  /** Whether a user-fetch is in progress */
  isLoading: boolean
  /** Log in with email + password and redirect to dashboard.
   *  Throws TwoFactorRequiredError when a second factor is outstanding. */
  login: (email: string, password: string) => Promise<void>
  /** Clear tokens and redirect to /login */
  logout: () => void
}

export function useAuth(): UseAuthReturn {
  const router = useRouter()
  const { user, isAuthenticated, isSuperAdmin, isLoading, setUser, logout: storeLogout } = useAuthStore()

  async function login(email: string, password: string): Promise<void> {
    const res = await api.post<LoginResponse>('/auth/login', { email, password })
    // §197 — branch on the discriminator, never on whether a token happens
    // to be present. This hook has no UI of its own to prompt from, so it
    // hands the challenge to its caller rather than pretending the login
    // finished.
    if (res.requires_2fa) {
      throw new TwoFactorRequiredError(res)
    }
    const tokens = res
    setTokens(tokens.access_token, tokens.refresh_token)

    // Fetch user profile and populate store
    const me = await api.get<User>('/auth/me')
    setUser(me)

    router.push('/projects')
  }

  function logout(): void {
    storeLogout()
    router.push('/login')
  }

  return {
    user,
    isAuthenticated,
    isSuperAdmin,
    isLoading,
    login,
    logout,
  }
}
