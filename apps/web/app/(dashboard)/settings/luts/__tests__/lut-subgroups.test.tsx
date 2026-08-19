/**
 * Sub-groups in Settings → LUTs (CLAUDE.md §45).
 *
 * The depth cap and the personal/platform split are enforced server-side and
 * tested there. What is asserted here is that the UI never offers an action
 * the server would refuse, and that a sub-group is a real drop target with
 * its own collapse rather than a visual indent.
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
const patch = vi.fn()
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

const MAIN = { id: 'g1', name: 'Cameras', is_platform: false, parent_group_id: null }
const SUB = { id: 'g2', name: 'Sony', is_platform: false, parent_group_id: 'g1' }
const PLATFORM_MAIN = { id: 'pg1', name: 'House', is_platform: true, parent_group_id: null }
const PLATFORM_SUB = { id: 'pg2', name: 'Show', is_platform: true, parent_group_id: 'pg1' }

const base = { file_url: '/x.cube', is_owner: true, created_at: '2026-01-01T00:00:00Z', lut_size: 33 }
const IN_SUB = { ...base, id: 'l1', name: 'Venice', group_id: 'g2', is_platform_wide: false }
const IN_MAIN = { ...base, id: 'l2', name: 'Generic', group_id: 'g1', is_platform_wide: false }
const LOOSE = { ...base, id: 'l3', name: 'Loose', group_id: null, is_platform_wide: false }

beforeEach(() => {
  superAdmin = true
  window.localStorage.clear()
  ;[get, post, patch].forEach((m) => m.mockReset())
  post.mockResolvedValue({})
  patch.mockResolvedValue({})
  get.mockImplementation((p: string) => {
    if (p === '/me/luts') return Promise.resolve([IN_SUB, IN_MAIN, LOOSE])
    if (p === '/me/lut-groups') return Promise.resolve([MAIN, SUB])
    if (p === '/luts/platform') return Promise.resolve([])
    if (p === '/luts/platform-groups') return Promise.resolve([PLATFORM_MAIN, PLATFORM_SUB])
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

async function sectionFor(name: string): Promise<HTMLElement> {
  const h = await screen.findByRole('heading', { name: new RegExp(`^${name}`), level: 2 })
  return h.closest('section') as HTMLElement
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

describe('rendering', () => {
  it('nests a sub-group inside its main group, not beside it', async () => {
    renderPage()
    const main = await sectionFor('Cameras')
    // The sub-group's own section is a descendant of the main group's.
    expect(within(main).getByRole('heading', { name: /^Sony/, level: 2 })).toBeInTheDocument()
    // ...and the sub-group's LUT is inside it, not loose in the parent.
    const sub = within(main).getByRole('heading', { name: /^Sony/, level: 2 }).closest('section')!
    expect(within(sub).getByRole('heading', { name: 'Venice', level: 3 })).toBeInTheDocument()
  })

  it('counts only its own LUTs on each group, not its children’s', async () => {
    renderPage()
    // Cameras holds one LUT directly; Sony holds the other.
    // The accessible name glues the parenthesised count to the title.
    expect(await screen.findByRole('heading', { name: 'Cameras(1)', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sony(1)', level: 2 })).toBeInTheDocument()
  })

  it('gives a sub-group its own collapse', async () => {
    renderPage()
    const main = await sectionFor('Cameras')
    const subHeading = within(main).getByRole('heading', { name: /^Sony/, level: 2 })
    await userEvent.click(within(subHeading).getByRole('button'))

    expect(screen.queryByRole('heading', { name: 'Venice', level: 3 })).not.toBeInTheDocument()
    // Collapsing the child leaves the parent's own LUT showing.
    expect(screen.getByRole('heading', { name: 'Generic', level: 3 })).toBeInTheDocument()
  })

  it('nests platform sub-groups the same way', async () => {
    renderPage()
    const main = await sectionFor('House')
    expect(within(main).getByRole('heading', { name: /^Show/, level: 2 })).toBeInTheDocument()
  })
})

describe('creating a sub-group', () => {
  it('posts the parent along with the name', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('New sub-group in Cameras'))
    await userEvent.type(screen.getByLabelText('New sub-group name'), 'Arri{Enter}')

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Arri',
        parent_group_id: 'g1',
      }),
    )
  })

  it('posts a platform sub-group to the platform endpoint', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('New sub-group in House'))
    await userEvent.type(screen.getByLabelText('New sub-group name'), 'Docs{Enter}')

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/luts/platform-groups', {
        name: 'Docs',
        parent_group_id: 'pg1',
      }),
    )
  })

  it('does not offer a sub-group action on a sub-group', async () => {
    renderPage()
    await screen.findByLabelText('New sub-group in Cameras')
    // One level only, so the action is absent where the server would refuse.
    expect(screen.queryByLabelText('New sub-group in Sony')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New sub-group in Show')).not.toBeInTheDocument()
  })

  it('forgets a remembered parent once the dialog closes', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('New sub-group in Cameras'))
    // The form is a modal now (§53), so reaching another trigger while it is
    // open is not possible — dismissing it is the only route, and dismissing
    // is what has to clear the parent. Escape rather than Cancel, since that
    // path goes through onOpenChange rather than the button's own handler.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'New Private Group' }))
    await userEvent.type(screen.getByLabelText('New group name'), 'Top{Enter}')

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Top',
        // Not 'g1' — a stale parent here would silently file it under Cameras.
        parent_group_id: null,
      }),
    )
  })
})

describe('dropping into a sub-group', () => {
  it('files the LUT into the sub-group, not its parent', async () => {
    renderPage()
    const main = await sectionFor('Cameras')
    const sub = within(main).getByRole('heading', { name: /^Sony/, level: 2 }).closest('section')!

    const dt = dataTransfer()
    const row = (await screen.findByRole('heading', { name: 'Loose', level: 3 })).closest(
      'div[draggable]',
    ) as HTMLElement
    fireEvent.dragStart(row, { dataTransfer: dt })
    fireEvent.drop(sub, { dataTransfer: dt })

    await waitFor(() => expect(patch).toHaveBeenCalledWith('/me/luts/l3', { group_id: 'g2' }))
  })
})
