/**
 * Sorting in Settings → LUTs (CLAUDE.md §40).
 *
 * Two levels were asked for explicitly — the groups themselves, and the LUTs
 * inside them — so what is pinned here is that they are genuinely separate
 * controls, and that sorting does not disturb §38's collapse state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: vi.fn(() => Promise.resolve({})),
    post: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve()),
    upload: vi.fn(),
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: false }) }))

import LutsSettingsPage from '../page'

const GROUPS = [
  { id: 'g1', name: 'Zebra', is_platform: false },
  { id: 'g2', name: 'Alpha', is_platform: false },
]

const base = { file_url: '/x.cube', is_platform_wide: false, is_owner: true }
// Deliberately three different orders: by name Alfa/Bravo/Charlie, by size
// Bravo/Charlie/Alfa, by date added Charlie/Bravo/Alfa. A fixture where two
// of them coincide cannot tell the three sorts apart.
const LUTS = [
  { ...base, id: 'l1', name: 'Charlie', group_id: 'g1', lut_size: 33, created_at: '2026-01-01T00:00:00Z' },
  { ...base, id: 'l2', name: 'Alfa', group_id: 'g1', lut_size: 65, created_at: '2026-03-01T00:00:00Z' },
  { ...base, id: 'l3', name: 'Bravo', group_id: 'g1', lut_size: 17, created_at: '2026-02-01T00:00:00Z' },
  { ...base, id: 'l4', name: 'Solo', group_id: 'g2', lut_size: 33, created_at: '2026-01-01T00:00:00Z' },
]

beforeEach(() => {
  window.localStorage.clear()
  get.mockReset()
  get.mockImplementation((path: string) => {
    if (path === '/me/luts') return Promise.resolve(LUTS)
    if (path === '/me/lut-groups') return Promise.resolve(GROUPS)
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

/** Group headings in the order they are rendered, excluding the fixed
 *  section headers. */
function groupOrder() {
  // The frame-box titles (§41 renamed "Your LUTs" to "Private"), not groups.
  const fixed = ['Platform LUTs', 'Private', 'Ungrouped']
  return screen
    .getAllByRole('heading', { level: 2 })
    .map((h) => (h.textContent ?? '').replace(/\(\d+\)$/, ''))
    .filter((t) => !fixed.some((f) => t.startsWith(f)))
}

function lutOrderIn(groupName: string) {
  const section = screen
    .getByRole('heading', { name: new RegExp(`^${groupName}`), level: 2 })
    .closest('section') as HTMLElement
  return within(section)
    .queryAllByRole('heading', { level: 3 })
    .map((h) => h.textContent)
}

function control(label: string, option: string) {
  return within(screen.getByRole('group', { name: label })).getByRole('button', {
    name: new RegExp(option),
  })
}

describe('sorting the groups', () => {
  it('orders them by name, and reverses', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /^Alpha/, level: 2 })
    expect(groupOrder()).toEqual(['Alpha', 'Zebra'])

    await userEvent.click(control('Groups', 'Name'))
    expect(groupOrder()).toEqual(['Zebra', 'Alpha'])
  })

  it('orders them by how many LUTs each holds', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /^Alpha/, level: 2 })

    await userEvent.click(control('Groups', 'LUTs'))
    // Alpha holds 1, Zebra holds 3.
    expect(groupOrder()).toEqual(['Alpha', 'Zebra'])
    await userEvent.click(control('Groups', 'LUTs'))
    expect(groupOrder()).toEqual(['Zebra', 'Alpha'])
  })
})

describe('sorting the LUTs inside a group', () => {
  it('orders by name, size and date added', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /^Zebra/, level: 2 })
    expect(lutOrderIn('Zebra')).toEqual(['Alfa', 'Bravo', 'Charlie'])

    await userEvent.click(control('LUTs', 'Size'))
    expect(lutOrderIn('Zebra')).toEqual(['Bravo', 'Charlie', 'Alfa'])

    await userEvent.click(control('LUTs', 'Added'))
    expect(lutOrderIn('Zebra')).toEqual(['Charlie', 'Bravo', 'Alfa'])
    await userEvent.click(control('LUTs', 'Added'))
    expect(lutOrderIn('Zebra')).toEqual(['Alfa', 'Bravo', 'Charlie'])
  })

  it('is a separate control from the group sort', async () => {
    renderPage()
    await screen.findByRole('heading', { name: /^Alpha/, level: 2 })

    await userEvent.click(control('LUTs', 'Added')) // oldest first
    expect(lutOrderIn('Zebra')).toEqual(['Charlie', 'Bravo', 'Alfa'])
    // Reordering the LUTs must not reorder the groups.
    expect(groupOrder()).toEqual(['Alpha', 'Zebra'])

    await userEvent.click(control('Groups', 'Name')) // groups descending
    expect(groupOrder()).toEqual(['Zebra', 'Alpha'])
    // ...and reordering the groups must not reset the LUT sort.
    expect(lutOrderIn('Zebra')).toEqual(['Charlie', 'Bravo', 'Alfa'])
  })

  it('leaves a collapsed group collapsed, with its contents reordered underneath', async () => {
    renderPage()
    const heading = await screen.findByRole('heading', { name: /^Zebra/, level: 2 })
    await userEvent.click(within(heading).getByRole('button'))
    expect(lutOrderIn('Zebra')).toEqual([])

    await userEvent.click(control('LUTs', 'Size'))
    // Still collapsed (§38), not reopened by the sort.
    expect(lutOrderIn('Zebra')).toEqual([])

    await userEvent.click(within(screen.getByRole('heading', { name: /^Zebra/, level: 2 })).getByRole('button'))
    // Reordered underneath while it was shut.
    expect(lutOrderIn('Zebra')).toEqual(['Bravo', 'Charlie', 'Alfa'])
  })
})
