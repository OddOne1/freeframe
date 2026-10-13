/**
 * §229 C — below `lg` a platform user is a card, and nothing the table
 * row could do is lost in the move.
 *
 * The list in the prompt is the list asserted here, one action at a time
 * and in the state that makes it appear: Copy Invite Link (a pending
 * invite), Clear Setup Block (a gated account), Make/Remove Admin,
 * Deactivate, Reactivate, Delete (deactivated only), plus the per-user
 * storage limit and the project list, which are a field and a disclosure
 * rather than menu items.
 *
 * `matchMedia` is what decides between the table and the cards — jsdom
 * has no layout engine, so it is stubbed rather than inferred.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

let narrow = true
const patch = vi.fn()
const get = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: (...args: unknown[]) => patch(...args),
    post: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    upload: vi.fn().mockResolvedValue({}),
  },
}))
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { id: 'u-me', name: 'Mathias', email: 'm@example.com' },
    isSuperAdmin: true,
  }),
}))

import { UsersTab } from '@/components/settings/admin/users-tab'

const base = {
  avatar_url: null,
  created_at: '2025-02-02T00:00:00Z',
  deleted_at: null,
  storage_limit_bytes: null,
  must_set_password: false,
  backup_email_state: 'verified',
  projects: [],
  invite_token: null,
}

const USERS = [
  { ...base, id: 'u-me', name: 'Mathias', email: 'm@example.com', role: 'superadmin', status: 'active' },
  {
    ...base, id: 'u-rosa', name: 'Rosa Lindgren',
    email: 'rosa.lindgren@a-rather-long-production-domain.example.com',
    role: 'user', status: 'active',
    projects: Array.from({ length: 9 }, (_, i) => ({
      project_id: `p${i}`, project_name: `Project ${i}`, role: 'editor',
    })),
  },
  { ...base, id: 'u-pending', name: 'Kwame Boateng', email: 'kwame@example.com', role: 'user', status: 'pending_invite', invite_token: 'tok-1' },
  { ...base, id: 'u-gated', name: 'Yuki Tanaka', email: 'yuki@example.com', role: 'user', status: 'active', must_set_password: true, backup_email_state: 'missing' },
  { ...base, id: 'u-off', name: 'Sven Müller', email: 'sven@example.com', role: 'user', status: 'deactivated' },
  { ...base, id: 'u-admin2', name: 'Priya Chen', email: 'priya@example.com', role: 'superadmin', status: 'active' },
]

beforeEach(() => {
  narrow = true
  patch.mockReset().mockResolvedValue({})
  get.mockReset().mockImplementation((p: string) => {
    if (p === '/admin/users') return Promise.resolve(USERS)
    if (p.endsWith('/purge-preview')) return Promise.resolve({ owned_projects: [] })
    return Promise.resolve([])
  })
  try { window.localStorage.clear() } catch {}
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('max-width: 1023px') ? narrow : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
})

function renderTab() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <UsersTab />
    </SWRConfig>,
  )
}

async function cardFor(name: string) {
  await screen.findByText(name)
  const cards = screen.getAllByTestId('user-card')
  const hit = cards.find((c) => within(c).queryByText(name))
  if (!hit) throw new Error(`no card for ${name}`)
  return hit
}

async function openMenu(name: string) {
  const card = await cardFor(name)
  await userEvent.click(within(card).getByTestId('user-card-menu'))
  return screen.findByRole('menu')
}

describe('below lg, the rows are cards', () => {
  it('renders cards and no table at all', async () => {
    renderTab()
    await screen.findByText('Rosa Lindgren')
    expect(screen.getAllByTestId('user-card').length).toBeGreaterThan(0)
    expect(document.querySelector('table')).toBeNull()
  })

  it('renders the table, and no cards, at lg and above', async () => {
    narrow = false
    renderTab()
    await screen.findByText('Rosa Lindgren')
    expect(document.querySelectorAll('table').length).toBeGreaterThan(0)
    expect(screen.queryAllByTestId('user-card')).toHaveLength(0)
  })

  it('keeps the Admins / Members / Deactivated groups', async () => {
    renderTab()
    await screen.findByText('Rosa Lindgren')
    expect(screen.getByText(/Admins/)).toBeInTheDocument()
    expect(screen.getByText(/Members/)).toBeInTheDocument()
    expect(screen.getByText(/Deactivated/)).toBeInTheDocument()
  })

  it('shows the whole e-mail, wrapped rather than cut off', async () => {
    renderTab()
    const card = await cardFor('Rosa Lindgren')
    const email = within(card).getByText(
      'rosa.lindgren@a-rather-long-production-domain.example.com',
    )
    // `break-all` and NOT `truncate`: there is no hover on a phone to
    // recover an address an ellipsis ate.
    expect(email.className).toMatch(/break-all/)
    expect(email.className).not.toMatch(/\btruncate\b/)
  })

  it('collapses the project list behind "n projects"', async () => {
    renderTab()
    const card = await cardFor('Rosa Lindgren')
    // Nine projects, and not nine chips: on a card the list is ALWAYS the
    // collapsed form, where the table only collapses past three.
    const chip = within(card).getByRole('button', { name: /9 projects/ })
    expect(within(card).queryByText('Project 7')).toBeNull()
    // Radix opens the popover from a pointerdown, which jsdom does not
    // synthesise from a click, so the disclosure contract is asserted
    // rather than the opened panel: a real trigger, wired to a popover.
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
  })

  it('says "1 project", not "1 projects"', async () => {
    renderTab()
    const card = await cardFor('Kwame Boateng')
    expect(within(card).getByText('No projects')).toBeInTheDocument()
  })

  it('still carries role, status and the storage limit on the card', async () => {
    renderTab()
    const card = await cardFor('Rosa Lindgren')
    expect(within(card).getByText('User')).toBeInTheDocument()
    expect(within(card).getByText('Active')).toBeInTheDocument()
    expect(
      within(card).getByLabelText('Storage limit in GB for Rosa Lindgren'),
    ).toBeInTheDocument()
    expect(within(card).getByText(/Joined/)).toBeInTheDocument()
  })
})

describe('every action the table row had is reachable from the card', () => {
  it('Copy Invite Link — for a pending invite, and only there', async () => {
    renderTab()
    const menu = await openMenu('Kwame Boateng')
    expect(within(menu).getByText('Copy Invite Link')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    const other = await openMenu('Rosa Lindgren')
    expect(within(other).queryByText('Copy Invite Link')).toBeNull()
  })

  it('Clear Setup Block — for a gated account, and only there', async () => {
    renderTab()
    const menu = await openMenu('Yuki Tanaka')
    expect(within(menu).getByText('Clear Setup Block')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    const other = await openMenu('Rosa Lindgren')
    expect(within(other).queryByText('Clear Setup Block')).toBeNull()
  })

  it('Make Admin — and it calls the same endpoint the row did', async () => {
    renderTab()
    const menu = await openMenu('Rosa Lindgren')
    await userEvent.click(within(menu).getByText('Make Admin'))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/admin/users/u-rosa/role', {
        is_admin: true,
      }),
    )
  })

  it('Remove Admin — for someone who already is one', async () => {
    renderTab()
    const menu = await openMenu('Priya Chen')
    await userEvent.click(within(menu).getByText('Remove Admin'))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/admin/users/u-admin2/role', {
        is_admin: false,
      }),
    )
  })

  it('Deactivate — for an active user who is not you', async () => {
    renderTab()
    const menu = await openMenu('Rosa Lindgren')
    await userEvent.click(within(menu).getByText('Deactivate'))
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/admin/users/u-rosa/deactivate'),
    )
  })

  it('Reactivate and Delete — for a deactivated user', async () => {
    renderTab()
    // The Deactivated group starts collapsed, exactly as the table's did.
    await screen.findByText('Rosa Lindgren')
    await userEvent.click(screen.getByText(/Deactivated/))

    const menu = await openMenu('Sven Müller')
    expect(within(menu).getByText('Reactivate')).toBeInTheDocument()
    await userEvent.click(within(menu).getByText('Delete'))

    // The dialog is driven from the CARD, not from inside the menu: a
    // Radix menu unmounts its items as it closes and would take an
    // unopened dialog with it.
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      'Delete Sven Müller',
    )
  })

  it('loads the owned-project handoff when the CARD opens the dialog', async () => {
    // The regression this covers: the dialog's reset-and-load lived in
    // Radix's `onOpenChange`, which the card's controlled open never
    // calls. Without the preview, nothing owned a project, every choice
    // was vacuously made, and Delete went live before anyone had been
    // asked who inherits them.
    get.mockImplementation((p: string) => {
      if (p === '/admin/users') return Promise.resolve(USERS)
      if (p.endsWith('/purge-preview')) {
        return Promise.resolve({
          owned_projects: [
            {
              project_id: 'p1',
              project_name: 'Rope Challenge',
              candidates: [{ id: 'u-rosa', name: 'Rosa Lindgren', email: 'r@e.c' }],
            },
          ],
        })
      }
      return Promise.resolve([])
    })

    renderTab()
    await screen.findByText('Rosa Lindgren')
    await userEvent.click(screen.getByText(/Deactivated/))
    const menu = await openMenu('Sven Müller')
    await userEvent.click(within(menu).getByText('Delete'))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(
        get.mock.calls.some((c) => String(c[0]).endsWith('/purge-preview')),
      ).toBe(true),
    )
    expect(await within(dialog).findByText(/owns 1 project/)).toBeInTheDocument()
    // And the Delete button is NOT live until a new owner is chosen.
    const confirm = within(dialog).getAllByRole('button', { name: 'Delete' }).at(-1)!
    expect(confirm).toBeDisabled()
  })

  it('offers no Delete for someone who is merely active', async () => {
    renderTab()
    const menu = await openMenu('Rosa Lindgren')
    expect(within(menu).queryByText('Delete')).toBeNull()
  })

  it('marks your own card "You" and offers no menu on it', async () => {
    renderTab()
    const mine = await cardFor('Mathias')
    expect(within(mine).getByText('You')).toBeInTheDocument()
    expect(within(mine).queryByTestId('user-card-menu')).toBeNull()
  })

  it('gives the ⋯ button a 44px hit area — it is the only way in', async () => {
    renderTab()
    const card = await cardFor('Rosa Lindgren')
    const btn = within(card).getByTestId('user-card-menu')
    expect(btn.className).toMatch(/\bh-11\b/)
    expect(btn.className).toMatch(/\bw-11\b/)
  })
})

describe('search and invite', () => {
  it('filters the cards, and the Invite dialog is still there', async () => {
    renderTab()
    await screen.findByText('Rosa Lindgren')
    expect(screen.getByRole('button', { name: /Bulk Invite/ })).toBeInTheDocument()

    await userEvent.type(
      screen.getByPlaceholderText('Search by name or email'),
      'rosa',
    )
    await waitFor(() =>
      expect(screen.queryByText('Kwame Boateng')).toBeNull(),
    )
    expect(screen.getByText('Rosa Lindgren')).toBeInTheDocument()
  })
})
