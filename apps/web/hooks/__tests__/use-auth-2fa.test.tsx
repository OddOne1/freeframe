/**
 * useAuth().login and the 2FA challenge (§197).
 *
 * Nothing calls this hook today — §196's trace confirmed that, which is why
 * its identical unguarded unpack of /auth/login was not breaking anything.
 * It is tested here precisely BECAUSE there is no caller to observe the
 * contract from: the next person to reach for this hook should find the
 * behaviour written down rather than inferred.
 *
 * The contract chosen: a challenge THROWS. This hook promises "log in and
 * land on the dashboard" — returning a challenge instead would make the
 * finished and unfinished cases indistinguishable to a caller that does not
 * check, which is the exact mistake being fixed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}))

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }))

const setTokens = vi.fn()
vi.mock('@/lib/auth', () => ({ setTokens: (...a: unknown[]) => setTokens(...a) }))

const setUser = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: null,
    isAuthenticated: false,
    isSuperAdmin: false,
    isLoading: false,
    setUser,
    logout: vi.fn(),
  }),
}))

import { api } from '@/lib/api'
import { useAuth, TwoFactorRequiredError } from '../use-auth'

beforeEach(() => vi.clearAllMocks())

describe('login()', () => {
  it('throws a typed error, and stores nothing, when a second factor is outstanding', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      requires_2fa: true,
      setup_required: false,
      pending_token: 'pending-1',
      method: 'totp',
      email_code_sent: false,
    })
    const { result } = renderHook(() => useAuth())

    await expect(
      act(() => result.current.login('u@example.com', 'pw')),
    ).rejects.toBeInstanceOf(TwoFactorRequiredError)

    expect(setTokens).not.toHaveBeenCalled()
    expect(setUser).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('carries the challenge, so a caller can finish the login from it', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      requires_2fa: true,
      setup_required: true,
      pending_token: 'pending-9',
      method: null,
      email_code_sent: false,
    })
    const { result } = renderHook(() => useAuth())

    try {
      await act(() => result.current.login('u@example.com', 'pw'))
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TwoFactorRequiredError)
      expect((err as TwoFactorRequiredError).challenge.pending_token).toBe('pending-9')
      expect((err as TwoFactorRequiredError).challenge.setup_required).toBe(true)
    }
  })

  it('still signs in normally when there is no challenge', async () => {
    vi.mocked(api.post).mockResolvedValueOnce({
      access_token: 'a-1',
      refresh_token: 'r-1',
      token_type: 'bearer',
      needs_password: false,
      requires_2fa: false,
    })
    vi.mocked(api.get).mockResolvedValueOnce({ id: 'u-1', email: 'u@example.com' })
    const { result } = renderHook(() => useAuth())

    await act(() => result.current.login('u@example.com', 'pw'))

    expect(setTokens).toHaveBeenCalledWith('a-1', 'r-1')
    expect(setUser).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith('/projects')
  })
})
