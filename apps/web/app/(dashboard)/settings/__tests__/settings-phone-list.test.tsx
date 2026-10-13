/**
 * §229 A — `/settings` on a phone is the list of sections.
 *
 * Three real users through the REAL gate (`useVisibleSettingsNav`, which
 * reads the auth store and the project-privilege hook), because the thing
 * worth asserting is not "a list renders" but "the list is exactly what
 * the sidebar would have shown this person". A second gate of its own is
 * the mutation this file exists to catch.
 *
 * The component under test is the real one and so is the layout: the back
 * header lives in the layout, the list in the page, and the two have to
 * agree about which route shows which.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'

let isSuperAdmin = false
let hasProjectPrivilege = false
let pathname = '/settings'
const replace = vi.fn()

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { id: 'u1', name: 'Mathias Sonnleitner', email: 'm@example.com' },
    isSuperAdmin,
  }),
}))
vi.mock('@/hooks/use-project-privilege', () => ({
  useHasProjectPrivilege: () => hasProjectPrivilege,
}))
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace }),
}))

import SettingsLayout from '../layout'
import SettingsIndexPage from '../page'
import { SettingsSectionList } from '@/components/settings/settings-section-list'

beforeEach(() => {
  isSuperAdmin = false
  hasProjectPrivilege = false
  pathname = '/settings'
  replace.mockClear()
  // No matchMedia in jsdom's default: the index page reads it to decide
  // whether to redirect, and `undefined` must mean "do nothing".
  vi.stubGlobal('matchMedia', undefined)
})

function labels() {
  return screen
    .getAllByTestId('settings-section-row')
    .map((a) => a.textContent?.trim())
}

describe('the phone section list shows exactly what the gate allows', () => {
  it('a superadmin gets every section — and Branding is not one of them', () => {
    isSuperAdmin = true
    hasProjectPrivilege = true
    render(<SettingsSectionList />)

    expect(labels()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Projects',
      'Admin',
      'Contact',
    ])
    expect(labels()).not.toContain('Branding')
  })

  it('an admin on projects but not a superadmin gets Projects, not Admin', () => {
    isSuperAdmin = false
    hasProjectPrivilege = true
    render(<SettingsSectionList />)

    expect(labels()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Projects',
      'Contact',
    ])
  })

  it('a plain member gets the four ungated sections and Contact', () => {
    render(<SettingsSectionList />)

    expect(labels()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Contact',
    ])
  })

  it('names the user at the top, so the list says whose settings these are', () => {
    render(<SettingsSectionList />)
    const list = screen.getByTestId('settings-section-list')
    expect(within(list).getByText('Mathias Sonnleitner')).toBeInTheDocument()
    expect(within(list).getByText('m@example.com')).toBeInTheDocument()
  })

  it('every row points at its own section and is 52px tall', () => {
    isSuperAdmin = true
    render(<SettingsSectionList />)
    const rows = screen.getAllByTestId('settings-section-row')
    expect(rows.map((r) => r.getAttribute('href'))).toContain('/settings/admin')
    for (const r of rows) {
      expect(r.className).toMatch(/h-\[52px\]/)
    }
  })
})

describe('tapping a row opens the section, and "‹ Settings" comes back', () => {
  it('the layout shows a back link to /settings on every section page', () => {
    pathname = '/settings/profile'
    isSuperAdmin = true
    render(<SettingsLayout>{null}</SettingsLayout>)

    const header = screen.getByTestId('settings-back-header')
    const back = within(header).getByRole('link', { name: /Settings/ })
    expect(back).toHaveAttribute('href', '/settings')
    // A real link, not a `router.back()` — a section reached from a deep
    // link or a reload has no history to go back to.
    expect(back.tagName).toBe('A')
    // And it names the section it is sitting above.
    expect(header).toHaveTextContent('Profile')
  })

  it('names the Admin area when the open route is a tab of it', () => {
    pathname = '/settings/admin'
    isSuperAdmin = true
    render(<SettingsLayout>{null}</SettingsLayout>)
    expect(screen.getByTestId('settings-back-header')).toHaveTextContent('Admin')
  })

  it('shows no back header on the list itself — it would point at itself', () => {
    pathname = '/settings'
    render(<SettingsLayout>{null}</SettingsLayout>)
    expect(screen.queryByTestId('settings-back-header')).toBeNull()
  })

  it('hides the desktop sidebar below md, and keeps it above', () => {
    pathname = '/settings/profile'
    render(<SettingsLayout>{null}</SettingsLayout>)
    const aside = screen.getByTestId('settings-sidebar')
    expect(aside.className).toMatch(/\bhidden\b/)
    expect(aside.className).toMatch(/\bmd:block\b/)
    // And the back header is the mirror image: phones only.
    expect(screen.getByTestId('settings-back-header').className).toMatch(/\bmd:hidden\b/)
  })
})

describe('/settings itself', () => {
  it('renders the list and redirects nowhere when the viewport is narrow', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    render(<SettingsIndexPage />)
    expect(screen.getByTestId('settings-section-list')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it('redirects to the first section the user may SEE at md and above', () => {
    // The bug this covers: it used to be a server redirect to
    // /settings/admin, which is superadmin-only — a plain member's
    // "Settings" link landed on a page that bounced them to `/`.
    isSuperAdmin = false
    hasProjectPrivilege = false
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    render(<SettingsIndexPage />)
    expect(replace).toHaveBeenCalledWith('/settings/profile')
    // `replace`, not `push`: Back out of Profile leaves Settings rather
    // than bouncing through the signpost again.
    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('keeps the list out of a desktop paint entirely', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
    const { container } = render(<SettingsIndexPage />)
    // The list is rendered but `md:hidden`, so a desktop never shows a
    // frame of it before the redirect takes effect.
    expect(container.firstElementChild?.className).toMatch(/\bmd:hidden\b/)
  })
})
