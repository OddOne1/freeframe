/**
 * Self-service two-factor, in profile settings (§197).
 *
 * The property worth testing hardest is the one that is not visible on
 * screen: every action that WEAKENS the account has to present a current
 * code first. Turning 2FA off and replacing the backup codes are obviously
 * in that set. Starting a REPLACEMENT enrolment is the one that looks
 * harmless and is the most destructive of the three — it decides what the
 * account will answer to next — and §194b built a gate for it that a
 * settings screen is exactly the place to forget.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@/types'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})

const fetchUser = vi.fn()
let currentUser: Partial<User> = {}
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: currentUser, fetchUser }),
}))

import { api } from '@/lib/api'
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

async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) await user.type(boxes[i], code[i])
}

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = { ...NOT_ENROLLED }
})

describe('enrolling from settings', () => {
  it('sets up an authenticator and gates on the backup codes', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({
        method: 'totp',
        qr_code_data_uri: 'data:image/png;base64,AAA',
        secret: 'JBSWY3DPEHPK3PXP',
        email_code_sent: false,
      })
      .mockResolvedValueOnce({
        backup_codes: ['aaaa-1111', 'bbbb-2222'],
        method: 'totp',
        tokens: null,
      })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /enable two-factor/i }))
    await user.click(screen.getByRole('button', { name: /authenticator app/i }))

    // No reauth_code: there is no live factor to protect yet.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/setup', { method: 'totp' }),
    )
    expect(await screen.findByAltText(/qr code/i)).toBeInTheDocument()

    await typeCode(user, '111222')

    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument()
    // The user's state is not refetched — and so the section does not claim
    // to be done — until the codes are acknowledged.
    expect(fetchUser).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /i've saved these codes/i }))

    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(await screen.findByText(/two-factor authentication is on/i)).toBeInTheDocument()
  })

  it('sets up email, and says honestly when no new code was sent', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ method: 'email', email_code_sent: false })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /enable two-factor/i }))
    await user.click(screen.getByRole('button', { name: /^email/i }))

    expect(await screen.findByText(/a code was already sent to u@example.com/i)).toBeInTheDocument()
  })

  it('surfaces a rejected confirmation code instead of enrolling', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockRejectedValueOnce(new ApiError(401, 'Invalid code'))
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /enable two-factor/i }))
    await user.click(screen.getByRole('button', { name: /^email/i }))
    await typeCode(user, '000000')

    expect(await screen.findByText('Invalid code')).toBeInTheDocument()
    expect(fetchUser).not.toHaveBeenCalled()
  })
})

describe('an account that is already enrolled', () => {
  beforeEach(() => { currentUser = { ...ENROLLED } })

  it('says which method is in use, in plain language', () => {
    render(<TwoFactorSettings />)
    expect(screen.getByText(/on, using authenticator app/i)).toBeInTheDocument()
  })

  it('demands the current factor before starting a REPLACEMENT enrolment (§194b)', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ method: 'email', email_code_sent: true })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /change method/i }))
    await user.click(screen.getByRole('button', { name: /^email/i }))

    // Nothing has been requested yet — the prompt comes first.
    expect(api.post).not.toHaveBeenCalled()
    // §205 — the description now names the user's ACTUAL factor rather than
    // saying "your current second factor" to everyone. This fixture is a
    // TOTP user, so it should mention the authenticator.
    // §205 — the description now names the user's ACTUAL factor rather than
    // saying "your current second factor" to everyone. This fixture is a
    // TOTP user, so the dialog should point at the authenticator. Scoped to
    // the dialog: "Authenticator app" is also the label of the method button
    // behind it.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(/before setting up a new method/i)
    expect(dialog).toHaveTextContent(/authenticator app/i)

    await typeCode(user, '424242')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/setup', {
        method: 'email',
        reauth_code: '424242',
      }),
    )
  })

  it('keeps the dialog open, and changes nothing, on a wrong re-auth code', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(401, 'Invalid code'))
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '000000')

    expect(await screen.findByText('Invalid code')).toBeInTheDocument()
    expect(fetchUser).not.toHaveBeenCalled()
    // Still enrolled as far as this screen is concerned.
    expect(screen.getByText(/on, using authenticator app/i)).toBeInTheDocument()
  })

  it('disables 2FA once a current code is given', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ two_factor_enabled: false })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await typeCode(user, '424242')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/disable', { code: '424242' }),
    )
    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
  })

  it('regenerates backup codes behind the same gate, and shows them once', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ backup_codes: ['zzzz-9999', 'yyyy-8888'] })
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /regenerate backup codes/i }))
    await typeCode(user, '424242')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/regenerate-backup-codes', {
        code: '424242',
      }),
    )
    expect(await screen.findByText('zzzz-9999')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /i've saved these codes/i }))
    expect(await screen.findByText(/old ones no longer work/i)).toBeInTheDocument()
  })
})
