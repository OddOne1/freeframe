/**
 * Changing your password when you have 2FA on (§197).
 *
 * This is the bug the whole §197 investigation started from, and it is the
 * same one §196 fixed on the login screen, on the one surface §196
 * deliberately left alone: /auth/verify-magic-code was unpacked without
 * checking `requires_2fa`, so for an enrolled user it called setTokens with
 * `undefined` — destroying a working session in the middle of a password
 * change.
 *
 * The assertions are about what reaches setTokens, because everything on
 * screen looked fine while that happened.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

const setTokens = vi.fn()
vi.mock('@/lib/auth', () => ({ setTokens: (...a: unknown[]) => setTokens(...a) }))

const fetchUser = vi.fn()
const logout = vi.fn()
let enrolled = false
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: {
      id: 'u-1',
      email: 'u@example.com',
      first_name: 'Test',
      last_name: 'User',
      two_factor_enabled: enrolled,
      two_factor_method: enrolled ? 'totp' : null,
    },
    fetchUser,
    logout,
  }),
}))

import { api } from '@/lib/api'
import ProfilePage from '../profile/page'

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'bearer',
  needs_password: false,
  requires_2fa: false as const,
}

async function requestPasswordChange(user: ReturnType<typeof userEvent.setup>) {
  // Exact labels: "New Password" is a substring of "Confirm New Password".
  await user.type(screen.getByLabelText('New Password'), 'hunter2hunter2')
  await user.type(screen.getByLabelText('Confirm New Password'), 'hunter2hunter2')
  await user.click(screen.getByRole('button', { name: /save password/i }))
}

async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) await user.type(boxes[i], code[i])
}

beforeEach(() => {
  vi.clearAllMocks()
  enrolled = false
})

describe('password change without 2FA', () => {
  it('verifies the emailed code and sets the password, as before', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })   // send-magic-code
      .mockResolvedValueOnce(TOKENS)                // verify-magic-code
      .mockResolvedValueOnce({})                    // set-password
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')

    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
    expect(api.post).toHaveBeenCalledWith('/auth/set-password', { password: 'hunter2hunter2' })
  })

  it('asks for the reset code out of its own pool (§197)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce(TOKENS)
      .mockResolvedValueOnce({})
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/verify-magic-code', {
        email: 'u@example.com',
        code: '123456',
        purpose: 'password_reset',
      }),
    )
  })
})

describe('password change with 2FA on', () => {
  beforeEach(() => { enrolled = true })

  it('does not touch the session when the reset code lands in the 2FA gate', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce({
        requires_2fa: true,
        setup_required: false,
        pending_token: 'pending-1',
        method: 'totp',
        email_code_sent: false,
      })
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')

    expect(await screen.findByText(/one more step/i)).toBeInTheDocument()
    // The bug, stated as an assertion.
    expect(setTokens).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalledWith('/auth/set-password', expect.anything())
  })

  it('completes the change after the second factor', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce({
        requires_2fa: true,
        setup_required: false,
        pending_token: 'pending-1',
        method: 'totp',
        email_code_sent: false,
      })
      .mockResolvedValueOnce(TOKENS)  // 2fa/verify-login
      .mockResolvedValueOnce({})      // set-password
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')
    await screen.findByText(/one more step/i)
    await typeCode(user, '654321')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/verify-login', {
        pending_token: 'pending-1',
        code: '654321',
      }),
    )
    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
    expect(api.post).toHaveBeenCalledWith('/auth/set-password', { password: 'hunter2hunter2' })
    expect(await screen.findByText(/password changed successfully/i)).toBeInTheDocument()
  })

  it('leaves the session alone when the second factor is wrong', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce({
        requires_2fa: true,
        setup_required: false,
        pending_token: 'pending-1',
        method: 'email',
        email_code_sent: true,
      })
      .mockRejectedValueOnce(new ApiError(401, 'Invalid code'))
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')
    await screen.findByText(/one more step/i)
    await typeCode(user, '000000')

    expect(await screen.findByText('Invalid code')).toBeInTheDocument()
    expect(setTokens).not.toHaveBeenCalled()
    expect(api.post).not.toHaveBeenCalledWith('/auth/set-password', expect.anything())
  })
})
