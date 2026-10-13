/**
 * The navigation drawer's bottom block, on a screen with no rail (§227).
 *
 * §224b filled it with the whole settings list — Profile, Appearance,
 * Notifications, LUTs, Projects, Admin, Branding, Contact, plus a storage
 * row. That came from the advisor's specification ("whatever the desktop
 * avatar menu offers, including admin entries"), and it was the wrong
 * thing to ask for: the drawer exists so the USER is reachable on a phone,
 * where §224 hid the avatar behind the bottom tab bar. A navigation drawer
 * that lists eight settings sections is a second Settings page.
 *
 * What the block is for now, and what these tests pin:
 *
 *   a) the user row — avatar, name, email — is in the drawer and is ONE
 *      link to Settings;
 *   b) Log out is there, and calls the store the Profile page's button
 *      calls;
 *   c) NO settings section is listed in the drawer, for a superadmin
 *      either — that is the regression this section is;
 *   d) both a superadmin and a plain member reach the Settings page, and
 *      the Admin entry is reachable FROM THERE for the superadmin only.
 *      §229 turns that landing into a list on phones; until then the
 *      existing settings layout is what presents the sections, so (d)
 *      renders the real layout rather than asserting on a promise.
 *
 * The drawer assertions render the real `Sidebar` with `mobileOpen`,
 * because the user row belongs to the sidebar's shared avatar link and the
 * question "is it in the drawer" cannot be answered by the block alone.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
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
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ orgName: 'FreeFrame', logoDarkUrl: null, logoLightUrl: null }),
}))
// The sidebar fetches notifications on mount; without this the real store
// reaches for localhost:8000.
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({ unreadCount: 0, fetchNotifications: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({
  api: { get: async () => projects },
  ApiError: class extends Error {},
}))

import { SidebarUserBlock } from '../sidebar-user-block'
import { Sidebar } from '../sidebar'
import SettingsLayout from '@/app/(dashboard)/settings/layout'

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
  projects = [
    { id: 'p1', name: 'Podcast', role: 'owner', storage_limit_bytes: 50 * GB, storage_bytes: 12 * GB },
  ]
})

/** The drawer, open, as a phone has it. */
function renderDrawer() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Sidebar collapsed onToggle={() => {}} mobileOpen onMobileClose={() => {}} />
    </SWRConfig>,
  )
}

const drawer = () => screen.getByTestId('app-sidebar')
const block = () => screen.getByTestId('sidebar-user-block')

/** Every settings section that exists, by the label the nav gives it.
 *  §229 — Branding is no longer one of them; it is a tab of Admin. */
const ALL_SECTIONS = [
  'Profile',
  'Appearance',
  'Notifications',
  'LUTs',
  'Projects',
  'Admin',
  'Contact',
]

// ─── (a) the user row ───────────────────────────────────────────────────

describe('§227 (a) — the user row is in the drawer and reaches Settings', () => {
  it('shows the avatar, the name and the email as ONE link', () => {
    renderDrawer()
    const row = within(drawer()).getByRole('link', { name: /Mathias/ })
    expect(row).toHaveAttribute('href', '/settings/profile')
    expect(row).toHaveTextContent('Mathias')
    expect(row).toHaveTextContent('m@e.com')
    // One link, not a row of them: the whole point of §227 item 2.
    expect(within(row).queryAllByRole('link')).toHaveLength(0)
  })

  it('is the sidebar’s own avatar row, not a second copy for the drawer', () => {
    renderDrawer()
    // Two user rows in one drawer is what a duplicated block would give.
    expect(within(drawer()).getAllByRole('link', { name: /Mathias/ })).toHaveLength(1)
    const SRC = fs.readFileSync(
      path.join(process.cwd(), 'components/layout/sidebar-user-block.tsx'), 'utf8')
    expect(SRC).not.toMatch(/Avatar/)
  })
})

// ─── (b) Log out ────────────────────────────────────────────────────────

describe('§227 (b) — Log out', () => {
  it('is in the drawer', () => {
    renderDrawer()
    expect(within(block()).getByRole('button', { name: /log out/i })).toBeInTheDocument()
  })

  it('calls the store, the same one the Profile page’s button calls', async () => {
    const user = userEvent.setup()
    render(<SidebarUserBlock />)
    await user.click(within(block()).getByRole('button', { name: /log out/i }))
    expect(logout).toHaveBeenCalledTimes(1)
  })
})

// ─── (c) no settings menu ───────────────────────────────────────────────

