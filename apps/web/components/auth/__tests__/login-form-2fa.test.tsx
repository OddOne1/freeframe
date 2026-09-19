/**
 * The login screen under two-factor authentication (§196).
 *
 * The bug this file exists for is not subtle: both submit paths used to read
 * `res.access_token` off a response that, for a 2FA-gated account, does not
 * have one — so turning `require_2fa` on made every login in the product
 * bounce silently while storing `undefined` as a token. The first two
 * describes are about that, and they assert what reaches `setTokens` rather
 * than only what is on screen, because a form that renders correctly and
 * stores a broken session is the exact failure being fixed.
 *
 * The rest covers what the new screens have to guarantee: an enrolled user is
 * still challenged when the instance-wide requirement is OFF (that is the
 * case §191 designed for, and the easiest one to lose), backup codes are
 * shown and gate the redirect, and magic-code sign-in is not offered on an
 * instance whose API refuses it (§195).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { SiteSettingsResponse } from '@/types'

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
  setTokens: (...args: unknown[]) => setTokens(...args),
  getAccessToken: () => null,
}))

const fetchUser = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ fetchUser }) },
}))

/** `require_2fa` is read through useSiteSettings, which is SWR over
 *  GET /site-settings. Mocked at the hook rather than the network so each
 *  test states the instance's setting in one line. */
let requireTwoFactor = false
let settingsLoading = false
vi.mock('@/hooks/use-site-settings', () => ({
  SITE_SETTINGS_KEY: '/site-settings',
  useSiteSettings: () => ({
    requireTwoFactor,
    isLoading: settingsLoading,
    orgName: 'FreeFrame',
  }),
}))

import { api } from '@/lib/api'
import { LoginForm } from '../login-form'

const TOKENS = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'bearer',
  needs_password: false,
  requires_2fa: false as const,
}

function challenge(over: Record<string, unknown> = {}) {
  return {
    requires_2fa: true as const,
    setup_required: false,
    pending_token: 'pending-1',
    method: 'totp' as const,
    email_code_sent: false,
    ...over,
  }
}

async function signInWithPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/email address/i), 'u@example.com')
  await user.type(screen.getByLabelText(/^password$/i), 'hunter2hunter2')
  await user.click(screen.getByRole('button', { name: /^sign in$/i }))
}

/** Types a full code into the six boxes. The last digit auto-submits, which
 *  is the behaviour the extracted CodeInput is responsible for. */
async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) {
    await user.type(boxes[i], code[i])
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireTwoFactor = false
  settingsLoading = false
})

// ── what used to break ──────────────────────────────────────────────────────

describe('a 2FA challenge is recognised instead of being read as tokens', () => {
  it('does not store a session when the password login is only half done', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(challenge())
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)

    await screen.findByText(/open your authenticator app/i)
    expect(setTokens).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not store a session when the MAGIC CODE login is only half done', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce(challenge({ method: 'email', email_code_sent: true }))
    render(<LoginForm />)

    await user.type(screen.getByLabelText(/email address/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /send magic code/i }))
    await screen.findByText(/we sent a 6-digit code/i)
    await typeCode(user, '123456')

    await screen.findByText(/we sent a 6-digit code to u@example.com/i)
    expect(setTokens).not.toHaveBeenCalled()
  })

  it('still signs in normally when no second factor is required', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(TOKENS)
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)

    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
    expect(replace).toHaveBeenCalledWith('/projects')
  })

  it('still routes a passwordless magic-code user to the create-password step', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce({ message: 'sent' })
      .mockResolvedValueOnce({ ...TOKENS, needs_password: true })
    render(<LoginForm />)

    await user.type(screen.getByLabelText(/email address/i), 'u@example.com')
    await user.click(screen.getByRole('button', { name: /send magic code/i }))
    await typeCode(user, '123456')

    expect(await screen.findByText(/create your password/i)).toBeInTheDocument()
  })
})

// ── completing a login ──────────────────────────────────────────────────────

describe('the 2fa-code step', () => {
  it('verifies a TOTP code and finishes the login', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(challenge())
      .mockResolvedValueOnce(TOKENS)
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)
    await screen.findByText(/open your authenticator app/i)
    await typeCode(user, '654321')

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/verify-login', {
        pending_token: 'pending-1',
        code: '654321',
      }),
    )
    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
  })

  it('challenges an enrolled user even when the instance does NOT require 2FA', async () => {
    // The case §191 built enforcement-off around: turning the site-wide
    // requirement off must not silently downgrade someone who opted in.
    requireTwoFactor = false
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(challenge())
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)

    expect(await screen.findByText(/open your authenticator app/i)).toBeInTheDocument()
    expect(setTokens).not.toHaveBeenCalled()
  })

  it('names the email and offers a resend for an email-primary user', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(challenge({ method: 'email', email_code_sent: true }))
      .mockResolvedValueOnce({ message: 'sent' })
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)
    expect(await screen.findByText(/we sent a 6-digit code to u@example.com/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /resend code/i }))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/send-email-fallback', {
        pending_token: 'pending-1',
      }),
    )
    expect(await screen.findByText(/we sent a new 6-digit code/i)).toBeInTheDocument()
  })

  it('shows no resend button on the authenticator path', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post).mockResolvedValueOnce(challenge())
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)
    await screen.findByText(/open your authenticator app/i)

    expect(screen.queryByRole('button', { name: /resend code/i })).toBeNull()
  })

  it('clears the boxes and says so when the code is wrong', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(challenge())
      .mockRejectedValueOnce(new ApiError(401, 'Invalid code'))
    render(<LoginForm />)

    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)
    await screen.findByText(/open your authenticator app/i)
    await typeCode(user, '000000')

    expect(await screen.findByText('Invalid code')).toBeInTheDocument()
    expect(setTokens).not.toHaveBeenCalled()
    for (const box of screen.getAllByLabelText(/^digit /i)) {
      expect(box).toHaveValue('')
    }
  })
})

