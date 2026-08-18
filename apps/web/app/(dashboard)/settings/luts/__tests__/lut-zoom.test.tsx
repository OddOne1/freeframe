/**
 * Settings → LUTs: the row swatch is the zoom trigger (CLAUDE.md §36).
 *
 * Scoped to this page on purpose. A LutPicker row already selects a LUT on
 * click, so a second click meaning on the same element there would be a real
 * ambiguity — lut-picker's own test pins that it stayed out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const renderLutPreview = vi.fn()
const renderLutThumbnail = vi.fn()

vi.mock('@/lib/lut/lut-thumbnail', () => ({
  REFERENCE_IMAGE_SRC: '/lut-reference.jpg',
  renderLutPreview: (id: string, url: string | null) => renderLutPreview(id, url),
  getCachedLutPreview: () => null,
  renderLutThumbnail: (id: string, url: string | null) => renderLutThumbnail(id, url),
  getCachedLutThumbnail: () => null,
}))

const get = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
    upload: vi.fn(),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ isSuperAdmin: false }),
}))

import LutsSettingsPage from '../page'

const OWN = {
  id: 'lut-1',
  name: 'Kodak 2383',
  file_url: '/luts/one.cube',
  lut_size: 33,
  group_id: null,
  is_platform_wide: false,
  is_owner: true,
  created_at: '2026-08-18T00:00:00Z',
}

const PLATFORM = { ...OWN, id: 'lut-2', name: 'Rec709 Show', is_platform_wide: true }

beforeEach(() => {
  renderLutPreview.mockReset()
  renderLutThumbnail.mockReset()
  renderLutPreview.mockResolvedValue('data:image/jpeg;base64,large')
  renderLutThumbnail.mockResolvedValue('data:image/png;base64,small')
  get.mockReset()
  get.mockImplementation((path: string) => {
    if (path === '/me/luts') return Promise.resolve([OWN, PLATFORM])
    if (path === '/luts/platform') return Promise.resolve([PLATFORM])
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

describe('§36 — click a LUT row swatch to zoom it', () => {
  it('opens the zoom, and renders it large rather than scaling the swatch', async () => {
    renderPage()
    const trigger = await screen.findByLabelText('Preview Kodak 2383')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(trigger)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Kodak 2383')
    await waitFor(() =>
      expect(renderLutPreview).toHaveBeenCalledWith('lut-1', '/luts/one.cube'),
    )
    await waitFor(() =>
      expect(screen.getByTestId('lut-preview-frame').querySelector('img')).toHaveAttribute(
        'src',
        'data:image/jpeg;base64,large',
      ),
    )
  })

  it('opens the LUT that was clicked, not whichever row rendered first', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('Preview Rec709 Show'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Rec709 Show')
    expect(dialog).not.toHaveTextContent('Kodak 2383')
    await waitFor(() => expect(renderLutPreview).toHaveBeenCalledWith('lut-2', '/luts/one.cube'))
  })

  it('is offered on read-only Platform rows too — looking is not managing', async () => {
    renderPage()
    // Not a superadmin here, so this row has no ⋯ menu and no Share control.
    expect(await screen.findByLabelText('Preview Rec709 Show')).toBeInTheDocument()
    expect(screen.queryByLabelText('More actions for Rec709 Show')).not.toBeInTheDocument()
  })
})
