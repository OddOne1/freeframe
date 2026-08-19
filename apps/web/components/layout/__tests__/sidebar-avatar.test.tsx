/**
 * The sidebar avatar navigates rather than opening a menu (CLAUDE.md §46).
 *
 * The ask was "no popup at all, not even a flash", so what is asserted is
 * that there is no menu trigger left — a dropdown that merely starts closed
 * would still satisfy a test that only clicked and looked for a menu.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const logout = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { name: 'Tester', email: 't@example.com', avatar_url: null },
    logout,
  }),
}))
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ orgName: 'FreeFrame', logoDarkUrl: null, logoLightUrl: null }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
// The sidebar fetches notifications on mount; without this the store's real
// fetch reaches for localhost:8000 and vitest reports an unhandled rejection.
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({ unreadCount: 0, fetchNotifications: vi.fn() }),
}))

import { Sidebar } from '../sidebar'

describe('sidebar avatar', () => {
  it('is a link straight to the profile page', async () => {
    render(<Sidebar collapsed={false} onToggle={() => {}} />)
    const avatar = screen.getByRole('link', { name: /Tester/ })
    expect(avatar).toHaveAttribute('href', '/settings/profile')

    await userEvent.click(avatar)
    // No popup at any point, which is stronger than "no popup after a click":
    // a menu trigger would still be in the DOM even while closed.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-haspopup="menu"]')).toBeNull()
  })

  it('no longer offers log out from the sidebar', () => {
    render(<Sidebar collapsed={false} onToggle={() => {}} />)
    // It moved to the Profile page; the point is that it is not here twice.
    expect(screen.queryByText('Log out')).not.toBeInTheDocument()
    expect(logout).not.toHaveBeenCalled()
  })
})
