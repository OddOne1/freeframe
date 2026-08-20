/**
 * Bulk group moves and Platform promote/demote (CLAUDE.md §56).
 *
 * All of these loop the existing single-item PATCH, like §54's delete. What
 * is worth pinning is the reasoning around scope: a group belongs to one
 * side and a LUT cannot cross, so a mixed selection has no correct list of
 * targets — and the Platform actions deliberately act on a subset, where
 * "skipped" must not read as "failed" or as "done".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutThumbnail: () => Promise.resolve('d'),
  getCachedLutThumbnail: () => 'd',
  renderLutPreview: () => Promise.resolve('d'),
  getCachedLutPreview: () => null,
}))

const get = vi.fn()
const patch = vi.fn()
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b: unknown) => post(p, b),
    patch: (p: string, b: unknown) => patch(p, b),
    delete: vi.fn(() => Promise.resolve()),
    upload: vi.fn(),
  },
}))

let superAdmin = true
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: superAdmin }) }))

import LutsSettingsPage from '../page'

const PRIVATE_GROUP = { id: 'g1', name: 'Cameras', is_platform: false, parent_group_id: null }
const PLATFORM_GROUP = { id: 'pg1', name: 'House', is_platform: true, parent_group_id: null }

const base = { file_url: '/x.cube', lut_size: 33, created_at: '2026-01-01T00:00:00Z', is_owner: true }
const MINE_A = { ...base, id: 'l1', name: 'Kodak', group_id: null, is_platform_wide: false }
const MINE_B = { ...base, id: 'l2', name: 'Fuji', group_id: 'g1', is_platform_wide: false }
const PLAT = { ...base, id: 'l3', name: 'House Look', group_id: null, is_platform_wide: true }

beforeEach(() => {
  superAdmin = true
  window.localStorage.clear()
  ;[get, patch, post].forEach((m) => m.mockReset())
  patch.mockResolvedValue({})
  post.mockResolvedValue({ id: 'new-group' })
  get.mockImplementation((p: string) => {
    if (p === '/me/luts') return Promise.resolve([MINE_A, MINE_B, PLAT])
    if (p === '/luts/platform') return Promise.resolve([PLAT])
    if (p === '/me/lut-groups') return Promise.resolve([PRIVATE_GROUP])
    if (p === '/luts/platform-groups') return Promise.resolve([PLATFORM_GROUP])
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

async function select(name: string) {
  const boxes = await screen.findAllByLabelText(`Select ${name}`)
  await userEvent.click(boxes[0]!)
}

async function openMoveMenu() {
  await userEvent.click(screen.getByRole('button', { name: /Move to group/ }))
  return screen.findByRole('menu')
}

function patched() {
  return Object.fromEntries(patch.mock.calls.map((c) => [c[0], c[1]]))
}

describe('move to group', () => {
  it('offers private groups for a private selection', async () => {
    renderPage()
    await select('Kodak')
    const menu = await openMoveMenu()

    expect(within(menu).getByText('Cameras')).toBeInTheDocument()
    // The platform group is not a valid home for a private LUT.
    expect(within(menu).queryByText('House')).not.toBeInTheDocument()

    await userEvent.click(within(menu).getByText('Cameras'))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/me/luts/l1', { group_id: 'g1' }))
  })

  it('offers platform groups for a platform selection', async () => {
    renderPage()
    await select('House Look')
    const menu = await openMoveMenu()

    expect(within(menu).getByText('House')).toBeInTheDocument()
    expect(within(menu).queryByText('Cameras')).not.toBeInTheDocument()
  })

  it('explains itself instead of guessing on a mixed selection', async () => {
    renderPage()
    await select('Kodak')
    await select('House Look')

    expect(screen.queryByRole('button', { name: /Move to group/ })).not.toBeInTheDocument()
    expect(
      screen.getByText(/Select only private or only Platform LUTs to move as a group/),
    ).toBeInTheDocument()
  })

  it('creates a group and files the selection into it in one go', async () => {
    renderPage()
    await select('Kodak')
    const menu = await openMoveMenu()
    await userEvent.click(within(menu).getByText('New group…'))

    await userEvent.type(await screen.findByLabelText('New group name'), 'Fresh{Enter}')
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Fresh',
        parent_group_id: null,
      }),
    )
    // Creating it is only half of what was asked for.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/l1', { group_id: 'new-group' }),
    )
  })

  it('scopes "New group…" to the side the selection is on', async () => {
    renderPage()
    await select('House Look')
    const menu = await openMoveMenu()
    await userEvent.click(within(menu).getByText('New group…'))

    await userEvent.type(await screen.findByLabelText('New platform group name'), 'Shared{Enter}')
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/luts/platform-groups', {
        name: 'Shared',
        parent_group_id: null,
      }),
    )
  })
})

describe('remove from group', () => {
  it('clears the group on every selected LUT', async () => {
    renderPage()
    await select('Kodak')
    await select('Fuji')
    await userEvent.click(screen.getByRole('button', { name: 'Remove from group' }))

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(patched()['/me/luts/l1']).toEqual({ group_id: null })
    expect(patched()['/me/luts/l2']).toEqual({ group_id: null })
  })
})

describe('platform promote and demote', () => {
  it('promotes only the ones that are not already platform-wide', async () => {
    renderPage()
    await select('Kodak')
    await select('House Look')

    await userEvent.click(screen.getByRole('button', { name: /Move to Platform/ }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    // The already-platform one is skipped, not failed.
    expect(patch).toHaveBeenCalledWith('/me/luts/l1', {
      is_platform_wide: true,
      group_id: null,
    })
  })

  it('demotes only the ones that are platform-wide', async () => {
    renderPage()
    await select('Kodak')
    await select('House Look')

    await userEvent.click(screen.getByRole('button', { name: /Move to Private/ }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch).toHaveBeenCalledWith('/me/luts/l3', {
      is_platform_wide: false,
      group_id: null,
    })
  })

  it('leaves the skipped ones selected, since they were never attempted', async () => {
    renderPage()
    await select('Kodak')
    await select('House Look')
    expect(await screen.findByText('2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Move to Platform/ }))
    // Kodak succeeded and clears; House Look was skipped and stays — saying
    // it was handled would be a lie.
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
    // 'updated', not 'deleted': one report line served every action before
    // §56, so a move announced itself as a delete.
    expect(screen.getByText('1 of 1 updated')).toBeInTheDocument()
  })

  it('hides each button when it would have nothing to do', async () => {
    renderPage()
    await select('Kodak')
    expect(screen.getByRole('button', { name: /Move to Platform/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Move to Private/ })).not.toBeInTheDocument()
  })

  it('shows neither to a non-superadmin', async () => {
    superAdmin = false
    renderPage()
    await select('Kodak')

    expect(screen.queryByRole('button', { name: /Move to Platform/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Move to Private/ })).not.toBeInTheDocument()
    // The rest of the toolbar still works for them.
    expect(screen.getByRole('button', { name: 'Remove from group' })).toBeInTheDocument()
  })
})

describe('partial failure', () => {
  it('keeps the failed one selected and names it', async () => {
    renderPage()
    await select('Kodak')
    await select('Fuji')

    // The target group was deleted in another tab.
    patch.mockImplementation((path: string) =>
      path === '/me/luts/l1'
        ? Promise.reject({ detail: 'Group not found' })
        : Promise.resolve({}),
    )
    const menu = await openMoveMenu()
    await userEvent.click(within(menu).getByText('Cameras'))

    expect(await screen.findByText('1 of 2 updated')).toBeInTheDocument()
    expect(screen.getByText(/Kodak: Group not found/)).toBeInTheDocument()
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })
})