// ── forced enrolment ────────────────────────────────────────────────────────

describe('the 2fa-setup step', () => {
  const SETUP_CHALLENGE = challenge({ setup_required: true, method: null })

  async function reachSetup(user: ReturnType<typeof userEvent.setup>) {
    render(<LoginForm />)
    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await signInWithPassword(user)
    await screen.findByText(/set up two-factor sign-in/i)
  }

  it('enrols with an authenticator end to end', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(SETUP_CHALLENGE)
      .mockResolvedValueOnce({
        method: 'totp',
        provisioning_uri: 'otpauth://totp/x',
        qr_code_data_uri: 'data:image/png;base64,AAA',
        secret: 'JBSWY3DPEHPK3PXP',
        email_code_sent: false,
      })
      .mockResolvedValueOnce({
        backup_codes: ['aaaa-1111', 'bbbb-2222'],
        method: 'totp',
        tokens: TOKENS,
      })
    await reachSetup(user)

    await user.click(screen.getByRole('button', { name: /authenticator app/i }))

    expect(await screen.findByAltText(/two-factor setup qr code/i)).toHaveAttribute(
      'src',
      'data:image/png;base64,AAA',
    )
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeInTheDocument()
    expect(api.post).toHaveBeenCalledWith('/auth/2fa/setup', {
      pending_token: 'pending-1',
      method: 'totp',
    })

    await typeCode(user, '111222')

    expect(await screen.findByText(/save your backup codes/i)).toBeInTheDocument()
  })

  it('enrols by email, and its resend goes through /2fa/setup, not the fallback endpoint', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(SETUP_CHALLENGE)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockResolvedValueOnce({ method: 'email', email_code_sent: false })
    await reachSetup(user)

    await user.click(screen.getByRole('button', { name: /^email/i }))
    expect(await screen.findByText(/we sent a 6-digit code to u@example.com/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /send it again/i }))

    // /2fa/send-email-fallback does nothing for a user who is not enrolled
    // yet — it checks two_factor_enabled — so enrolment resends through
    // /2fa/setup, and says honestly that the old code is still the live one.
    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith('/auth/2fa/setup', {
        pending_token: 'pending-1',
        method: 'email',
      }),
    )
    expect(
      await screen.findByText(/a code was already sent to u@example.com/i),
    ).toBeInTheDocument()
    expect(api.post).not.toHaveBeenCalledWith(
      '/auth/2fa/send-email-fallback',
      expect.anything(),
    )
  })

  it('shows the backup codes and will not continue until they are acknowledged', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(SETUP_CHALLENGE)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockResolvedValueOnce({
        backup_codes: ['aaaa-1111', 'bbbb-2222', 'cccc-3333'],
        method: 'email',
        tokens: TOKENS,
      })
    await reachSetup(user)
    await user.click(screen.getByRole('button', { name: /^email/i }))
    await typeCode(user, '333444')

    await screen.findByText(/save your backup codes/i)
    expect(screen.getByText('aaaa-1111')).toBeInTheDocument()
    expect(screen.getByText('cccc-3333')).toBeInTheDocument()
    // The response carried real tokens — and they are deliberately NOT used
    // yet. Redirecting here is what would destroy codes that are shown once.
    expect(setTokens).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /i've saved these codes/i }))

    await waitFor(() => expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1'))
    expect(replace).toHaveBeenCalledWith('/projects')
  })
})

// ── which screen opens ──────────────────────────────────────────────────────

describe('magic-code sign-in is not offered when the instance requires 2FA', () => {
  it('opens on email + password, with no way back to the magic-code screen', () => {
    requireTwoFactor = true
    render(<LoginForm />)

    expect(screen.getByText(/sign in with password/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send magic code/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /back to magic link/i })).toBeNull()
  })

  it('still opens on the magic-code screen when it does not', () => {
    requireTwoFactor = false
    render(<LoginForm />)

    expect(screen.getByRole('button', { name: /send magic code/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in with password instead/i })).toBeInTheDocument()
  })

  it('paints neither while the setting is still unknown', () => {
    // Only reachable when the server-side seed failed. Guessing here is what
    // would flash the wrong screen at every visitor on a 2FA instance.
    settingsLoading = true
    render(<LoginForm />)

    expect(screen.queryByRole('button', { name: /send magic code/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^sign in$/i })).toBeNull()
  })
})
