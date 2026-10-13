/**
 * The app shell at narrow widths (§224).
 *
 * Two things the shell owed the rest of this change:
 *
 *   - the global nav was a `fixed` 52px rail with `main` permanently
 *     indented by it, which on a 390px screen spends 13% of the width on
 *     one column of icons;
 *   - `rightPanelOpen` is persisted and defaults to true, so a desktop
 *     session carried "open" onto a phone, where the same flag now opens an
 *     overlay — you would arrive at a project with the content covered.
 *
 * The media-query rule is tested through a stubbed `matchMedia`, which is
 * what the code reads; jsdom applies no media queries, so that is the only
 * honest way to exercise it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({
  usePathname: () => '/projects/p-1',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const fetchUser = vi.fn()
const fetchHistory = vi.fn()
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    fetchUser,
    user: { id: 'u1', name: 'Tester', email: 't@e.com', first_name: 'T', last_name: 'E' },
  }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: () => ({
    fetchHistory,
    files: [],
    togglePanel: vi.fn(),
    panelOpen: false,
  }),
}))
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({ unreadCount: 0, fetchNotifications: vi.fn(), notifications: [] }),
}))
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({ orgName: 'FreeFrame', logoDarkUrl: null, logoLightUrl: null, themeColors: null }),
}))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('./notification-drawer', () => ({ NotificationDrawer: () => null }))
vi.mock('@/components/layout/notification-drawer', () => ({ NotificationDrawer: () => null }))

import { DashboardShell } from '../dashboard-shell'
import { useViewStore } from '@/stores/view-store'
import { useRightPanelStore } from '@/stores/right-panel-store'

/** jsdom has no media queries, so this is what the code actually reads. */
function setViewportXl(isXl: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: isXl && q.includes('1280'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  )
}

function renderShell() {
  return render(
    <DashboardShell>
      <div>page content</div>
    </DashboardShell>,
  )
}

const sidebar = () => screen.getByTestId('app-sidebar')
const main = () => document.querySelector('main') as HTMLElement

beforeEach(() => {
  vi.clearAllMocks()
  setViewportXl(true)
  useViewStore.setState({ rightPanelOpen: true })
  // §232 — no page has registered a panel until one says so.
  useRightPanelStore.setState({ available: false })
})

// ─── The off-canvas nav ─────────────────────────────────────────────────

describe('§224 — the nav is off-canvas below md', () => {
  it('starts translated off screen below md, in place at md+', () => {
    renderShell()
    const cls = sidebar().className
    expect(cls).toMatch(/max-md:-translate-x-full/)
    // At md+ it is exactly where it was.
    expect(cls).toMatch(/md:translate-x-0/)
    expect(cls).toMatch(/md:w-\[52px\]/)
  })

  it('main has no left margin below md, and the old one at md+', () => {
    renderShell()
    const cls = main().className
    expect(cls).toMatch(/\bml-0\b/)
    // The rail's width, now behind a breakpoint rather than unconditional.
    expect(cls).toMatch(/md:ml-\[52px\]/)
  })

  it('a menu button opens it, and the scrim appears with it', async () => {
    const user = userEvent.setup()
    renderShell()
    expect(screen.queryByTestId('mobile-nav-scrim')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Open navigation' }))

    await waitFor(() => expect(sidebar().className).toMatch(/max-md:translate-x-0/))
    expect(screen.getByTestId('mobile-nav-scrim')).toBeInTheDocument()
  })

  it('the menu button is phones-only and thumb-sized', () => {
    renderShell()
    const btn = screen.getByRole('button', { name: 'Open navigation' })
    expect(btn.className).toMatch(/md:hidden/)
    expect(btn.className).toMatch(/h-11 w-11/)
  })

  it('the scrim closes it', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await waitFor(() => expect(screen.getByTestId('mobile-nav-scrim')).toBeInTheDocument())

    await user.click(screen.getByTestId('mobile-nav-scrim'))
    await waitFor(() => expect(screen.queryByTestId('mobile-nav-scrim')).toBeNull())
    expect(sidebar().className).toMatch(/max-md:-translate-x-full/)
  })

  it('Escape closes it', async () => {
    const user = userEvent.setup()
    renderShell()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await waitFor(() => expect(screen.getByTestId('mobile-nav-scrim')).toBeInTheDocument())

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('mobile-nav-scrim')).toBeNull())
  })

  it('shows its labels while open, even though the rail is collapsed', async () => {
    const user = userEvent.setup()
    renderShell()
    // Collapsed is the default, so a rail would show icons only — useless
    // in a 244px drawer. Scoped to the sidebar's own <nav>, because the
    // header's breadcrumb also says "Projects" and, since §224b, so does
    // the Settings section list in the drawer's user block.
    const navItems = () => within(sidebar().querySelector('nav') as HTMLElement)
    expect(navItems().queryByText('Projects')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await waitFor(() => expect(navItems().getByText('Projects')).toBeInTheDocument())
    // …and Notifications and Uploads, which are icon-only in the rail.
    expect(navItems().getByText('Notifications')).toBeInTheDocument()
  })

  it('hides the collapse toggle below md — there is no rail to collapse to', () => {
    renderShell()
    expect(screen.getByTestId('sidebar-collapse-toggle').className).toMatch(/max-md:hidden/)
  })

  it('sizes itself with dvh, not vh', () => {
    renderShell()
    // 100vh on iOS Safari is the height WITHOUT the toolbars, so a vh
    // shell runs under the browser chrome and takes the tab bar with it.
    expect(sidebar().className).toMatch(/h-dvh/)
    expect((main().parentElement as HTMLElement).className).toMatch(/h-dvh/)
  })
})

