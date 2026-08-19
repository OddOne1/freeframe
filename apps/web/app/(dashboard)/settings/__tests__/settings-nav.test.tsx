/**
 * Settings nav grouping and the sidebar avatar (CLAUDE.md §46).
 *
 * The interesting rule is the divider: every group it separates is
 * conditionally visible, so a separator placed by index would leave a stray
 * line whenever the item beside it is hidden. That is what these assert,
 * rather than the order alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

let isSuperAdmin = false
let hasProjectPrivilege = false

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { name: 'Tester', email: 't@example.com' }, isSuperAdmin }),
}))
vi.mock('@/hooks/use-project-privilege', () => ({
  useHasProjectPrivilege: () => hasProjectPrivilege,
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/settings/profile' }))

import SettingsLayout from '../layout'

beforeEach(() => {
  isSuperAdmin = false
  hasProjectPrivilege = false
})

function renderNav() {
  return render(<SettingsLayout>{null}</SettingsLayout>)
}

/** Nav links in render order. */
function order() {
  return screen
    .getAllByRole('link')
    .map((a) => a.textContent?.trim())
}

function groups() {
  return screen.getAllByTestId('settings-nav-group')
}

/** A divider is the top border on every group after the first. */
function dividerCount() {
  return groups().filter((g) => g.className.includes('border-t')).length
}

describe('settings nav order', () => {
  it('puts LUTs in the first group and Contact last, for a superadmin', () => {
    isSuperAdmin = true
    hasProjectPrivilege = true
    renderNav()

    expect(order()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Projects',
      'Admin',
      'Branding',
      'Contact',
    ])
    // Three dividers: after LUTs, after Projects, after Branding.
    expect(dividerCount()).toBe(3)
  })
})

describe('dividers follow visibility', () => {
  it('draws no stray line where a hidden Projects group would have been', () => {
    isSuperAdmin = false
    hasProjectPrivilege = false
    renderNav()

    expect(order()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Contact',
    ])
    // Only the Contact group is left below the first, so exactly one line.
    expect(groups()).toHaveLength(2)
    expect(dividerCount()).toBe(1)
  })

  it('keeps the Projects divider for a non-admin who has project privilege', () => {
    isSuperAdmin = false
    hasProjectPrivilege = true
    renderNav()

    expect(order()).toEqual([
      'Profile',
      'Appearance',
      'Notifications',
      'LUTs',
      'Projects',
      'Contact',
    ])
    // Admin/Branding is empty for them and collapses away entirely rather
    // than leaving two adjacent lines.
    expect(groups()).toHaveLength(3)
    expect(dividerCount()).toBe(2)
  })

  it('hides Admin and Branding together from a non-superadmin', () => {
    isSuperAdmin = false
    hasProjectPrivilege = true
    renderNav()
    expect(order()).not.toContain('Admin')
    expect(order()).not.toContain('Branding')
  })
})
