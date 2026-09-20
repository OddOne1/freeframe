/**
 * The onboarding gate, client side (§200).
 *
 * The gate is ENFORCED by `middleware/account_gate.py`, which answers 403
 * `account_setup_required` to every protected route on its own. Nothing here
 * changes that, and these tests are deliberately written so they could not be
 * mistaken for the enforcement: what is asserted is that the screen renders
 * from what `/auth/me` reports, in the right order, and never from anything
 * this app decided for itself.
 *
 * Two properties carry the weight:
 *
 *   * `accountSetupOutstanding` only clears on "verified". A stored but
 *     unproved address is a recovery path that only looks like one, and
 *     reading it as done here would put a user in front of an app that
 *     answers 403 to everything with no explanation on screen.
 *   * after each write the screen re-reads `/auth/me` rather than unblocking
 *     itself. The server decides; a screen that assumed its own success would
 *     drift out of step with the middleware on the very next request.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { User } from '@/types'

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})

const setTokens = vi.fn()
vi.mock('@/lib/auth', () => ({
  setTokens: (...args: unknown[]) => setTokens(...args),
  getAccessToken: () => null,
  clearTokens: vi.fn(),
}))

const fetchUser = vi.fn()
const logout = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(
    () => ({ fetchUser, logout }),
    { getState: () => ({ fetchUser, logout }) },
  ),
}))

import { api } from '@/lib/api'
import {
  AccountSetupGate,
  accountSetupOutstanding,
} from '@/components/auth/account-setup-gate'

const apiMock = api as unknown as {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
}

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'u1',
    email: 'user@yon.studio',
    name: 'Test User',
    first_name: 'Test',
    last_name: 'User',
    avatar_url: null,
    status: 'active',
    role: 'superuser',
    email_verified: true,
    preferences: {},
    created_at: new Date().toISOString(),
    deleted_at: null,
    must_set_password: false,
    backup_email_state: 'verified',
    backup_email: 'backup@gmx.at',
    ...overrides,
  } as User
}

beforeEach(() => {
  vi.clearAllMocks()
  // The policy endpoint, so the meter states the real numbers.
  apiMock.get.mockResolvedValue({
    min_length: 12,
    min_strength_score: 3,
    requires_upper: true,
    requires_lower: true,
    requires_digit: true,
    requires_special: true,
  })
})

describe('accountSetupOutstanding', () => {
  it('is true while there is no password', () => {
    expect(accountSetupOutstanding(user({ must_set_password: true }))).toBe(true)
  })

  it('is true while the backup address is only PENDING', () => {
    // The one that matters. An address nobody has proved is a mailbox is not
    // a recovery channel, and treating "pending" as done would show the
    // dashboard to someone every route still refuses.
    expect(
      accountSetupOutstanding(user({ backup_email_state: 'pending' })),
    ).toBe(true)
  })

  it('is true while there is no backup address at all', () => {
    expect(
      accountSetupOutstanding(user({ backup_email_state: 'missing' })),
    ).toBe(true)
  })

  it('is false once both are real', () => {
    expect(accountSetupOutstanding(user())).toBe(false)
  })

  it('treats a response with neither field as not gated', () => {
    // An older API, or a cached /auth/me. Inventing a gate the server will
    // not enforce would block the app for no reason the user can act on.
    const legacy = user()
    delete (legacy as Partial<User>).must_set_password
    delete (legacy as Partial<User>).backup_email_state
    expect(accountSetupOutstanding(legacy)).toBe(false)
  })

  it('is false when there is no user yet', () => {
    expect(accountSetupOutstanding(null)).toBe(false)
  })
})

describe('the gate screen', () => {
  it('asks for the password first and holds the address step back', async () => {
    render(<AccountSetupGate user={user({ must_set_password: true })} />)

    expect(screen.getByText('1. Set a password')).toBeInTheDocument()
    // The second step is visible but inert: confirming where to send a reset
    // is meaningless for an account that has nothing to reset.
    expect(screen.getByText('Set your password first.')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Password-reset address'),
    ).not.toBeInTheDocument()
  })

  it('offers the address step once the password exists', () => {
    render(
      <AccountSetupGate
        user={user({ must_set_password: false, backup_email_state: 'missing', backup_email: null })}
      />,
    )

    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByLabelText('Password-reset address')).toBeInTheDocument()
  })

  it('has no way to dismiss or skip it', () => {
    // Deliberate: the state is derived from stored data, so a dismissal
    // would have to be stored as a flag — and a flag is exactly what §200
    // refused, because it drifts from the data and survives the data being
    // cleared.
    render(<AccountSetupGate user={user({ must_set_password: true })} />)

    expect(screen.queryByText(/skip/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/later/i)).not.toBeInTheDocument()
    // Signing out IS offered — it is how somebody reaches an admin who can
    // unblock them.
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('keeps the submit button disabled until the password meets the rules', async () => {
    render(<AccountSetupGate user={user({ must_set_password: true })} />)
    const button = screen.getByRole('button', { name: 'Set password' })
    expect(button).toBeDisabled()

    await userEvent.type(screen.getByLabelText('New password'), 'short')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'short')
    await waitFor(() => expect(screen.getByTestId('password-meter')).toBeInTheDocument())
    expect(button).toBeDisabled()
  })

  it('adopts the replacement tokens and re-reads /auth/me after setting one', async () => {
    apiMock.post.mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'bearer',
    })

    render(<AccountSetupGate user={user({ must_set_password: true })} />)

    await userEvent.type(screen.getByLabelText('New password'), 'Tf4#qRn8!vZw')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Tf4#qRn8!vZw')

    const button = screen.getByRole('button', { name: 'Set password' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/auth/set-password', {
        password: 'Tf4#qRn8!vZw',
      }),
    )
    // §199 — setting a password bumps token_version and ends this tab's own
    // session. Without adopting the pair the response carries, the very next
    // request 401s and the user is signed out by securing their account.
    expect(setTokens).toHaveBeenCalledWith('a', 'r')
    // And the SERVER decides whether the gate lifts.
    expect(fetchUser).toHaveBeenCalled()
  })

  it('shows the server refusal rather than assuming the meter was right', async () => {
    const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
    apiMock.post.mockRejectedValue(
      new ApiError(400, 'Your password must not contain “user” — anyone targeting you already knows it.'),
    )

    render(<AccountSetupGate user={user({ must_set_password: true })} />)
    await userEvent.type(screen.getByLabelText('New password'), 'Tf4#qRn8!vZw')
    await userEvent.type(screen.getByLabelText('Confirm password'), 'Tf4#qRn8!vZw')

    const button = screen.getByRole('button', { name: 'Set password' })
    await waitFor(() => expect(button).toBeEnabled())
    await userEvent.click(button)

    // The blocklist and the personal-token rule exist only on the server, so
    // a green meter is not permission — this is the case that proves the
    // screen renders the refusal instead of swallowing it.
    await waitFor(() =>
      expect(screen.getByText(/must not contain/)).toBeInTheDocument(),
    )
  })

  it('refuses the login address as a backup address before asking the server', async () => {
    render(
      <AccountSetupGate
        user={user({ backup_email_state: 'missing', backup_email: null })}
      />,
    )

    await userEvent.type(
      screen.getByLabelText('Password-reset address'),
      'user@yon.studio',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send confirmation code' }),
    )

    await waitFor(() =>
      expect(screen.getByText(/different mailbox/)).toBeInTheDocument(),
    )
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('sends the candidate address and then asks for the code', async () => {
    apiMock.post.mockResolvedValue({
      backup_email: 'me@gmx.at',
      state: 'pending',
      code_sent: true,
      same_domain: false,
    })

    render(
      <AccountSetupGate
        user={user({ backup_email_state: 'missing', backup_email: null })}
      />,
    )

    await userEvent.type(
      screen.getByLabelText('Password-reset address'),
      'me@gmx.at',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send confirmation code' }),
    )

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/auth/backup-email', {
        backup_email: 'me@gmx.at',
      }),
    )
    expect(fetchUser).toHaveBeenCalled()
  })

  it('warns about a same-domain address without refusing it', async () => {
    apiMock.post.mockResolvedValue({
      backup_email: 'second@yon.studio',
      state: 'pending',
      code_sent: true,
      same_domain: true,
    })

    render(
      <AccountSetupGate
        user={user({ backup_email_state: 'missing', backup_email: null })}
      />,
    )

    await userEvent.type(
      screen.getByLabelText('Password-reset address'),
      'second@yon.studio',
    )
    await userEvent.click(
      screen.getByRole('button', { name: 'Send confirmation code' }),
    )

    await waitFor(() =>
      expect(screen.getByText(/same domain/)).toBeInTheDocument(),
    )
  })

  it('re-reads /auth/me after a code is confirmed instead of unblocking itself', async () => {
    apiMock.post.mockResolvedValue({})

    render(
      <AccountSetupGate
        user={user({ backup_email_state: 'pending', backup_email: 'me@gmx.at' })}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    // Six digits are required before anything is sent.
    expect(apiMock.post).not.toHaveBeenCalled()

    // One digit per box, the way CodeInput is actually driven: each input is
    // maxLength=1 and auto-advances, so typing six characters into the first
    // one is not what a person does and is not what the component handles.
    for (let i = 0; i < 6; i++) {
      await userEvent.type(screen.getByLabelText(`Digit ${i + 1}`), `${i + 1}`)
    }

    await waitFor(() =>
      expect(apiMock.post).toHaveBeenCalledWith('/auth/backup-email/verify', {
        code: '123456',
      }),
    )
    expect(fetchUser).toHaveBeenCalled()
  })
})
