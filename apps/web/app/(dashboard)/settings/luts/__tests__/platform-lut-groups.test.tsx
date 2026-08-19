/**
 * Platform LUT groups in Settings → LUTs (CLAUDE.md §39).
 *
 * The shared-ness is a backend property and is tested there against real
 * Postgres. What is asserted here is the half that only exists in the UI:
 * which endpoint each control talks to, and that a superadmin is never
 * offered a drag or a button whose request the server would refuse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutThumbnail: () => Promise.resolve('data:image/png;base64,small'),
  getCachedLutThumbnail: () => 'data:image/png;base64,small',
  renderLutPreview: () => Promise.resolve('data:image/jpeg;base64,large'),
  getCachedLutPreview: () => null,
}))

const get = vi.fn()
const patch = vi.fn()
const post = vi.fn()
const del = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: (path: string, body: unknown) => patch(path, body),
    post: (path: string, body: unknown) => post(path, body),
    delete: (path: string) => del(path),
    upload: vi.fn(),
  },
}))

let superAdmin = true
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ isSuperAdmin: superAdmin }),
}))

import LutsSettingsPage from '../page'

const PLATFORM_GROUP = { id: 'pg1', name: 'House Looks', is_platform: true }
const PERSONAL_GROUP = { id: 'g1', name: 'My Shots', is_platform: false }

const base = {
  file_url: '/luts/one.cube',
  lut_size: 33,
  is_owner: true,
  created_at: '2026-08-18T00:00:00Z',
}
const MINE = { ...base, id: 'lut-1', name: 'Kodak 2383', group_id: null, is_platform_wide: false }
const PROMOTED = {
  ...base,
  id: 'lut-2',
  name: 'Rec709 Show',
  group_id: null,
  is_platform_wide: true,
}
const THEIRS = {
  ...base,
  id: 'lut-3',
  name: 'Someone Elses',
  group_id: 'pg1',
  is_platform_wide: true,
  is_owner: false,
  owner_name: 'Other Admin',
}

beforeEach(() => {
  superAdmin = true
  window.localStorage.clear()
  ;[get, patch, post, del].forEach((m) => m.mockReset())
  patch.mockResolvedValue({})
  post.mockResolvedValue({})
  del.mockResolvedValue(undefined)
  get.mockImplementation((path: string) => {
    if (path === '/me/luts') return Promise.resolve([MINE, PROMOTED])
    if (path === '/luts/platform') return Promise.resolve([PROMOTED, THEIRS])
    if (path === '/me/lut-groups') return Promise.resolve([PERSONAL_GROUP])
    if (path === '/luts/platform-groups') return Promise.resolve([PLATFORM_GROUP])
    return Promise.resolve([])
  })
})

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LutsSettingsPage />
    </SWRConfig>,
  )
}

async function sectionFor(heading: string): Promise<HTMLElement> {
  const el = await screen.findByRole('heading', { name: new RegExp(`^${heading}`), level: 2 })
  return el.closest('section') as HTMLElement
}

async function rowFor(name: string): Promise<HTMLElement> {
  const h = await screen.findByRole('heading', { name, level: 3 })
  return h.closest('div[draggable]') as HTMLElement
}

function dataTransfer() {
  const store = new Map<string, string>()
  return {
    setData: (t: string, v: string) => void store.set(t, v),
    getData: (t: string) => store.get(t) ?? '',
    get types() {
      return Array.from(store.keys())
    },
    dropEffect: '',
    effectAllowed: '',
  }
}

describe('platform groups are fetched and shown', () => {
  it('lists them from the shared endpoint, not the personal one', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /^House Looks/, level: 2 })
    expect(get).toHaveBeenCalledWith('/luts/platform-groups')
    // Its member renders under it, from /luts/platform.
    const group = (await sectionFor('House Looks')) as HTMLElement
    expect(within(group).getByRole('heading', { name: 'Someone Elses', level: 3 })).toBeInTheDocument()
  })

  it('shows the same groups to a non-superadmin, without controls', async () => {
    superAdmin = false
    renderPage()
    const group = await sectionFor('House Looks')

    expect(within(group).getByRole('heading', { name: 'Someone Elses', level: 3 })).toBeInTheDocument()
    // Read-only: no rename, no delete, no create.
    expect(screen.queryByLabelText('Rename group House Looks')).not.toBeInTheDocument()
    expect(screen.queryByText('New platform group')).not.toBeInTheDocument()
  })
})

describe('managing platform groups', () => {
  it('creates one through the platform endpoint', async () => {
    renderPage()
    await userEvent.click(await screen.findByText('New platform group'))
    await userEvent.type(screen.getByLabelText('New platform group name'), 'Delivery')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/luts/platform-groups', {
        name: 'Delivery',
        // Top-level, not a sub-group (§45).
        parent_group_id: null,
      }),
    )
  })

  it('creates a personal group through the personal endpoint', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /New group/ }))
    await userEvent.type(screen.getByLabelText('New group name'), 'Mine')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Mine',
        parent_group_id: null,
      }),
    )
  })

  it('renames one through the platform endpoint', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('Rename group House Looks'))
    const input = screen.getByLabelText('Rename House Looks')
    await userEvent.clear(input)
    await userEvent.type(input, 'Brand Looks{Enter}')

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/luts/platform-groups/pg1', { name: 'Brand Looks' }),
    )
  })

  it('deletes one through the platform endpoint', async () => {
    renderPage()
    const group = await sectionFor('House Looks')
    await userEvent.click(within(group).getByRole('button', { name: 'Delete group' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Delete group' }))

    await waitFor(() => expect(del).toHaveBeenCalledWith('/luts/platform-groups/pg1'))
  })
})

describe('filing LUTs into platform groups', () => {
  it('promotes and files in one PATCH when a personal LUT is dragged up', async () => {
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Kodak 2383'), { dataTransfer: dt })
    fireEvent.drop(await sectionFor('House Looks'), { dataTransfer: dt })

    // Either field alone would be rejected by the server's pairing rule;
    // together they describe a valid end state.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-1', {
        group_id: 'pg1',
        is_platform_wide: true,
      }),
    )
  })

  it('moves an already-platform LUT without re-promoting it', async () => {
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Rec709 Show'), { dataTransfer: dt })
    fireEvent.drop(await sectionFor('House Looks'), { dataTransfer: dt })

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-2', { group_id: 'pg1' }),
    )
  })

  it('offers the ⋯ menu platform groups for a platform LUT, personal for a personal one', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('More actions for Rec709 Show'))
    let menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Move to platform group')).toBeInTheDocument()
    expect(within(menu).getByText('House Looks')).toBeInTheDocument()
    expect(within(menu).queryByText('My Shots')).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')

    await userEvent.click(screen.getByLabelText('More actions for Kodak 2383'))
    menu = await screen.findByRole('menu')
    expect(within(menu).getByText('Move to group')).toBeInTheDocument()
    expect(within(menu).getByText('My Shots')).toBeInTheDocument()
    expect(within(menu).queryByText('House Looks')).not.toBeInTheDocument()
  })

  it('does not offer a drag on a platform LUT the viewer does not own', async () => {
    renderPage()
    // PATCH /me/luts is owner-scoped server-side, so this drag would 404.
    const row = await rowFor('Someone Elses')
    expect(row).toHaveAttribute('draggable', 'false')
    expect(screen.queryByLabelText('More actions for Someone Elses')).not.toBeInTheDocument()
  })

  it('takes a platform LUT back out of a platform group, into platform Ungrouped', async () => {
    const filed = { ...PROMOTED, group_id: 'pg1' }
    get.mockImplementation((path: string) => {
      if (path === '/me/luts') return Promise.resolve([MINE, filed])
      if (path === '/luts/platform') return Promise.resolve([filed, THEIRS])
      if (path === '/me/lut-groups') return Promise.resolve([PERSONAL_GROUP])
      if (path === '/luts/platform-groups') return Promise.resolve([PLATFORM_GROUP])
      return Promise.resolve([])
    })
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Rec709 Show'), { dataTransfer: dt })

    // There are two "Ungrouped" sections once both libraries have groups;
    // the platform one is the one inside the Platform section.
    const platform = await sectionFor('Platform LUTs')
    const ungrouped = within(platform)
      .getByRole('heading', { name: /^Ungrouped/, level: 2 })
      .closest('section') as HTMLElement
    fireEvent.drop(ungrouped, { dataTransfer: dt })

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-2', { group_id: null }),
    )
  })

  it('gives a non-superadmin no drop target on the platform side', async () => {
    superAdmin = false
    renderPage()
    const group = await sectionFor('House Looks')
    const dt = dataTransfer()
    dt.setData('application/x-freeframe-lut', 'lut-1')

    fireEvent.dragOver(group, { dataTransfer: dt })
    expect(group).not.toHaveAttribute('data-drop-active')
    fireEvent.drop(group, { dataTransfer: dt })
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()
  })
})
