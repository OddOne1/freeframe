/**
 * Backup codes can be typed, and only where they are legitimate (§205).
 *
 * The defect: `CodeInput` strips every non-digit — on typing and on paste —
 * and it was the ONLY code field in the app. Backup codes are `XXXX-XXXX`
 * over `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. The API has accepted them
 * throughout (`normalize_backup_code` forgives case, spaces and the dash),
 * ten are issued at enrolment, the user is told to keep them safe, and the
 * re-auth dialog said in so many words that "a backup code works too".
 *
 * So the recovery path existed end to end on the server and had no keyhole in
 * the browser — the thing people reach for exactly when nothing else works.
 *
 * These tests drive the components, not the API, because the bug was that the
 * field did not exist. A test that called `/auth/2fa/disable` with a backup
 * code would have passed the whole time.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}))

const setTokens = vi.fn()
vi.mock('@/lib/auth', () => ({
  setTokens: (...a: unknown[]) => setTokens(...a),
  getAccessToken: () => null,
}))

const fetchUser = vi.fn()
let currentUser: Record<string, unknown> = {}
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ user: currentUser, fetchUser }),
    { getState: () => ({ fetchUser }) },
  ),
}))

let requireTwoFactor = false
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ requireTwoFactor, isLoading: false }),
}))

import { api } from '@/lib/api'
import { CodeConfirmDialog } from '@/components/auth/code-confirm-dialog'
import { TwoFactorSettings } from '@/components/auth/two-factor-settings'
import { LoginForm } from '@/components/auth/login-form'

const ENROLLED_TOTP = {
  id: 'u-1',
  email: 'u@example.com',
  name: 'Test User',
  first_name: 'Test',
  last_name: 'User',
  two_factor_enabled: true,
  two_factor_method: 'totp' as const,
}

const ENROLLED_EMAIL = { ...ENROLLED_TOTP, two_factor_method: 'email' as const }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = { ...ENROLLED_TOTP }
  requireTwoFactor = false
})

const backupField = () => screen.getByLabelText('Backup code')
const toggle = () => screen.getByRole('button', { name: /use a backup code instead/i })

// ── the field itself ────────────────────────────────────────────────────────

describe('the backup-code field', () => {
  function renderDialog(onConfirm = vi.fn()) {
    render(
      <CodeConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        description="desc"
        onConfirm={onConfirm}
      />,
    )
    return onConfirm
  }

  it('is offered under the digit boxes', () => {
    renderDialog()
    expect(screen.getAllByLabelText(/^digit /i)).toHaveLength(6)
    expect(toggle()).toBeInTheDocument()
  })

  it('does NOT strip letters or the dash — the whole bug', async () => {
    const onConfirm = renderDialog(vi.fn().mockResolvedValue(undefined))
    const user = userEvent.setup()

    await user.click(toggle())
    await user.type(backupField(), 'A7K2-9QXM')

    // Before §205 this field did not exist, and the only one that did would
    // have reduced this to "729".
    expect(backupField()).toHaveValue('A7K2-9QXM')

    await user.click(screen.getByRole('button', { name: /^confirm$/i }))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('A7K2-9QXM'))
  })

  it.each([
    ['upper with dash', 'A7K2-9QXM'],
    ['lower with dash', 'a7k2-9qxm'],
    ['no dash', 'A7K29QXM'],
    ['a space instead of the dash', 'A7k2 9qxm'],
  ])('sends %s through untouched — the server normalises', async (_label, typed) => {
    const onConfirm = renderDialog(vi.fn().mockResolvedValue(undefined))
    const user = userEvent.setup()

    await user.click(toggle())
    await user.type(backupField(), typed)
    await user.click(screen.getByRole('button', { name: /^confirm$/i }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(typed))
  })

  it('refuses a half-typed code rather than spending an attempt on it', async () => {
    // The old dialog's rule was `length < 6`, which would have let four
    // characters of a nine-character code reach the server as a wrong code.
    const onConfirm = renderDialog(vi.fn())
    const user = userEvent.setup()

    await user.click(toggle())
    await user.type(backupField(), 'A7K2')
    await user.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(await screen.findByText(/full backup code/i)).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('can be swapped back to the digit boxes', async () => {
    renderDialog()
    const user = userEvent.setup()

    await user.click(toggle())
    await user.click(screen.getByRole('button', { name: /6-digit code instead/i }))

    expect(screen.getAllByLabelText(/^digit /i)).toHaveLength(6)
    expect(screen.queryByLabelText('Backup code')).not.toBeInTheDocument()
  })

  it('can be suppressed where a backup code would be refused', () => {
    render(
      <CodeConfirmDialog
        open
        onOpenChange={() => {}}
        title="Confirm"
        description="desc"
        onConfirm={vi.fn()}
        allowBackupCode={false}
      />,
    )
    expect(
      screen.queryByRole('button', { name: /use a backup code instead/i }),
    ).not.toBeInTheDocument()
  })
})

// ── where it is offered, and where it must not be ───────────────────────────

describe('the login 2FA challenge', () => {
  async function reachChallenge(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(api.post).mockResolvedValueOnce({
      requires_2fa: true,
      setup_required: false,
      pending_token: 'pending-1',
      method: 'totp',
      email_code_sent: false,
    })
    render(<LoginForm />)
    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await user.type(screen.getByLabelText(/email/i), 'u@example.com')
    await user.type(screen.getByLabelText(/password/i), 'pw123456')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    await screen.findByText(/authenticator app/i)
  }

  it('accepts a backup code and signs the user in', async () => {
    const user = userEvent.setup()
    await reachChallenge(user)

    await user.click(toggle())
    await user.type(backupField(), 'A7K2-9QXM')

    vi.mocked(api.post).mockResolvedValueOnce({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'bearer',
      needs_password: false,
      requires_2fa: false,
    })
    await user.click(screen.getByRole('button', { name: /verify code/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/verify-login', {
        pending_token: 'pending-1',
        code: 'A7K2-9QXM',
      }),
    )
    expect(setTokens).toHaveBeenCalledWith('a', 'r')
  })
})

describe('where a backup code is NOT legitimate', () => {
  it('is not offered on the magic-code screen', async () => {
    // A backup code is a second factor, not a primary credential.
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({ message: 'sent' })
    render(<LoginForm />)

    await user.type(screen.getByLabelText(/email/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /continue|send/i }))

    await waitFor(() => expect(screen.getAllByLabelText(/^digit /i)).toHaveLength(6))
    expect(
      screen.queryByRole('button', { name: /use a backup code instead/i }),
    ).not.toBeInTheDocument()
  })

  it('is not offered on the enrolment-confirm screen', async () => {
    // `confirm_two_factor_setup` refuses a backup code on purpose: it exists
    // to prove the NEW factor works, and a backup code proves nothing about
    // that. Offering an affordance the server rejects is worse than none.
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce({
      method: 'totp',
      qr_code_data_uri: 'data:image/png;base64,AAA',
      secret: 'JBSWY3DPEHPK3PXP',
      email_code_sent: false,
    })
    currentUser = { ...ENROLLED_TOTP, two_factor_enabled: false, two_factor_method: null }
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /enable two-factor/i }))
    await user.click(screen.getByRole('button', { name: /authenticator app/i }))

    await waitFor(() => expect(screen.getAllByLabelText(/^digit /i)).toHaveLength(6))
    expect(
      screen.queryByRole('button', { name: /use a backup code instead/i }),
    ).not.toBeInTheDocument()
  })
})

// ── the re-auth mail, and the policy-gated off switch ───────────────────────

describe('re-authenticating as an email-factor user', () => {
  beforeEach(() => {
    currentUser = { ...ENROLLED_EMAIL }
  })

  it('mails a code when the disable dialog opens, and says so', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/send-reauth-code?force=false'),
    )
    expect(await screen.findByText(/we sent a 6-digit code to u@example.com/i))
      .toBeInTheDocument()
  })

  it('offers a rate-limited resend that forces a new code', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    await screen.findByText(/we sent a 6-digit code/i)
    await user.click(screen.getByRole('button', { name: /send it again/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/send-reauth-code?force=true'),
    )
  })

  it('still opens the dialog when the mail cannot be sent', async () => {
    // A backup code is a perfectly good way through this dialog, and §205
    // just made those typeable — so a failed send must not block the door.
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    vi.mocked(api.post).mockRejectedValueOnce(new ApiError(429, 'Too many requests'))
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))

    // By ROLE for the toggle: the failure notice below also ends in "you can
    // use a backup code instead", so a text match finds both.
    expect(
      await screen.findByRole('button', { name: /use a backup code instead/i }),
    ).toBeInTheDocument()
    expect(await screen.findByText(/^We could not send a code/i)).toBeInTheDocument()
  })

  it('tells an email user to check their email, not their authenticator', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    const dialog = await screen.findByRole('dialog')

    expect(dialog).toHaveTextContent(/code we emailed you/i)
    expect(dialog).not.toHaveTextContent(/authenticator app/i)
  })
})

describe('a TOTP user re-authenticating', () => {
  it('is mailed nothing and offered no resend', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValue({})
    render(<TwoFactorSettings />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))
    const dialog = await screen.findByRole('dialog')

    expect(api.post).not.toHaveBeenCalled()
    expect(dialog).toHaveTextContent(/authenticator app/i)
    expect(
      screen.queryByRole('button', { name: /send it again/i }),
    ).not.toBeInTheDocument()
  })
})

describe('when the instance requires two-factor', () => {
  beforeEach(() => {
    requireTwoFactor = true
  })

  it('disables the Turn off button AND says why', async () => {
    // CLAUDE.md's rule: a dead control always states its reason. Hidden
    // would have been fewer pixels and a support ticket.
    render(<TwoFactorSettings />)

    expect(screen.getByRole('button', { name: /turn off/i })).toBeDisabled()
    expect(screen.getByTestId('disable-blocked-reason')).toHaveTextContent(
      /required on this instance/i,
    )
  })

  it('leaves regenerate and change-method alone', async () => {
    // Neither removes the protection; blocking them would only strand
    // people on a factor they have lost.
    render(<TwoFactorSettings />)

    expect(screen.getByRole('button', { name: /regenerate backup codes/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /change method/i })).toBeEnabled()
  })
})
