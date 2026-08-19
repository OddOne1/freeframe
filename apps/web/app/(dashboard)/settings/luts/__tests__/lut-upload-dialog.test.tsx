/**
 * The LUT uploader lives in a dialog (CLAUDE.md §48-REVISED).
 *
 * The two browse buttons are the point: macOS Chromium's webkitdirectory
 * picker happens to allow loose files too, but Windows' genuinely does not,
 * so a single control cannot cover both. Asserted here so a later "simplify
 * to one button" does not quietly break Windows.
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
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(),
    upload: (p: string, f: FormData) => upload(p, f),
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: false }) }))

import LutsSettingsPage from '../page'

beforeEach(() => {
  window.localStorage.clear()
  ;[get, upload].forEach((m) => m.mockReset())
  upload.mockResolvedValue({ id: 'lut-1' })
  get.mockImplementation(() => Promise.resolve([]))
})

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LutsSettingsPage />
    </SWRConfig>,
  )
}

function cubeFile(name = 'a.cube') {
  return new File(['LUT_3D_SIZE 2\n'], name, { type: 'text/plain' })
}

describe('the upload dialog', () => {
  it('hides the uploader behind one trigger instead of page-level buttons', async () => {
    renderPage()
    await screen.findByRole('button', { name: /^Upload/ })

    // Nothing on the page itself any more.
    expect(screen.queryByTestId('lut-drop-zone')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add files' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens a dialog holding the drop zone and both browse buttons', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByTestId('lut-drop-zone')).toBeInTheDocument()
    // Two, not one. A single control cannot offer both on Windows.
    expect(within(dialog).getByRole('button', { name: 'Add files' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Add folder' })).toBeInTheDocument()
  })

  it('drives a plain multi-file input from "Add files"', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
    const dialog = await screen.findByRole('dialog')

    const inputs = Array.from(dialog.querySelectorAll('input[type="file"]'))
    const plain = inputs.find((i) => !i.hasAttribute('webkitdirectory'))!
    expect(plain).toHaveAttribute('accept', '.cube')
    expect(plain).toHaveAttribute('multiple')
  })

  it('drives a webkitdirectory input from "Add folder"', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
    const dialog = await screen.findByRole('dialog')

    const folder = dialog.querySelector('input[webkitdirectory]')
    expect(folder).not.toBeNull()
    expect(folder).toHaveAttribute('multiple')
  })

  it('closes once an upload starts, so results are not stuck behind the overlay', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
    const dialog = await screen.findByRole('dialog')

    const plain = Array.from(dialog.querySelectorAll('input[type="file"]')).find(
      (i) => !i.hasAttribute('webkitdirectory'),
    ) as HTMLInputElement
    await userEvent.upload(plain, [cubeFile()])

    // Radix's modal makes the rest of the page inert; per-file errors and the
    // group prompt render there.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  })

  it('keeps the inputs inside the dialog, where they are reachable', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
    const dialog = await screen.findByRole('dialog')

    // An input left on the inert page behind the modal is a trap for the day
    // something clicks it directly.
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(
      dialog.querySelectorAll('input[type="file"]').length,
    )
  })
})
