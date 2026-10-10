/**
 * Everything behind the avatar, on a screen with no rail (§224b).
 *
 * The §224 screenshot showed the phone navigation drawer offering
 * Projects / Notifications / Uploads and nothing else: no profile, no
 * admin entry, no storage, no way to sign out. Two separate causes, and
 * the tests below cover both.
 *
 *   - What the drawer DOES show was being painted over. The sidebar and
 *     the project view's bottom tab bar are both `fixed` at z-40, and the
 *     tab bar comes later in the DOM, so it won. That is asserted by
 *     reading both numbers out of both components and comparing them,
 *     not by matching a class string — the bug is the RELATIONSHIP, and a
 *     test that pins `z-50` would still pass if someone raised the tab
 *     bar to z-60 tomorrow.
 *   - What it shows at all. The section list and its permission gate come
 *     from the same hook the Settings sub-nav reads, so this file renders
 *     the real component through the real hook rather than asserting on a
 *     list it keeps its own copy of.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fs from 'node:fs'
import path from 'node:path'

const logout = vi.fn()
let authState: Record<string, unknown> = {}
let projects: unknown[] = []

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects/p-1',
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ logout, ...authState }),
}))
vi.mock('swr', async () => {
  const actual = await vi.importActual<typeof import('swr')>('swr')
  return { ...actual, default: () => ({ data: projects, isLoading: false }) }
})

import { SidebarUserBlock } from '../sidebar-user-block'

// Decimal, because that is the app's default byte-unit mode — these
// numbers are here to be read back out of the rendered string.
const GB = 1_000_000_000

const ADMIN = {
  user: { id: 'u1', name: 'Mathias', email: 'm@e.com', storage_limit_bytes: 100 * GB },
  isSuperAdmin: true,
}
const MEMBER = {
  user: { id: 'u2', name: 'Sam', email: 's@e.com', storage_limit_bytes: null },
  isSuperAdmin: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  authState = ADMIN
  projects = [{ id: 'p1', name: 'Podcast', role: 'owner', storage_limit_bytes: 50 * GB, storage_bytes: 12 * GB }]
})

const block = () => screen.getByTestId('sidebar-user-block')

describe('an admin sees the admin entries', () => {
  it('offers Admin and Branding', () => {
    render(<SidebarUserBlock />)
    expect(within(block()).getByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href', '/settings/admin',
    )
    expect(within(block()).getByRole('link', { name: 'Branding' })).toBeInTheDocument()
  })

  it('and the ungated ones everybody gets', () => {
    render(<SidebarUserBlock />)
    for (const label of ['Profile', 'Appearance', 'Notifications', 'LUTs', 'Contact']) {
      expect(within(block()).getByRole('link', { name: label })).toBeInTheDocument()
    }
  })
})

describe('a plain member sees neither', () => {
  beforeEach(() => {
    authState = MEMBER
    // Owns nothing and manages nothing: no project privilege either.
    projects = [{ id: 'p1', name: 'Podcast', role: 'viewer', storage_limit_bytes: null, storage_bytes: 0 }]
  })

  it('has no Admin or Branding entry', () => {
    render(<SidebarUserBlock />)
    expect(within(block()).queryByRole('link', { name: 'Admin' })).toBeNull()
    expect(within(block()).queryByRole('link', { name: 'Branding' })).toBeNull()
  })

  it('has no Projects entry either, which is privilege-gated, not admin-gated', () => {
    render(<SidebarUserBlock />)
    expect(within(block()).queryByRole('link', { name: 'Projects' })).toBeNull()
  })

  it('still reaches their own profile and can sign out', () => {
    render(<SidebarUserBlock />)
    expect(within(block()).getByRole('link', { name: 'Profile' })).toBeInTheDocument()
    expect(within(block()).getByRole('button', { name: /log out/i })).toBeInTheDocument()
  })
})

describe('the gate is the Settings page’s own', () => {
  it('reads the shared list rather than keeping a copy', () => {
    const SRC = fs.readFileSync(
      path.join(process.cwd(), 'components/layout/sidebar-user-block.tsx'), 'utf8')
    const LAYOUT = fs.readFileSync(
      path.join(process.cwd(), 'app/(dashboard)/settings/layout.tsx'), 'utf8')
    // Both surfaces import the same hook. If one ever grows its own
    // isSuperAdmin check, they can start disagreeing about who is an
    // admin — which is the failure this is here to prevent.
    expect(SRC).toMatch(/useVisibleSettingsNav.*from '@\/lib\/settings-nav'/)
    expect(LAYOUT).toMatch(/useVisibleSettingsNav.*from '@\/lib\/settings-nav'/)
    expect(SRC).not.toMatch(/isSuperAdmin/)
  })
})

describe('sign out', () => {
  it('calls the store, the same one the Profile page’s button calls', async () => {
    const user = userEvent.setup()
    render(<SidebarUserBlock />)
    await user.click(within(block()).getByRole('button', { name: /log out/i }))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})

describe('storage', () => {
  it('quotes the Projects settings page’s numbers', () => {
    render(<SidebarUserBlock />)
    // 12 GB held by the owned project, against the 100 GB personal
    // total — the same pair the Projects settings page prints.
    expect(within(block()).getByTestId('drawer-storage').textContent).toMatch(
      /12 GB used of 100 GB total/,
    )
  })

  it('says nothing at all when the user owns no project', () => {
    authState = MEMBER
    projects = [{ id: 'p1', role: 'viewer', storage_limit_bytes: null, storage_bytes: 0 }]
    render(<SidebarUserBlock />)
    // A figure of "0 B used of an unlimited total" is noise, not
    // information, for someone with nothing allocated.
    expect(within(block()).queryByTestId('drawer-storage')).toBeNull()
  })
})

describe('nothing of this reaches the desktop rail', () => {
  it('the whole block is md:hidden', () => {
    render(<SidebarUserBlock />)
    expect(block().className).toMatch(/\bmd:hidden\b/)
  })

  it('and it is only mounted while the drawer is open', () => {
    const SIDEBAR = fs.readFileSync(
      path.join(process.cwd(), 'components/layout/sidebar.tsx'), 'utf8')
    expect(SIDEBAR).toMatch(/\{mobileOpen && <SidebarUserBlock/)
  })
})

describe('the tab bar no longer covers it', () => {
  /** The z-index of the one `fixed` root element in a component. */
  function fixedZ(file: string, marker: RegExp): number {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    const line = src.split('\n').find((l) => marker.test(l))
    if (!line) throw new Error(`no line matching ${marker} in ${file}`)
    const m = line.match(/z-\[?(\d+)\]?/)
    if (!m) throw new Error(`no z-index on: ${line.trim()}`)
    return Number(m[1])
  }

  const tabBarZ = () =>
    fixedZ('components/projects/mobile-tab-bar.tsx', /fixed inset-x-0 bottom-0/)
  const drawerZ = () =>
    fixedZ('components/layout/sidebar.tsx', /'fixed left-0 top-0 z-/)
  const scrimZ = () =>
    fixedZ('components/layout/sidebar.tsx', /fixed inset-0 z-.*bg-black/)

  it('the drawer paints above it', () => {
    // Equal values are not good enough: both are `fixed`, and at a tie
    // the later element in the DOM wins — which is the tab bar, and which
    // is exactly how the user block came to be hidden.
    expect(drawerZ()).toBeGreaterThan(tabBarZ())
  })

  it('and so does the scrim, so the tab bar reads as inert rather than live', () => {
    expect(scrimZ()).toBeGreaterThan(tabBarZ())
    expect(drawerZ()).toBeGreaterThan(scrimZ())
  })
})
