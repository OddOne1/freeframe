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
 *
 * §200 changed the SHAPE of this flow, not its guarantee. Changing a password
 * that already exists now needs the current second factor, so the 2FA code is
 * presented to /auth/set-password as `reauth_code` instead of being spent on
 * /auth/2fa/verify-login — which used to mint a session this page already
 * held, consuming the one code there was. One code, spent once, by the
 * endpoint that actually needs it. The §197 guarantee these tests exist for is
 * unchanged and still asserted: nothing reaches setTokens until a response
 * genuinely carries tokens.
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
  await user.type(screen.getByLabelText('New Password'), GOOD_PASSWORD)
  await user.type(screen.getByLabelText('Confirm New Password'), GOOD_PASSWORD)
  // §200 — the button is disabled until the live meter is satisfied, and the
  // meter is debounced, so this waits rather than clicking into a no-op.
  const save = screen.getByRole('button', { name: /save password/i })
  await waitFor(() => expect(save).toBeEnabled())
  await user.click(save)
}

async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) await user.type(boxes[i], code[i])
}

/** §200 — the old "hunter2hunter2" fails the policy (no upper case, no
 *  special character), so the Save button stays disabled and the dialog this
 *  file drives never opens. */
const GOOD_PASSWORD = 'Tf4#qRn8!vZw'

beforeEach(() => {
  vi.clearAllMocks()
  enrolled = false
  // GET /auth/password-policy, which PasswordField reads so the meter states
  // the instance's real numbers.
  vi.mocked(api.get).mockResolvedValue({
    min_length: 12,
    min_strength_score: 3,
    requires_upper: true,
    requires_lower: true,
    requires_digit: true,
    requires_special: true,
  })
})

describe('password change without 2FA', () => {
  it('verifies the emailed code and sets the password, as before', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })   // send-magic-code
      .mockResolvedValueOnce(TOKENS)                // verify-magic-code
      .mockResolvedValueOnce(TOKENS)                // set-password (§199 pair)
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')

    // §200 — the pair now comes from /auth/set-password's OWN response, which
    // is the one minted after the token_version bump. Adopting the
    // verify-magic-code pair instead would store tokens that are stale the
    // moment the password lands.
    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
    expect(api.post).toHaveBeenCalledWith('/auth/set-password', { password: GOOD_PASSWORD })
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
      .mockResolvedValueOnce(TOKENS)  // set-password, with the reauth code
    render(<ProfilePage />)

    await requestPasswordChange(user)
    await typeCode(user, '123456')
    await screen.findByText(/one more step/i)
    await typeCode(user, '654321')

    // §200 — ONE call, carrying the second factor. There is no
    // /auth/2fa/verify-login hop any more: this page already holds a session,
    // and spending the code to mint a second one left nothing to prove the
    // change with once /auth/set-password started demanding it.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/set-password', {
        password: GOOD_PASSWORD,
        reauth_code: '654321',
      }),
    )
    expect(api.post).not.toHaveBeenCalledWith(
      '/auth/2fa/verify-login',
      expect.anything(),
    )
    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
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
    // §200 — the refusal now comes from /auth/set-password itself, so what
    // matters is that the rejected call changed nothing: no tokens stored,
    // and the success banner never shown.
    expect(setTokens).not.toHaveBeenCalled()
    expect(
      screen.queryByText(/password changed successfully/i),
    ).not.toBeInTheDocument()
  })
})
