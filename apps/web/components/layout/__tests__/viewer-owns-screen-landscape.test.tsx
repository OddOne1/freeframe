/**
 * The viewer takes the whole screen on a phone lying on its side
 * (§228c item 6).
 *
 * At 844x390 the shell is above `md`, so it renders the 52px sidebar rail
 * and indents `main` by it: 52px of the width, next to a two-column viewer
 * that needs all of it. The rail and that margin are the only things that
 * go, they go only on this route, and they go only in this mode — the
 * project and settings screens in landscape are §230's problem, and this
 * test pins that boundary so a later change cannot quietly widen it.
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

  it('keeps the rail on every OTHER route, landscape or not (§230)', () => {
    pathname = '/projects/p-1'
    setCompactLandscape(true)
    renderShell()
    expect(screen.getByTestId('app-sidebar')).toBeTruthy()
    expect(main().className).toContain('md:ml-[52px]')
  })

  it('and on settings in landscape, which is also §230', () => {
    pathname = '/settings/profile'
    setCompactLandscape(true)
    renderShell()
    expect(screen.getByTestId('app-sidebar')).toBeTruthy()
  })

  it('still renders the page itself — only the chrome went', () => {
    setCompactLandscape(true)
    renderShell()
    expect(screen.getByText('page content')).toBeTruthy()
  })
})
