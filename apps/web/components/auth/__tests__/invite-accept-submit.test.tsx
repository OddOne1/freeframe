/**
 * Accepting an invite: the submit button works, and never dies silently (§202).
 *
 * The report: name filled, a 16-character password with all four classes, an
 * identical confirmation, all five checklist items green — and "Create account
 * & join" stayed disabled with no message anywhere. Every request 200.
 *
 * The cause was not on this page. `lib/password-policy.ts` read
 * `common.default.dictionary` from a package that has no default export, so
 * scoring threw, the `catch` set the score to null, and
 * `disabled={!strength?.meetsPolicy || ...}` was permanently true. See
 * `lib/__tests__/password-policy-loading.test.ts` for the module-shape half,
 * which is what actually proves the root cause; this file is about the
 * behaviour a person sees.
 *
 * The scoring path is left REAL here rather than mocked. Mocking it would
 * assume the very thing that was broken, and the whole lesson of §202 is that
 * a test which stubs the hard part reproduces the stub, not production.
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
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: Object.assign(() => ({}), { getState: () => ({ fetchUser }) }),
}))

import { api } from '@/lib/api'
import { InviteAccept } from '@/components/auth/invite-accept'

const POLICY = {
  min_length: 12,
  min_strength_score: 3,
  requires_upper: true,
  requires_lower: true,
  requires_digit: true,
  requires_special: true,
}

const GOOD = 'Xq7#vLm2$kPzR4w'

beforeEach(() => {
  vi.clearAllMocks()
  // Faithful to the page: it makes TWO different GETs, and an earlier
  // scratch reproduction that answered both with the policy object would
  // never have rendered the card at all.
  vi.mocked(api.get).mockImplementation(async (path: string) => {
    if (path.startsWith('/auth/invite/')) {
      return {
        email: 'newcomer@example.com',
        org_name: 'YON Studio',
      } as never
    }
    if (path === '/auth/password-policy') return POLICY as never
    throw new Error(`unexpected GET ${path}`)
  })
})

async function fillForm(user: ReturnType<typeof userEvent.setup>, password: string, confirm = password) {
  await user.type(screen.getByLabelText('Full name'), 'Mathias Sonnleitner')
  await user.type(screen.getByLabelText('Password'), password)
  if (confirm) await user.type(screen.getByLabelText('Confirm password'), confirm)
}

const submit = () => screen.getByRole('button', { name: /create account/i })

describe('the reported case', () => {
  it('enables submit for a strong password and posts it', async () => {
    vi.mocked(api.post).mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'bearer',
    })
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    const user = userEvent.setup()
    await fillForm(user, GOOD)

    await waitFor(() => expect(submit()).toBeEnabled())
    // Nothing left to explain once it is pressable.
    expect(screen.queryByTestId('submit-block-reason')).not.toBeInTheDocument()

    await user.click(submit())
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/auth/accept-invite', {
        token: 'tok',
        name: 'Mathias Sonnleitner',
        password: GOOD,
      }),
    )
    expect(setTokens).toHaveBeenCalledWith('a', 'r')
  })

  it('actually scores the password rather than leaving the meter blank', async () => {
    // The visible symptom: an empty strength bar. If the dictionary loader
    // regresses, this fails here rather than as a mysteriously dead button.
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    await userEvent.setup().type(screen.getByLabelText('Password'), GOOD)

    await waitFor(() =>
      expect(screen.getByTestId('password-meter')).toHaveTextContent(/strong|medium/),
    )
  })
})

describe('a blocked submit is never silent', () => {
  it('says what is missing while the password is too short', async () => {
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    await userEvent.setup().type(screen.getByLabelText('Password'), 'Ab3$xKm9')

    expect(submit()).toBeDisabled()
    expect(await screen.findByTestId('submit-block-reason')).toHaveTextContent(
      /at least 12 characters/,
    )
  })

  it('names the missing character classes', async () => {
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    await userEvent.setup().type(screen.getByLabelText('Password'), 'abcdefghijklmnop')

    expect(await screen.findByTestId('submit-block-reason')).toHaveTextContent(
      /upper-case letter/,
    )
  })

  it('asks for the confirmation once the password itself is fine', async () => {
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    await userEvent.setup().type(screen.getByLabelText('Password'), GOOD)

    expect(await screen.findByTestId('submit-block-reason')).toHaveTextContent(
      /Confirm your password/,
    )
  })

  it('reports a mismatch as soon as the two fields differ', async () => {
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    const user = userEvent.setup()
    await fillForm(user, GOOD, 'Xq7#vLm2$kPzR4X')

    // Twice over: on the field itself, and as the reason the button is dead.
    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()
    expect(await screen.findByTestId('submit-block-reason')).toHaveTextContent(
      /Passwords do not match/,
    )
    expect(submit()).toBeDisabled()
  })

  it('never disables the button without saying why', async () => {
    // The invariant, rather than a list of cases. Whatever the form state,
    // a dead button and an empty screen must not coexist.
    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    const user = userEvent.setup()
    const states = ['', 'a', 'Ab3$xKm9', 'abcdefghijklmnop', GOOD]
    for (const value of states) {
      await user.clear(screen.getByLabelText('Password'))
      if (value) await user.type(screen.getByLabelText('Password'), value)
      await waitFor(() => {
        if ((submit() as HTMLButtonElement).disabled) {
          expect(screen.getByTestId('submit-block-reason')).toBeInTheDocument()
        }
      })
    }
  })
})

describe('when scoring is unavailable', () => {
  it('still lets a policy-satisfying password be submitted', async () => {
    // §202's real lesson. Even with the meter dead, the form must work: the
    // server runs the full policy on /auth/accept-invite, so the worst case
    // is a rendered error, and blocking instead means nobody can accept an
    // invite at all — which is exactly what happened.
    const failing = vi
      .spyOn(await import('@/lib/password-policy'), 'scorePassword')
      .mockRejectedValue(new Error('chunk load failed'))
    vi.mocked(api.post).mockResolvedValue({
      access_token: 'a',
      refresh_token: 'r',
      token_type: 'bearer',
    })

    render(<InviteAccept token="tok" />)
    await screen.findByLabelText('Password')

    const user = userEvent.setup()
    await fillForm(user, GOOD)

    await waitFor(() => expect(submit()).toBeEnabled())
    await user.click(submit())
    await waitFor(() => expect(api.post).toHaveBeenCalled())

    failing.mockRestore()
  })
})