describe('§227 (c) — the drawer is not a settings menu', () => {
  it('lists no settings section at all, for a SUPERADMIN', () => {
    renderDrawer()
    // Profile included: the user row above leads there, and a "Profile"
    // row beside it was the §224b list's first entry.
    for (const label of ALL_SECTIONS) {
      expect(within(block()).queryByRole('link', { name: label })).toBeNull()
    }
    // Nothing anywhere in the drawer's bottom block except the user row,
    // the desktop-only collapse toggle, and Log out.
    expect(within(block()).queryAllByRole('link')).toHaveLength(0)
  })

  it('and none for a plain member either', () => {
    authState = MEMBER
    projects = [{ id: 'p1', name: 'Podcast', role: 'viewer' }]
    renderDrawer()
    for (const label of ALL_SECTIONS) {
      expect(within(block()).queryByRole('link', { name: label })).toBeNull()
    }
  })

  it('has no storage row', () => {
    renderDrawer()
    expect(screen.queryByTestId('drawer-storage')).toBeNull()
    expect(screen.queryAllByTestId('drawer-settings-group')).toHaveLength(0)
  })

  it('does not read the settings list or the storage summary at all', () => {
    // The structural half: a drawer that merely renders none of them today
    // is one `groups.map` away from being a settings menu again.
    const SRC = fs.readFileSync(
      path.join(process.cwd(), 'components/layout/sidebar-user-block.tsx'), 'utf8')
    // On the IMPORTS, not the prose: the docstring names both hooks to
    // explain where they went, and a component cannot call what it has
    // not imported.
    expect(SRC).not.toMatch(/^import .*settings-nav/m)
    expect(SRC).not.toMatch(/^import .*use-storage-summary/m)
  })

  it('but the Settings sub-nav still reads the shared list — it was not deleted', () => {
    const LAYOUT = fs.readFileSync(
      path.join(process.cwd(), 'app/(dashboard)/settings/layout.tsx'), 'utf8')
    expect(LAYOUT).toMatch(/useVisibleSettingsNav.*from '@\/lib\/settings-nav'/)
  })
})

// ─── (d) what the Settings page then offers ─────────────────────────────

describe('§227 (d) — the sections live on the Settings page', () => {
  function renderSettings() {
    return render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <SettingsLayout>
          <div />
        </SettingsLayout>
      </SWRConfig>,
    )
  }

  it('a superadmin arriving there finds Admin', async () => {
    renderSettings()
    expect(await screen.findByRole('link', { name: 'Admin' })).toHaveAttribute(
      'href', '/settings/admin',
    )
    expect(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument()
  })

  it('a plain member arriving there does not, but still gets their own sections', async () => {
    authState = MEMBER
    projects = [{ id: 'p1', name: 'Podcast', role: 'viewer' }]
    renderSettings()
    expect(await screen.findByRole('link', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Admin' })).toBeNull()
  })

  it('and the drawer’s one link is the way in, for both', () => {
    renderDrawer()
    expect(within(drawer()).getByRole('link', { name: /Mathias/ })).toHaveAttribute(
      'href', '/settings/profile',
    )
    authState = MEMBER
    screen.getByTestId('app-sidebar') // the admin render, still mounted
    const second = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <Sidebar collapsed onToggle={() => {}} mobileOpen onMobileClose={() => {}} />
      </SWRConfig>,
    )
    expect(
      within(second.container.querySelector('[data-testid="app-sidebar"]') as HTMLElement)
        .getByRole('link', { name: /Sam/ }),
    ).toHaveAttribute('href', '/settings/profile')
  })
})

// ─── What §224b got right and §227 keeps ────────────────────────────────

describe('§227 — the §224b fixes that stay', () => {
  it('the whole block is md:hidden', () => {
    render(<SidebarUserBlock />)
    expect(block().className).toMatch(/\bmd:hidden\b/)
  })

  it('and it is only mounted while the drawer is open', () => {
    const SIDEBAR = fs.readFileSync(
      path.join(process.cwd(), 'components/layout/sidebar.tsx'), 'utf8')
    expect(SIDEBAR).toMatch(/\{mobileOpen && <SidebarUserBlock/)
  })

  it('pads past the home indicator, which no other element does for it', () => {
    render(<SidebarUserBlock />)
    expect(block().innerHTML).toContain('env(safe-area-inset-bottom)')
  })
})

describe('§228 — the drawer still out-ranks every pane it covers', () => {
  /**
   * The z-index of the one `fixed` root element in a component.
   *
   * §224b pinned this against `components/projects/mobile-tab-bar.tsx`,
   * which §228 DELETED: §227 had already taken it out of the project view,
   * and §228's asset viewer is one screen with a Comments/Fields switch
   * under the player rather than a bottom tab bar, so nothing was left to
   * mount it. What survives is the relationship the §224b bug was actually
   * about — the nav drawer and its scrim paint above the page beneath them
   * — read out of both files and compared, because a test pinning `z-50`
   * would still pass if someone raised the thing underneath.
   */
  function fixedZ(file: string, marker: RegExp): number {
    const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    const line = src.split('\n').find((l) => marker.test(l))
    if (!line) throw new Error(`no line matching ${marker} in ${file}`)
    const m = line.match(/z-\[?(\d+)\]?/)
    if (!m) throw new Error(`no z-index on: ${line.trim()}`)
    return Number(m[1])
  }

  const drawerZ = () =>
    fixedZ('components/layout/sidebar.tsx', /'fixed left-0 top-0 z-/)
  const scrimZ = () =>
    fixedZ('components/layout/sidebar.tsx', /fixed inset-0 z-.*bg-black/)
  /** The asset viewer's comments drawer — the widest fixed pane the nav
   *  drawer has to cover now that the tab bar is gone (§228). */
  const viewerPanelZ = () =>
    fixedZ(
      'app/(dashboard)/projects/[id]/assets/[assetId]/page.tsx',
      /fixed inset-y-0 right-0 z-/,
    )

  it('paints above its own scrim', () => {
    expect(drawerZ()).toBeGreaterThan(scrimZ())
  })

  it('and both paint above the asset viewer comments drawer', () => {
    expect(scrimZ()).toBeGreaterThan(viewerPanelZ())
    expect(drawerZ()).toBeGreaterThan(viewerPanelZ())
  })

  it('and the tab bar it used to be measured against is gone', () => {
    expect(
      fs.existsSync(path.join(process.cwd(), 'components/projects/mobile-tab-bar.tsx')),
    ).toBe(false)
  })
})
