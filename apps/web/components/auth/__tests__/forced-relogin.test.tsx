/**
 * Forced re-login when 2FA becomes mandatory — the web half of §207.
 *
 * Two screens changed, and they changed for the same reason: turning 2FA on
 * used to leave single-factor sessions running.
 *
 * 1. The admin switch. "Turn on" was one click with an invisible blast
 *    radius; it now asks first and says how many people it will sign out,
 *    with the number coming from the server before the write.
 * 2. The forced-enrolment backup-codes screen. It used to adopt the tokens
 *    confirm-setup handed back and redirect into the app — so enrolment
 *    ended in a live session for a user who had never once presented the
 *    second factor the instance had just started requiring. It now ends that
 *    session, server-side and locally, and sends them to sign in properly.
 *
 * Everything here is asserted on rendered data and on what reached the API,
 * never on static chrome: a heading that happens to be present proves
 * nothing about whether the count was fetched or the session was ended.
 *
 * `BackupCodes`'s default behaviour is pinned too. It is shared with the
 * settings page's own enrolment and backup-code regeneration, both of which
 * §207 is explicitly NOT meant to touch, so the new gate is opt-in and the
 * unchanged callers are tested for being unchanged.
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
const rememberSignOutNotice = vi.fn()
/** What a previous page's logout left behind for the login screen to show.
 *  Set per test; read once, on mount. */
let pendingSignOutNotice: string | null = null
vi.mock('@/lib/auth', () => ({
  setTokens: (...args: unknown[]) => setTokens(...args),
  getAccessToken: () => null,
  setSignOutNotice: (...args: unknown[]) => rememberSignOutNotice(...args),
  takeSignOutNotice: () => pendingSignOutNotice,
}))

const fetchUser = vi.fn()
const logout = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: { getState: () => ({ fetchUser, logout }) },
}))

let requireTwoFactor = false
const updateRequireTwoFactor = vi.fn()
const previewRequireTwoFactorImpact = vi.fn()
vi.mock('@/hooks/use-site-settings', () => ({
  SITE_SETTINGS_KEY: '/site-settings',
  useSiteSettings: () => ({
    requireTwoFactor,
    isLoading: false,
    orgName: 'FreeFrame',
    updateRequireTwoFactor,
    previewRequireTwoFactorImpact,
  }),
}))

import { api } from '@/lib/api'
import { BackupCodes } from '../backup-codes'
import { LoginForm } from '../login-form'
import { RequireTwoFactorSection } from '@/components/settings/require-two-factor-section'

const CODES = ['aaaa-1111', 'bbbb-2222', 'cccc-3333']

/** Types a full code into the six boxes. Indexed by POSITION, not by
 *  `indexOf` — a repeated digit would otherwise be typed into the same box
 *  six times and the form would never submit. */
async function typeCode(user: ReturnType<typeof userEvent.setup>, code: string) {
  const boxes = screen.getAllByLabelText(/^digit /i)
  for (let i = 0; i < code.length; i++) await user.type(boxes[i], code[i])
}

beforeEach(() => {
  vi.clearAllMocks()
  // `clearAllMocks` resets recorded CALLS but leaves a queue built with
  // `mockResolvedValueOnce` in place. A test here that reaches the codes
  // screen without dismissing it leaves its last queued value unconsumed,
  // and the next test's first request would then get that leftover instead
  // of its own first value — which fails as a wrong SCREEN several steps
  // later, a long way from the cause. Reset the queue explicitly.
  vi.mocked(api.post).mockReset()
  vi.mocked(api.get).mockReset()
  requireTwoFactor = false
  pendingSignOutNotice = null
})

// ── A — the admin switch asks, and says how many ───────────────────────────

describe('turning the instance-wide requirement on', () => {
  it('shows the count from the server before anything is saved', async () => {
    const user = userEvent.setup()
    previewRequireTwoFactorImpact.mockResolvedValueOnce(7)
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn on/i }))

    expect(await screen.findByText(/7 users will be signed out/i)).toBeInTheDocument()
    // The whole point of the step: nothing has been written yet.
    expect(updateRequireTwoFactor).not.toHaveBeenCalled()
  })

  it('writes only after the confirmation is accepted, and reports what happened', async () => {
    const user = userEvent.setup()
    previewRequireTwoFactorImpact.mockResolvedValueOnce(2)
    updateRequireTwoFactor.mockResolvedValueOnce(2)
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn on/i }))
    await user.click(await screen.findByRole('button', { name: /turn on and sign them out/i }))

    await waitFor(() => expect(updateRequireTwoFactor).toHaveBeenCalledWith(true))
    // The figure in the confirmation came from the preview; this one is the
    // write's own row count, which is why it is asserted separately.
    expect(await screen.findByText(/2 users were signed out/i)).toBeInTheDocument()
  })

  it('cancelling writes nothing', async () => {
    const user = userEvent.setup()
    previewRequireTwoFactorImpact.mockResolvedValueOnce(3)
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn on/i }))
    await user.click(await screen.findByRole('button', { name: /cancel/i }))

    expect(updateRequireTwoFactor).not.toHaveBeenCalled()
    expect(await screen.findByRole('button', { name: /turn on/i })).toBeInTheDocument()
  })

  it('says plainly when nobody is affected, rather than showing "0 users"', async () => {
    const user = userEvent.setup()
    previewRequireTwoFactorImpact.mockResolvedValueOnce(0)
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn on/i }))

    expect(await screen.findByText(/nobody will be signed out/i)).toBeInTheDocument()
  })

  it('turning it OFF still takes one click — that direction ends no sessions', async () => {
    const user = userEvent.setup()
    requireTwoFactor = true
    updateRequireTwoFactor.mockResolvedValueOnce(null)
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn off/i }))

    await waitFor(() => expect(updateRequireTwoFactor).toHaveBeenCalledWith(false))
    expect(previewRequireTwoFactorImpact).not.toHaveBeenCalled()
  })
})

