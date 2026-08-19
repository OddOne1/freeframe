/**
 * LUT multi-select and bulk delete (CLAUDE.md §54).
 *
 * No batch endpoint: this loops the existing single-item DELETE, which is
 * the convention both other multi-select UIs in this app follow. The rules
 * worth pinning are the ones a bulk action gets wrong — that a row the
 * viewer may not delete is not selectable at all, and that a partial failure
 * neither discards the successes nor claims to have deleted everything.
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
const del = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    delete: (p: string) => del(p),
    upload: vi.fn(),
  },
}))

let superAdmin = true
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: superAdmin }) }))

import LutsSettingsPage from '../page'

const base = { file_url: '/x.cube', lut_size: 33, created_at: '2026-01-01T00:00:00Z' }
const MINE_A = { ...base, id: 'l1', name: 'Kodak', group_id: null, is_platform_wide: false, is_owner: true }
const MINE_B = { ...base, id: 'l2', name: 'Fuji', group_id: null, is_platform_wide: false, is_owner: true }
const MY_PLATFORM = { ...base, id: 'l3', name: 'House Look', group_id: null, is_platform_wide: true, is_owner: true }
const THEIR_PLATFORM = {
  ...base, id: 'l4', name: 'Someone Elses', group_id: null,
  is_platform_wide: true, is_owner: false, owner_name: 'Other Admin',
}

beforeEach(() => {
  superAdmin = true
  window.localStorage.clear()
  ;[get, del].forEach((m) => m.mockReset())
  del.mockResolvedValue(undefined)
  get.mockImplementation((p: string) => {
    if (p === '/me/luts') return Promise.resolve([MINE_A, MINE_B, MY_PLATFORM])
    if (p === '/luts/platform') return Promise.resolve([MY_PLATFORM, THEIR_PLATFORM])
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

const pick = (name: string) => screen.findByLabelText(`Select ${name}`)

async function confirmDelete() {
  await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
}

describe('what is selectable', () => {
  it('offers no checkbox on a platform LUT the viewer does not own', async () => {
    renderPage()
    await pick('Kodak')
    // Same gate that already hides its ⋯ menu — a row with no delete must
    // not become deletable through the toolbar.
    expect(screen.queryByLabelText('Select Someone Elses')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('More actions for Someone Elses')).not.toBeInTheDocument()
  })

  it('offers no checkboxes at all to a non-superadmin on platform rows', async () => {
    superAdmin = false
    renderPage()
    await pick('Kodak')
    expect(screen.queryByLabelText('Select Someone Elses')).not.toBeInTheDocument()
  })
})

describe('the toolbar', () => {
  it('appears only once something is selected, and counts it', async () => {
    renderPage()
    await pick('Kodak')
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument()

    await userEvent.click(await pick('Kodak'))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    await userEvent.click(await pick('Fuji'))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('clears the selection without deleting anything', async () => {
    renderPage()
    await userEvent.click(await pick('Kodak'))
    await userEvent.click(screen.getByRole('button', { name: 'Clear selection' }))

    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
    expect(del).not.toHaveBeenCalled()
  })
})

describe('deleting', () => {
  it('spans Platform and Private in one action, through the single-item endpoint', async () => {
    renderPage()
    await userEvent.click(await pick('Kodak'))
    await userEvent.click(await pick('Fuji'))
    // The platform row appears in both sections; the first is the platform one.
    await userEvent.click((await screen.findAllByLabelText('Select House Look'))[0]!)

    expect(await screen.findByText('3 selected')).toBeInTheDocument()
    await confirmDelete()

    await waitFor(() => expect(del).toHaveBeenCalledTimes(3))
    // One endpoint, one per id — no batch route was invented.
    expect(del.mock.calls.map((c) => c[0]).sort()).toEqual([
      '/me/luts/l1',
      '/me/luts/l2',
      '/me/luts/l3',
    ])
    await waitFor(() => expect(screen.queryByText(/selected$/)).not.toBeInTheDocument())
  })

  it('counts rather than names when several are selected', async () => {
    renderPage()
    await userEvent.click(await pick('Kodak'))
    await userEvent.click(await pick('Fuji'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Delete 2 LUTs')
    expect(dialog).not.toHaveTextContent('Kodak')
  })

  it('names the one LUT when only one is selected', async () => {
    renderPage()
    await userEvent.click(await pick('Kodak'))
    await userEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(await screen.findByRole('dialog')).toHaveTextContent('Kodak')
  })

  it('keeps only the failures selected, and says which failed', async () => {
    renderPage()
    await userEvent.click(await pick('Kodak'))
    await userEvent.click(await pick('Fuji'))

    // Kodak was already deleted in another tab.
    del.mockImplementation((path: string) =>
      path === '/me/luts/l1'
        ? Promise.reject({ detail: 'LUT not found' })
        : Promise.resolve(undefined),
    )
    await confirmDelete()

    // The success is not discarded, and the whole action does not report
    // success either.
    expect(await screen.findByText('1 of 2 deleted')).toBeInTheDocument()
    expect(screen.getByText(/Kodak: LUT not found/)).toBeInTheDocument()
    // Retry-friendly: the one that failed stays selected, the one that
    // worked does not.
    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })
})
