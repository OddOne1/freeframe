/**
 * The session that changes its own 2FA keeps working (§199).
 *
 * `token_version` ends every session a user holds whenever 2FA is enabled,
 * disabled, or its backup codes are regenerated. That is the point — but it
 * catches the session PERFORMING the action too, whose tokens were minted
 * under the previous version. Each of those three endpoints therefore hands
 * back a replacement pair, and this screen has to adopt it. If it does not,
 * "turn my 2FA off" signs the user out one request later, which is worse
 * than the behaviour §199 exists to fix, not better.
 *
 * The adoption is also guarded rather than unpacked blind: `setTokens` would
 * happily write the literal string "undefined", which is exactly the bug
 * §196 had to fix on the login screen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@/types'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

vi.mock('@/lib/auth', () => ({ setTokens: vi.fn() }))

const fetchUser = vi.fn()
let currentUser: Partial<User> = {}
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: currentUser, fetchUser }),
}))

import { api } from '@/lib/api'
import { setTokens } from '@/lib/auth'
import { TwoFactorSettings } from '../two-factor-settings'

const NOT_ENROLLED = {
  email: 'u@example.com',
  two_factor_enabled: false,
  two_factor_method: null,
}
const ENROLLED = {
  email: 'u@example.com',
  two_factor_enabled: true,
  two_factor_method: 'totp' as const,
}
const FRESH = { access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'bearer' }

async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) await user.type(boxes[i], code[i])
}

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = { ...NOT_ENROLLED }
})

describe('the replacement pair is adopted', () => {
  it('after confirming an enrolment', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockResolvedValueOnce({
        backup_codes: ['aaaa-1111'],
        method: 'email',
        tokens: FRESH,
      })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /enable two-factor/i }))
    await user.click(screen.getByRole('button', { name: /^email/i }))
    await typeCode(user, '111222')

    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('new-access', 'new-refresh'))
  })

  it('before the /auth/me refetch that follows it', async () => {
    // Ordering matters: fetchUser is an authenticated request, so adopting
    // after it would send the stale token and 401.
    const user = userEvent.setup()
    const order: string[] = []
    vi.mocked(setTokens).mockImplementation(() => { order.push('setTokens') })
    fetchUser.mockImplementation(async () => { order.push('fetchUser') })
    vi.mocked(api.post).mockResolvedValueOnce({ two_factor_enabled: false, tokens: FRESH })
    currentUser = { ...ENROLLED }
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '424242')

    await waitFor(() => expect(order).toEqual(['setTokens', 'fetchUser']))
  })

  it('after regenerating backup codes', async () => {
    const user = userEvent.setup()
    currentUser = { ...ENROLLED }
    vi.mocked(api.post).mockResolvedValueOnce({
      backup_codes: ['zzzz-9999'],
      tokens: FRESH,
    })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /regenerate backup codes/i }))
    await typeCode(user, '424242')

    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('new-access', 'new-refresh'))
  })
})

describe('nothing is stored when there is nothing to store', () => {
  it('a null tokens field leaves the existing session alone', async () => {
    // An API that has not deployed §199 yet. Keeping the tokens we have is
    // the honest behaviour; writing `undefined` over them is not.
    const user = userEvent.setup()
    currentUser = { ...ENROLLED }
    vi.mocked(api.post).mockResolvedValueOnce({ two_factor_enabled: false, tokens: null })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '424242')

    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(setTokens).not.toHaveBeenCalled()
  })

  it('a missing tokens field does the same', async () => {
    const user = userEvent.setup()
    currentUser = { ...ENROLLED }
    vi.mocked(api.post).mockResolvedValueOnce({ two_factor_enabled: false })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '424242')

    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(setTokens).not.toHaveBeenCalled()
  })

  it('a half-populated pair is refused rather than half-stored', async () => {
    const user = userEvent.setup()
    currentUser = { ...ENROLLED }
    vi.mocked(api.post).mockResolvedValueOnce({
      two_factor_enabled: false,
      tokens: { access_token: 'only-half', refresh_token: '', token_type: 'bearer' },
    })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '424242')

    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(setTokens).not.toHaveBeenCalled()
  })

  it('a rejected re-auth code stores nothing at all', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    currentUser = { ...ENROLLED }
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(401, 'Invalid code'))
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '000000')

    expect(await screen.findByText('Invalid code')).toBeInTheDocument()
    expect(setTokens).not.toHaveBeenCalled()
  })
})
