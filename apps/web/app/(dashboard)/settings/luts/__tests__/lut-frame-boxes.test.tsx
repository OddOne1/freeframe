/**
 * The frame-box redesign, the count-badge fix, and the whole-group drag
 * (CLAUDE.md §41).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const post = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b: unknown) => post(p, b),
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}))

let superAdmin = true
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: superAdmin }) }))

import LutsSettingsPage from '../page'

const GROUP = { id: 'g1', name: 'Cameras', is_platform: false, parent_group_id: null }
const base = { file_url: '/x.cube', is_owner: true, created_at: '2026-01-01T00:00:00Z', lut_size: 33 }
const A = { ...base, id: 'l1', name: 'One', group_id: 'g1', is_platform_wide: false }
const B = { ...base, id: 'l2', name: 'Two', group_id: 'g1', is_platform_wide: false }

beforeEach(() => {
  superAdmin = true
  window.localStorage.clear()
  ;[get, post].forEach((m) => m.mockReset())
  post.mockResolvedValue({ promoted: 2, skipped: [] })
  get.mockImplementation((p: string) => {
    if (p === '/me/luts') return Promise.resolve([A, B])
    if (p === '/me/lut-groups') return Promise.resolve([GROUP])
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

async function frameBox(name: string): Promise<HTMLElement> {
  const h = await screen.findByRole('heading', { name: new RegExp(`^${name}`), level: 2 })
  return h.closest('section') as HTMLElement
}

describe('frame boxes', () => {
  it('titles the two sections Private and Platform', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: /^Private/, level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^Platform LUTs/, level: 2 })).toBeInTheDocument()
  })

  it('collapses each independently', async () => {
    renderPage()
    const heading = await screen.findByRole('heading', { name: /^Private/, level: 2 })
    await userEvent.click(within(heading).getByRole('button'))

    expect(screen.queryByRole('heading', { name: /^Cameras/, level: 2 })).not.toBeInTheDocument()
    // The Platform box is untouched.
    expect(screen.getByRole('heading', { name: /^Platform LUTs/, level: 2 })).toBeInTheDocument()
  })
})

describe('the count badge', () => {
  it('says how many groups are folded up, so a total does not read as loss', async () => {
    renderPage()
    // Both LUTs live in Cameras; the frame box counts 2 either way.
    const heading = await screen.findByRole('heading', { name: /^Cameras/, level: 2 })
    expect(screen.getByRole('heading', { name: /^Private \(2\)/, level: 2 })).toBeInTheDocument()
    expect(screen.queryByText(/collapsed/)).not.toBeInTheDocument()

    await userEvent.click(within(heading).getByRole('button'))

    // Zero rows visible, badge still 2 — which is what looked like loss.
    expect(screen.queryByRole('heading', { name: 'One', level: 3 })).not.toBeInTheDocument()
    expect(await screen.findByText('1 group collapsed')).toBeInTheDocument()
  })
})

describe('the group buttons', () => {
  it('sit together in the header, capitalised', async () => {
    renderPage()
    const priv = await screen.findByRole('button', { name: 'New Private Group' })
    const plat = screen.getByRole('button', { name: 'New Platform Group' })
    // Same container: neither is buried inside a section's content.
    expect(priv.parentElement).toBe(plat.parentElement)
  })

  it('keeps the platform one superadmin-only after the move', async () => {
    superAdmin = false
    renderPage()
    await screen.findByRole('button', { name: 'New Private Group' })
    expect(screen.queryByRole('button', { name: 'New Platform Group' })).not.toBeInTheDocument()
  })
})

describe('dragging a whole group onto Platform', () => {
  function dt() {
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

  it('promotes it in one call', async () => {
    renderPage()
    const group = await frameBox('Cameras')
    expect(group).toHaveAttribute('draggable', 'true')

    const transfer = dt()
    fireEvent.dragStart(group, { dataTransfer: transfer })
    expect(transfer.getData('application/x-freeframe-lut-group')).toBe('g1')

    fireEvent.drop(await frameBox('Platform LUTs'), { dataTransfer: transfer })
    // One call, not one per LUT: a partial result is a state the UI cannot
    // explain.
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/luts/platform-groups/promote/g1', {}),
    )
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('reports which LUTs were left behind as duplicates', async () => {
    post.mockResolvedValue({ promoted: 1, skipped: ['Two — already on the platform list as "Other"'] })
    renderPage()
    const transfer = dt()
    fireEvent.dragStart(await frameBox('Cameras'), { dataTransfer: transfer })
    fireEvent.drop(await frameBox('Platform LUTs'), { dataTransfer: transfer })

    expect(await screen.findByText(/Left behind: Two — already on the platform list/)).toBeInTheDocument()
  })

  it('is not offered to a non-superadmin', async () => {
    superAdmin = false
    renderPage()
    const group = await frameBox('Cameras')
    expect(group).not.toHaveAttribute('draggable', 'true')
  })
})
