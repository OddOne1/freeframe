/**
 * The instance-wide 2FA switch in admin settings (§197).
 *
 * Small surface, one property worth pinning beyond the round-trip: the copy
 * has to say that turning this on does NOT lock anyone out. That is the
 * question an admin actually has before flipping it, and the backend's
 * answer (§191: unenrolled users are routed into enrolment, not refused) is
 * only useful if it reaches the person deciding.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

let requireTwoFactor = false
const updateRequireTwoFactor = vi.fn()
vi.mock('@/hooks/use-site-settings', () => ({
  SITE_SETTINGS_KEY: '/site-settings',
  useSiteSettings: () => ({ requireTwoFactor, updateRequireTwoFactor }),
}))

import { RequireTwoFactorSection } from '../require-two-factor-section'

beforeEach(() => {
  vi.clearAllMocks()
  requireTwoFactor = false
})

describe('require-2FA toggle', () => {
  it('turns it on and reports the save', async () => {
    const user = userEvent.setup()
    updateRequireTwoFactor.mockResolvedValueOnce(undefined)
    render(<RequireTwoFactorSection />)

    expect(screen.getByText(/currently/i)).toHaveTextContent(/optional/i)
    await user.click(screen.getByRole('button', { name: /turn on/i }))

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

    await user.click(screen.getByRole('button', { name: /turn on/i }))

    expect(await screen.findByText('Forbidden')).toBeInTheDocument()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('says that nobody is locked out when it is switched on', () => {
    render(<RequireTwoFactorSection />)
    expect(screen.getByText(/nobody is locked out/i)).toBeInTheDocument()
    expect(screen.getByText(/next sign-in/i)).toBeInTheDocument()
  })
})
