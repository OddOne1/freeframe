/**
 * The sidebar's logo is right on the FIRST paint (§178).
 *
 * The bug: the sidebar reads branding through `useSiteSettings()`, a plain
 * `useSWR('/site-settings')`. With nothing seeded, the first client render
 * has no data and paints the bundled FreeFrame icon, which swaps to the
 * real logo once the fetch resolves — a flash of someone else's brand on
 * every page load, for every configured org.
 *
 * What makes this test worth anything is that the client fetch NEVER
 * resolves here. `api.get` returns a promise that is left pending, so
 * anything asserted below is what the very first render produced. A test
 * that awaited the steady state would pass just as happily against the
 * broken code.
 *
 * It also runs the real chain rather than a stand-in for it: the real
 * (dashboard)/layout.tsx server component, the real provider it renders,
 * the real hook, the real Sidebar. The individual pieces were never the
 * problem — the wiring between them was missing entirely.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const CUSTOM_LOGO = '/stream/hls/acme-logo.png?token=t'

const fetchSiteSettingsServer = vi.fn()
vi.mock('@/lib/site-settings-server', () => ({
  fetchSiteSettingsServer: () => fetchSiteSettingsServer(),
  toPublicMediaUrl: (u: string | null) => (u ? '/api' + u : null),
}))

// Never resolves: whatever renders below cannot have come from the client.
const get = vi.fn((_path: string) => new Promise<never>(() => {}))
vi.mock('@/lib/api', () => ({
  api: { get: (p: string) => get(p), patch: vi.fn(), post: vi.fn(), upload: vi.fn(), delete: vi.fn() },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { name: 'Tester', email: 't@example.com', avatar_url: null },
    fetchUser: vi.fn(),
    logout: vi.fn(),
  }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: () => ({ files: [], togglePanel: vi.fn(), panelOpen: false, fetchHistory: vi.fn() }),
}))
vi.mock('@/stores/notification-store', () => ({
  useNotificationStore: () => ({ unreadCount: 0, fetchNotifications: vi.fn() }),
}))
vi.mock('@/stores/theme-store', () => ({ useThemeStore: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('next/navigation', () => ({ usePathname: () => '/projects' }))

// The rest of the dashboard chrome is not what this is about, and each
// piece drags in its own network calls.
vi.mock('@/components/layout/header', () => ({ Header: () => null }))
vi.mock('@/components/layout/command-palette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/layout/uploads-panel', () => ({ UploadsPanel: () => null }))
vi.mock('@/components/layout/upload-sse-bridge', () => ({ UploadSSEBridge: () => null }))

import DashboardLayout from '../layout'

const FRESH_INSTALL = {
  org_name: 'FreeFrame',
  logo_dark_url: null,
  logo_light_url: null,
  logo_login_url: null,
  favicon_url: null,
  theme_colors: null,
}

const CONFIGURED = { ...FRESH_INSTALL, org_name: 'Acme Studio', logo_dark_url: CUSTOM_LOGO }

/** Render the layout exactly as Next does: await the server component, then
 *  render what it returned. */
async function renderLayout() {
  return render(await DashboardLayout({ children: null }))
}

const logoSrcs = () =>
  Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '')

beforeEach(() => {
  get.mockClear()
  fetchSiteSettingsServer.mockReset()
})

describe('a configured org', () => {
  it('shows its own logo on the first render, before any client fetch', async () => {
    fetchSiteSettingsServer.mockResolvedValue(CONFIGURED)

    await renderLayout()

    expect(logoSrcs().some((s) => s.includes('acme-logo.png'))).toBe(true)
    // The point of the bug: not for a moment.
    expect(logoSrcs()).not.toContain('/logo-icon.png')
    expect(logoSrcs()).not.toContain('/logo-icon-dark.png')
  })

  it('shows its own name on the first render too', async () => {
    fetchSiteSettingsServer.mockResolvedValue(CONFIGURED)

    await renderLayout()

    expect(screen.getAllByAltText('Acme Studio').length).toBeGreaterThan(0)
  })

  it('fetches the branding server-side, not only in the browser', async () => {
    fetchSiteSettingsServer.mockResolvedValue(CONFIGURED)

    await renderLayout()

    expect(fetchSiteSettingsServer).toHaveBeenCalledTimes(1)
  })
})

describe('a fresh install', () => {
  it('still shows the bundled FreeFrame default', async () => {
    /* The half that is easy to break while fixing the other half: an
       instance nobody has branded has no logo to preserve, and must still
       get the default. */
    fetchSiteSettingsServer.mockResolvedValue(FRESH_INSTALL)

    await renderLayout()

    expect(logoSrcs()).toContain('/logo-icon.png')
    expect(logoSrcs()).toContain('/logo-icon-dark.png')
  })

  it('falls back to the default when the backend is unreachable at render', async () => {
    /* The helper returns null rather than throwing, and seeding nothing has
       to leave the old client-fetch behaviour exactly as it was. */
    fetchSiteSettingsServer.mockResolvedValue(null)

    await renderLayout()

    expect(logoSrcs()).toContain('/logo-icon.png')
  })
})
