/**
 * How a refused LUT surfaces in the UI (CLAUDE.md §44).
 *
 * The rules themselves are the server's and are tested there. What is
 * asserted here is that a duplicate reads as a duplicate — it names where
 * the existing copy lives, and it does not present as something being
 * broken — and that a refused promotion is not swallowed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    patch: (p: string, b: unknown) => patch(p, b),
    post: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve()),
    upload: (p: string, f: FormData) => upload(p, f),
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: true }) }))

import LutsSettingsPage from '../page'

const LUT = {
  id: 'lut-1',
  name: 'Kodak 2383',
  file_url: '/x.cube',
  lut_size: 33,
  group_id: null,
  is_platform_wide: false,
  is_owner: true,
  created_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  window.localStorage.clear()
  ;[get, patch, upload].forEach((m) => m.mockReset())
  patch.mockResolvedValue({})
  upload.mockResolvedValue({})
  get.mockImplementation((p: string) => {
    if (p === '/me/luts') return Promise.resolve([LUT])
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

function file(name: string) {
  return new File(['LUT_3D_SIZE 2\n'], name, { type: 'text/plain' })
}

describe('a duplicate upload', () => {
  it('names where the existing copy lives, per file', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })

    upload.mockImplementation((_p: string, form: FormData) => {
      const name = (form.get('file') as File).name
      return name === 'dupe.cube'
        ? Promise.reject({
            status: 409,
            detail: 'You already have this LUT as "Kodak 2383" (in "Cameras").',
          })
        : Promise.resolve({})
    })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('fresh.cube'), file('dupe.cube')])

    const line = await screen.findByText(/Kodak 2383/, { selector: '[data-kind]' })
    expect(line).toHaveTextContent('dupe.cube')
    expect(line).toHaveTextContent('Cameras')
    // The other file still uploaded.
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
  })

  it('does not present as something being broken', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })

    upload.mockRejectedValue({ status: 409, detail: 'You already have this LUT as "A".' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('dupe.cube')])

    const line = await screen.findByText(/already have this LUT/, { selector: '[data-kind]' })
    // Nothing went wrong: the LUT is simply already there.
    expect(line).toHaveAttribute('data-kind', 'duplicate')
    expect(line.className).not.toContain('red')
  })

  it('still reports a real failure as a failure', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })

    upload.mockRejectedValue({ status: 400, detail: 'No LUT_3D_SIZE found — is this a .cube file?' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('broken.cube')])

    const line = await screen.findByText(/No LUT_3D_SIZE/, { selector: '[data-kind]' })
    expect(line).toHaveAttribute('data-kind', 'error')
    expect(line.className).toContain('red')
  })
})

describe('a refused promotion', () => {
  it('says why instead of looking like nothing happened', async () => {
    patch.mockRejectedValue({
      status: 409,
      detail: 'This LUT is already on the platform list as "House Look".',
    })
    renderPage()

    await userEvent.click(await screen.findByLabelText('Make Kodak 2383 platform-wide'))
    // Before §44 there was no catch here at all, so the click was silent.
    expect(await screen.findByText(/already on the platform list as "House Look"/)).toBeInTheDocument()
  })

  it('clears the message once something succeeds', async () => {
    patch.mockRejectedValueOnce({ status: 409, detail: 'Already on the platform list.' })
    renderPage()

    const button = await screen.findByLabelText('Make Kodak 2383 platform-wide')
    await userEvent.click(button)
    expect(await screen.findByText(/Already on the platform list/)).toBeInTheDocument()

    patch.mockResolvedValue({})
    await userEvent.click(button)
    await waitFor(() =>
      expect(screen.queryByText(/Already on the platform list/)).not.toBeInTheDocument(),
    )
  })
})
