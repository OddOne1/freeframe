/**
 * §229 B — the Admin area is one page with five URL-driven tabs.
 *
 * What is asserted here is the contract, not the look:
 *
 *   - URL ↔ tab, in both directions, and `replace` rather than `push`;
 *   - an unknown `?tab=` falls back to Users rather than to nothing;
 *   - only the OPEN tab's data is fetched — the Email tab does not pull
 *     down every account on the instance on its way to an SMTP host;
 *   - the gate is one gate, in front of every tab, and a non-superadmin
 *     reaches none of them by guessing a query string.
 *
 * The real page, the real tab strip and the real tab components; only the
 * network and the router are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

let isSuperAdmin = true
let tabParam: string | null = null
const replace = vi.fn()
const get = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    upload: vi.fn().mockResolvedValue({}),
  },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { id: 'u-me', name: 'Mathias', email: 'm@example.com' },
    isSuperAdmin,
  }),
}))
vi.mock('@/stores/theme-store', () => ({
  useThemeStore: () => ({ resolvedTheme: 'dark' }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(tabParam ? `tab=${tabParam}` : ''),
}))

import AdminPage from '../page'
import { resolveAdminTab, ADMIN_TABS } from '@/components/settings/admin/admin-tabs'

const USERS = [
  {
    id: 'u-me', name: 'Mathias', email: 'm@example.com', role: 'superadmin',
    status: 'active', created_at: '2025-01-01T00:00:00Z', avatar_url: null,
    storage_limit_bytes: null, projects: [], deleted_at: null,
    must_set_password: false, backup_email_state: 'verified',
  },
  {
    id: 'u-2', name: 'Rosa Lindgren', email: 'rosa@example.com', role: 'user',
    status: 'active', created_at: '2025-02-02T00:00:00Z', avatar_url: null,
    storage_limit_bytes: null, projects: [], deleted_at: null,
    must_set_password: false, backup_email_state: 'verified',
  },
]

beforeEach(() => {
  isSuperAdmin = true
  tabParam = null
  replace.mockClear()
  get.mockReset()
  get.mockImplementation((path: string) => {
    if (path === '/admin/users') return Promise.resolve(USERS)
    if (path === '/email-settings') {
      return Promise.resolve({
        mail_provider: 'smtp', effective_provider: 'smtp',
        mail_from_address: 'a@b.c', mail_from_name: 'FreeFrame',
        effective_from_address: 'a@b.c', smtp_host: 'smtp.example.com',
        smtp_port: 587, smtp_user: 'u', smtp_security: 'starttls',
        effective_smtp_security: 'starttls', smtp_password_set: true,
        using_env_fallback: false,
      })
    }
    if (path === '/site-settings') {
      return Promise.resolve({
        org_name: 'FreeFrame', logo_dark_url: null, logo_light_url: null,
        logo_login_url: null, favicon_url: null, theme_colors: null,
        total_storage_limit_bytes: null, total_storage_used_bytes: 0,
        timezone: 'UTC', require_2fa: false,
      })
    }
    return Promise.resolve([])
  })
})

function renderAdmin() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AdminPage />
    </SWRConfig>,
  )
}

const fetched = () => get.mock.calls.map((c) => c[0])

// ─── The resolver, on its own ───────────────────────────────────────────

describe('?tab= resolves to a tab', () => {
  it('maps every defined value to itself', () => {
    for (const t of ADMIN_TABS) {
      expect(resolveAdminTab(t.value)).toBe(t.value)
    }
  })

  it('falls back to users for absent, empty and unknown values', () => {
    expect(resolveAdminTab(null)).toBe('users')
    expect(resolveAdminTab(undefined)).toBe('users')
    expect(resolveAdminTab('')).toBe('users')
    expect(resolveAdminTab('smtp')).toBe('users')
    expect(resolveAdminTab('Branding')).toBe('users') // case-sensitive
  })

  it('offers exactly the five the owner asked for, in order', () => {
    expect(ADMIN_TABS.map((t) => t.value)).toEqual([
      'users', 'platform', 'security', 'email', 'branding',
    ])
  })
})

// ─── URL ↔ tab ──────────────────────────────────────────────────────────

describe('the URL decides the tab', () => {
  it('opens Users with no parameter at all', async () => {
    renderAdmin()
    expect(await screen.findByTestId('admin-tab-users')).toHaveAttribute(
      'data-state', 'active',
    )
  })

  it('deep-links straight into Branding', async () => {
    tabParam = 'branding'
    renderAdmin()
    expect(await screen.findByTestId('admin-tab-branding')).toHaveAttribute(
      'data-state', 'active',
    )
    expect(screen.getByTestId('admin-tab-users')).toHaveAttribute(
      'data-state', 'inactive',
    )
    // The Branding controls themselves, not just a highlighted pill.
    expect(screen.getByText('Workspace name')).toBeInTheDocument()
  })

  it('an unknown value shows Users rather than an empty page', async () => {
    tabParam = 'does-not-exist'
    renderAdmin()
    expect(await screen.findByTestId('admin-tab-users')).toHaveAttribute(
      'data-state', 'active',
    )
  })

  it('changing tab REPLACES the URL, so Back does not walk the strip', async () => {
    renderAdmin()
    await userEvent.click(await screen.findByTestId('admin-tab-email'))
    expect(replace).toHaveBeenCalledWith('/settings/admin?tab=email', {
      scroll: false,
    })
  })

  it('the strip is a real tablist, for the arrow keys', async () => {
    renderAdmin()
    const list = await screen.findByRole('tablist')
    expect(within(list).getAllByRole('tab')).toHaveLength(5)
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    // Radix activates as it moves, and each activation is a replace.
    await waitFor(() => expect(replace).toHaveBeenCalled())
  })
})

// ─── One tab, one tab's data ────────────────────────────────────────────

describe('each tab loads only its own data', () => {
  it('Users fetches the user list', async () => {
    renderAdmin()
    await screen.findByText('Rosa Lindgren')
    expect(fetched()).toContain('/admin/users')
  })

  it('Email does NOT fetch the user list', async () => {
    tabParam = 'email'
    renderAdmin()
    await waitFor(() => expect(fetched()).toContain('/email-settings'))
    expect(fetched()).not.toContain('/admin/users')
  })

  it('Platform fetches neither the users nor the mail settings', async () => {
    tabParam = 'platform'
    renderAdmin()
    await screen.findByText('Platform Storage')
    expect(fetched()).not.toContain('/admin/users')
    expect(fetched()).not.toContain('/email-settings')
  })

  it('Branding fetches neither either', async () => {
    tabParam = 'branding'
    renderAdmin()
    await screen.findByText('Workspace name')
    expect(fetched()).not.toContain('/admin/users')
    expect(fetched()).not.toContain('/email-settings')
  })
})

// ─── One gate, in front of all five ─────────────────────────────────────

describe('the superadmin gate', () => {
  for (const t of ['users', 'platform', 'security', 'email', 'branding']) {
    it(`a non-superadmin reaches nothing at ?tab=${t}`, async () => {
      isSuperAdmin = false
      tabParam = t
      const { container } = renderAdmin()
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
      expect(container.querySelector('[role="tablist"]')).toBeNull()
      expect(container.textContent).toBe('')
      // And nothing superadmin-only was asked for on the way out.
      expect(fetched()).not.toContain('/admin/users')
      expect(fetched()).not.toContain('/email-settings')
    })
  }
})
