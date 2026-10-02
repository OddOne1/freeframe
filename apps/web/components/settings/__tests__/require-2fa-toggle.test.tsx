/**
 * The instance-wide 2FA switch in admin settings (§197).
 *
 * Small surface, one property worth pinning beyond the round-trip: the copy
 * has to answer the question an admin actually has before flipping it.
 *
 * §207 changed what that answer IS. The copy used to promise "nobody is
 * locked out when you turn this on", which was true of §191's design —
 * unenrolled users were routed into enrolment at their NEXT sign-in rather
 * than refused — and is no longer true now that the flip ends their current
 * sessions on the spot. Turning it on is therefore no longer a single click
 * either: it asks first and says how many people it will sign out. These
 * tests follow that change rather than working around it.
 *
 * The confirmation flow itself is covered in depth in
 * components/auth/__tests__/forced-relogin.test.tsx, alongside the
 * forced-enrolment half of §207 it belongs with. What stays here is this
 * file's original subject: the round-trip, the error path, and the copy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let requireTwoFactor = false
const updateRequireTwoFactor = vi.fn()
const previewRequireTwoFactorImpact = vi.fn()
vi.mock('@/hooks/use-site-settings', () => ({
  SITE_SETTINGS_KEY: '/site-settings',
  useSiteSettings: () => ({
    requireTwoFactor,
    updateRequireTwoFactor,
    previewRequireTwoFactorImpact,
  }),
}))

import { RequireTwoFactorSection } from '../require-two-factor-section'

beforeEach(() => {
  vi.clearAllMocks()
  requireTwoFactor = false
  previewRequireTwoFactorImpact.mockResolvedValue(0)
})

/** §207 — "turn on" now opens a confirmation first. Walking both clicks in
 *  one helper keeps each test about its own subject. */
async function turnOn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /turn on/i }))
  await user.click(
    await screen.findByRole('button', { name: /turn on and sign them out/i }),
  )
}

describe('require-2FA toggle', () => {
  it('turns it on and reports the save', async () => {
    const user = userEvent.setup()
    updateRequireTwoFactor.mockResolvedValueOnce(undefined)
    render(<RequireTwoFactorSection />)

    expect(screen.getByText(/currently/i)).toHaveTextContent(/optional/i)
    await turnOn(user)

    await waitFor(() => expect(updateRequireTwoFactor).toHaveBeenCalledWith(true))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('turns it back off', async () => {
    requireTwoFactor = true
    const user = userEvent.setup()
    updateRequireTwoFactor.mockResolvedValueOnce(undefined)
    render(<RequireTwoFactorSection />)

    expect(screen.getByText(/currently/i)).toHaveTextContent(/required/i)
    await user.click(screen.getByRole('button', { name: /turn off/i }))

    await waitFor(() => expect(updateRequireTwoFactor).toHaveBeenCalledWith(false))
  })

  it('surfaces a failed save instead of pretending it worked', async () => {
    const user = userEvent.setup()
    updateRequireTwoFactor.mockRejectedValueOnce(new Error('Forbidden'))
    render(<RequireTwoFactorSection />)

    await turnOn(user)

    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('surfaces a failed COUNT without pretending the save happened', async () => {
    const user = userEvent.setup()
    previewRequireTwoFactorImpact.mockReset()
    previewRequireTwoFactorImpact.mockRejectedValueOnce(new Error('Forbidden'))
    render(<RequireTwoFactorSection />)

    await user.click(screen.getByRole('button', { name: /turn on/i }))

    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
    // No confirmation to accept, and nothing written — an admin must not be
    // asked to confirm a number that could not be read.
    expect(
      screen.queryByRole('button', { name: /turn on and sign them out/i }),
    ).toBeNull()
    expect(updateRequireTwoFactor).not.toHaveBeenCalled()
  })

  it('says what turning it on does to the people who are signed in', () => {
    render(<RequireTwoFactorSection />)
    // §207 — the old assertions here were /nobody is locked out/ and
    // /next sign-in/. Both described behaviour this section no longer has:
    // the flip signs unenrolled users out immediately. Promising otherwise
    // would be the copy lying about a destructive action.
    expect(screen.getByText(/signs out everyone who has not set up/i)).toBeInTheDocument()
    expect(
      screen.getByText(/users who already have 2fa are not\s+signed out/i),
    ).toBeInTheDocument()
  })
})