// ── B — the codes screen signs the user out ────────────────────────────────

describe('the forced-enrolment backup-codes screen', () => {
  const SETUP_CHALLENGE = {
    requires_2fa: true as const,
    setup_required: true,
    pending_token: 'pending-1',
    method: null,
    email_code_sent: false,
  }
  const CONFIRMED = {
    backup_codes: CODES,
    method: 'email' as const,
    tokens: {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'bearer',
      needs_password: false,
    },
  }

  async function reachTheCodes(user: ReturnType<typeof userEvent.setup>) {
    vi.mocked(api.post)
      .mockResolvedValueOnce(SETUP_CHALLENGE)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockResolvedValueOnce(CONFIRMED)
      .mockResolvedValueOnce({ signed_out: true })

    render(<LoginForm />)
    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await user.type(screen.getByLabelText(/email address/i), 'u@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2hunter2')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    await screen.findByText(/set up two-factor sign-in/i)
    await user.click(screen.getByRole('button', { name: /^email/i }))

    await typeCode(user, '333444')
    await screen.findByText(/save your backup codes/i)
  }

  it('will not let the codes be dismissed until they are acknowledged, and says why', async () => {
    const user = userEvent.setup()
    await reachTheCodes(user)

    const dismiss = screen.getByRole('button', { name: /continue and sign in again/i })
    expect(dismiss).toBeDisabled()
    // (17c) — a disabled control has to explain itself.
    expect(screen.getByText(/tick the box above to continue/i)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox'))

    expect(dismiss).toBeEnabled()
    expect(screen.queryByText(/tick the box above to continue/i)).not.toBeInTheDocument()
  })

  it('tells the user what dismissing will do, before they do it', async () => {
    const user = userEvent.setup()
    await reachTheCodes(user)

    expect(screen.getByText(/you will be signed out/i)).toBeInTheDocument()
  })

  it('ends the session server-side and locally, and leaves the reason behind', async () => {
    const user = userEvent.setup()
    await reachTheCodes(user)

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /continue and sign in again/i }))

    // Server first, while the pair confirm-setup issued is still valid — that
    // request is the only thing those tokens exist for here.
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/2fa/end-enrolment-session', {}),
    )
    expect(setTokens).toHaveBeenCalledWith('access-1', 'refresh-1')
    expect(logout).toHaveBeenCalled()
    expect(rememberSignOutNotice).toHaveBeenCalledWith(
      'Two-factor is now active. Sign in again to continue.',
    )
    // Not into the app. This is the regression §207 fixes.
    expect(replace).not.toHaveBeenCalledWith('/projects')
  })

  it('still signs the user out if the server call fails', async () => {
    const user = userEvent.setup()
    vi.mocked(api.post)
      .mockResolvedValueOnce(SETUP_CHALLENGE)
      .mockResolvedValueOnce({ method: 'email', email_code_sent: true })
      .mockResolvedValueOnce(CONFIRMED)
      .mockRejectedValueOnce(new Error('network'))

    render(<LoginForm />)
    await user.click(screen.getByRole('button', { name: /sign in with password/i }))
    await user.type(screen.getByLabelText(/email address/i), 'u@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'hunter2hunter2')
    await user.click(screen.getByRole('button', { name: /^sign in$/i }))
    await screen.findByText(/set up two-factor sign-in/i)
    await user.click(screen.getByRole('button', { name: /^email/i }))
    await typeCode(user, '333444')
    await screen.findByText(/save your backup codes/i)

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /continue and sign in again/i }))

    // Trapping somebody on a screen whose codes are already spent would be
    // worse than losing the server-side half of the logout.
    await waitFor(() => expect(logout).toHaveBeenCalled())
  })
})

// ── the login screen explains itself afterwards ────────────────────────────

describe('the login screen after that sign-out', () => {
  it('shows the reason it was given', async () => {
    requireTwoFactor = true
    pendingSignOutNotice = 'Two-factor is now active. Sign in again to continue.'
    render(<LoginForm />)

    expect(
      await screen.findByText(/two-factor is now active\. sign in again to continue\./i),
    ).toBeInTheDocument()
  })

  it('shows nothing when there is no reason to show', () => {
    requireTwoFactor = true
    render(<LoginForm />)

    expect(screen.queryByText(/two-factor is now active/i)).not.toBeInTheDocument()
  })
})

// ── out of scope, pinned ──────────────────────────────────────────────────

describe('BackupCodes without the new gate (settings enrolment, regeneration)', () => {
  it('dismisses on one click, exactly as before §207', async () => {
    const user = userEvent.setup()
    const onAcknowledge = vi.fn()
    render(<BackupCodes codes={CODES} onAcknowledge={onAcknowledge} />)

    const dismiss = screen.getByRole('button', { name: /i've saved these codes/i })
    expect(dismiss).toBeEnabled()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    await user.click(dismiss)
    expect(onAcknowledge).toHaveBeenCalled()
  })

  it('does not call back while the gate is on and unacknowledged', async () => {
    const user = userEvent.setup()
    const onAcknowledge = vi.fn()
    render(
      <BackupCodes codes={CODES} onAcknowledge={onAcknowledge} requireExplicitAcknowledgement />,
    )

    await user.click(screen.getByRole('button', { name: /i've saved these codes/i }))
    expect(onAcknowledge).not.toHaveBeenCalled()

    await user.click(screen.getByRole('checkbox'))
    await user.click(screen.getByRole('button', { name: /i've saved these codes/i }))
    expect(onAcknowledge).toHaveBeenCalled()
  })
})
