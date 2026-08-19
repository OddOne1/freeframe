/**
 * The "New group" form is a popup (CLAUDE.md §53).
 *
 * It used to render at one fixed point in the page — after Platform, before
 * Private — so pressing "+ sub-group" on something scrolled well down made
 * it appear where the user was not looking. The three triggers only ever set
 * state, so the dialog's open state is derived from that same state and none
 * of them changed.
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
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: true }) }))

import LutsSettingsPage from '../page'

const GROUP = { id: 'g1', name: 'Cameras', is_platform: false, parent_group_id: null }

beforeEach(() => {
  window.localStorage.clear()
  ;[get, post].forEach((m) => m.mockReset())
  post.mockResolvedValue({ id: 'new' })
  get.mockImplementation((p: string) => {
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

describe('the new-group dialog', () => {
  it('does not render until a trigger is pressed', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'New Private Group' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('New group name')).not.toBeInTheDocument()
  })

  it('opens from each of the three triggers, with its own wording', async () => {
    renderPage()

    await userEvent.click(await screen.findByRole('button', { name: 'New Private Group' }))
    expect(within(await screen.findByRole('dialog')).getByLabelText('New group name')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: 'New Platform Group' }))
    expect(
      within(await screen.findByRole('dialog')).getByLabelText('New platform group name'),
    ).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await userEvent.click(screen.getByLabelText('New sub-group in Cameras'))
    const sub = await screen.findByRole('dialog')
    expect(within(sub).getByLabelText('New sub-group name')).toBeInTheDocument()
    // Names the parent, which the inline form could only hint at in a
    // placeholder.
    expect(sub).toHaveTextContent('Cameras')
  })

  it('creates on Enter — Radix does not submit forms itself', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'New Private Group' }))
    await userEvent.type(screen.getByLabelText('New group name'), 'Shots{Enter}')

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Shots',
        parent_group_id: null,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('closes on Escape without creating anything', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'New Private Group' }))
    await userEvent.type(screen.getByLabelText('New group name'), 'Abandoned')
    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(post).not.toHaveBeenCalled()
  })

  it('closes on Cancel without creating anything', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'New Private Group' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(post).not.toHaveBeenCalled()
  })

  it('will not create an empty group', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'New Private Group' }))
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('New group name'), '   ')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })
})
