/**
 * The viewer takes the whole screen on a phone lying on its side
 * (§228c item 6).
 *
 * At 844x390 the shell is above `md`, so it renders the 52px sidebar rail
 * and indents `main` by it: 52px of the width, next to a two-column viewer
 * that needs all of it.
 *
 * §230 — the boundary this used to pin has moved, deliberately and in one
 * direction: EVERY route now gives up the rail's 52px gutter in compact
 * landscape. What is still viewer-only is the rail being gone OUTRIGHT.
 * Everywhere else it becomes the §227 off-canvas drawer, because every
 * other route draws the app header, and the header's `≡` is what opens
 * it; the viewer draws no header, so there would be nothing to open a
 * drawer with and the rail has to go rather than hide.
 *
 * jsdom applies no media queries, so `matchMedia` is stubbed: it is what
 * the hook actually reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

let pathname = '/projects/p-1/assets/a-1'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    fetchUser: vi.fn(),
    user: { id: 'u1', name: 'Tester', email: 't@e.com', first_name: 'T', last_name: 'E' },
  }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: () => ({
    fetchHistory: vi.fn(), files: [], togglePanel: vi.fn(), panelOpen: false,
  }),
}))
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({
    unreadCount: 0, fetchNotifications: vi.fn(), notifications: [],
  }),
}))
vi.mock('@/hooks/use-site-settings', () => ({
  useSiteSettings: () => ({
    orgName: 'FreeFrame', logoDarkUrl: null, logoLightUrl: null, themeColors: null,
  }),
}))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('./notification-drawer', () => ({ NotificationDrawer: () => null }))
vi.mock('@/components/layout/notification-drawer', () => ({ NotificationDrawer: () => null }))

import { DashboardShell } from '../dashboard-shell'

/** `(max-height: 500px)` is the compact-landscape query's own half. */
function setCompactLandscape(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('max-height: 500px') ? on : false,
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

const main = () => document.querySelector('main') as HTMLElement

/**
 * Exact class membership, not `toContain`.
 *
 * `max-md:w-[244px]` CONTAINS the string `md:w-[244px]`, so a substring
 * assertion about the `md:` variant passes on the `max-md:` one and reads
 * as green while measuring nothing. Splitting on whitespace is what makes
 * "has this class" mean it.
 */
function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean)
}

beforeEach(() => {
  pathname = '/projects/p-1/assets/a-1'
})

describe('§228c item 6 — the app chrome in compact landscape', () => {
  it('drops the sidebar rail on the viewer route', () => {
    setCompactLandscape(true)
    renderShell()
    expect(screen.queryByTestId('app-sidebar')).toBeNull()
  })

  it('and drops the margin that reserved its width', () => {
    setCompactLandscape(true)
    renderShell()
    expect(main().className).toContain('md:ml-0')
    expect(main().className).not.toContain('md:ml-[52px]')
  })

  it('keeps the rail on the viewer route when it is NOT compact landscape', () => {
    setCompactLandscape(false)
    renderShell()
    expect(screen.getByTestId('app-sidebar')).toBeTruthy()
    expect(main().className).toContain('md:ml-[52px]')
  })

  it('keeps the rail MOUNTED on every other route — as the drawer (§230)', () => {
    pathname = '/projects/p-1'
    setCompactLandscape(true)
    renderShell()
    const rail = screen.getByTestId('app-sidebar')
    // The §227 drawer, at 844px wide: 244px, off-canvas, over the page.
    expect(classes(rail)).toContain('md:w-[244px]')
    expect(classes(rail)).toContain('md:-translate-x-full')
    expect(classes(rail)).toContain('md:z-50')
  })

  it('and the gutter it reserved goes with it on those routes (§230)', () => {
    pathname = '/projects/p-1'
    setCompactLandscape(true)
    renderShell()
    expect(main().className).toContain('md:ml-0')
    expect(main().className).not.toContain('md:ml-[52px]')
  })

  it('and on settings in landscape, which is the same decision (§230)', () => {
    pathname = '/settings/profile'
    setCompactLandscape(true)
    renderShell()
    expect(classes(screen.getByTestId('app-sidebar'))).toContain('md:w-[244px]')
    expect(main().className).toContain('md:ml-0')
  })

  it('leaves the rail a RAIL on those routes when it is not compact landscape', () => {
    pathname = '/projects/p-1'
    setCompactLandscape(false)
    renderShell()
    const rail = screen.getByTestId('app-sidebar')
    expect(classes(rail)).toContain('md:w-[52px]')
    expect(classes(rail)).not.toContain('md:w-[244px]')
    expect(classes(rail)).toContain('md:translate-x-0')
    expect(main().className).toContain('md:ml-[52px]')
  })

  it('still renders the page itself — only the chrome went', () => {
    setCompactLandscape(true)
    renderShell()
    expect(screen.getByText('page content')).toBeTruthy()
  })
})