describe('§232 item 2 — the panel toggle only exists where a panel does', () => {
  /**
   * The condition was `pathname !== '/projects'`, which assumed every
   * other page had a panel. §232 removes the project/folder view's, so
   * the toggle now asks `right-panel-store` — set by the page that
   * renders a panel, for as long as it renders one.
   *
   * This shell test mounts no page, so nothing has registered a panel:
   * the absent case is the default, which is the right default. A dead
   * toggle is what §224 was reported for.
   */
  it('is absent when nothing has registered a panel', () => {
    renderShell()
    expect(screen.queryByRole('button', { name: /show panel|hide panel/i })).toBeNull()
  })

  it('appears as soon as a page registers one', async () => {
    renderShell()
    useRightPanelStore.getState().setAvailable(true)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /show panel|hide panel/i })).toBeInTheDocument(),
    )
  })

  it('is md-and-up only: below that the panel is not rendered at any width', async () => {
    renderShell()
    useRightPanelStore.getState().setAvailable(true)
    const toggle = await screen.findByRole('button', { name: /show panel|hide panel/i })
    expect(toggle.className).toMatch(/hidden md:flex/)
  })

  it('is thumb-sized where there is no pointer', async () => {
    renderShell()
    useRightPanelStore.getState().setAvailable(true)
    const toggle = await screen.findByRole('button', { name: /show panel|hide panel/i })
    expect(toggle.className).toMatch(/hover-none:h-11/)
    expect(toggle.className).toMatch(/hover-none:w-11/)
  })

  it('says what it is, not just what it looks like', async () => {
    renderShell()
    useRightPanelStore.getState().setAvailable(true)
    const toggle = await screen.findByRole('button', { name: /show panel|hide panel/i })
    expect(toggle).toHaveAttribute('aria-pressed')
  })

  it('still toggles the persisted flag it always did', async () => {
    const user = userEvent.setup()
    renderShell()
    useRightPanelStore.getState().setAvailable(true)
    const toggle = await screen.findByRole('button', { name: /show panel|hide panel/i })
    const before = useViewStore.getState().rightPanelOpen
    await user.click(toggle)
    expect(useViewStore.getState().rightPanelOpen).toBe(!before)
  })
})

// ─── The persisted-panel rule ──────────────────────────────────────────

describe('§224 — the right panel starts closed below xl', () => {
  it('closes a persisted-open panel on a narrow viewport', async () => {
    setViewportXl(false)
    useViewStore.setState({ rightPanelOpen: true })
    renderShell()
    await waitFor(() => expect(useViewStore.getState().rightPanelOpen).toBe(false))
  })

  it('leaves it alone at xl and up', async () => {
    setViewportXl(true)
    useViewStore.setState({ rightPanelOpen: true })
    renderShell()
    // Give the effect a chance to run and then confirm it did nothing.
    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(useViewStore.getState().rightPanelOpen).toBe(true)
  })

  it('does not re-close it when the user opens it themselves', async () => {
    setViewportXl(false)
    renderShell()
    await waitFor(() => expect(useViewStore.getState().rightPanelOpen).toBe(false))

    // The rule is per page load, not a subscription: opening the drawer on
    // a phone must stick.
    useViewStore.getState().setRightPanelOpen(true)
    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(useViewStore.getState().rightPanelOpen).toBe(true)
  })

  it('leaves the persisted preference intact for the next desktop visit', async () => {
    setViewportXl(false)
    renderShell()
    await waitFor(() => expect(useViewStore.getState().rightPanelOpen).toBe(false))
    // It closed the panel; it did not clear or reset anything else.
    expect(useViewStore.getState().cardSize).toBe('M')
  })

  it('does nothing at all when matchMedia is unavailable', async () => {
    // A server render, or a test environment that has not stubbed it: the
    // helper answers "wide" so the rule is a no-op rather than a surprise.
    vi.stubGlobal('matchMedia', undefined)
    useViewStore.setState({ rightPanelOpen: true })
    renderShell()
    await waitFor(() => expect(fetchUser).toHaveBeenCalled())
    expect(useViewStore.getState().rightPanelOpen).toBe(true)
  })
})
