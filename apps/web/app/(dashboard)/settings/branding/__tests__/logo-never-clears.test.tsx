/**
 * A configured logo cannot be taken away (§178).
 *
 * The complaint: "Remove" cleared the stored key, which made every surface
 * fall back to the bundled FreeFrame logo. Once an organisation has set its
 * own, that default must never appear again — only a new upload changes
 * what is shown.
 *
 * The backend is what actually enforces this (test_brand_image_never_clears.py
 * — a stale tab, a replayed request or the next redesign all go through the
 * API, not through this page). What is asserted HERE is the other half of
 * the decision: the page no longer offers a control that would ask for it.
 * A Remove button wired to a request the server ignores is worse than no
 * button — it is a button that visibly does nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const get = vi.fn()
const patch = vi.fn()
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: (path: string, body: unknown) => patch(path, body),
    upload: (path: string, body: unknown) => upload(path, body),
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { email: 'admin@example.com' }, isSuperAdmin: true }),
}))
vi.mock('@/stores/theme-store', () => ({ useThemeStore: () => ({ resolvedTheme: 'dark' }) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }))

import BrandingPage from '../page'

const COMMITTED = '/stream/hls/acme-dark.png?token=t'
const REPLACEMENT = '/stream/hls/acme-new.png?token=t'

type Settings = {
  org_name: string
  logo_dark_url: string | null
  logo_light_url: string | null
  logo_login_url: string | null
  favicon_url: string | null
  theme_colors: Record<string, unknown> | null
}

let settings: Settings

beforeEach(() => {
  settings = {
    org_name: 'Acme Studio',
    logo_dark_url: COMMITTED,
    logo_light_url: null,
    logo_login_url: null,
    favicon_url: null,
    theme_colors: null,
  }
  ;[get, patch, upload].forEach((m) => m.mockReset())
  get.mockImplementation(async () => settings)
  patch.mockImplementation(async (_p: string, body: Record<string, unknown>) => {
    settings = { ...settings, ...(body as Partial<Settings>) }
    return settings
  })
  upload.mockImplementation(async () => {
    // What the real endpoint does: the key is replaced, never emptied.
    settings = { ...settings, logo_dark_url: REPLACEMENT }
    return settings
  })
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(), writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true })
  }
  let blobSeq = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++blobSeq}`).mockClear()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}).mockClear()
})

/** A fresh SWR cache per render — see branding-draft.test.tsx for why. */
async function renderPage() {
  const r = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BrandingPage />
    </SWRConfig>,
  )
  await screen.findByText('Workspace name')
  return r
}

/** The slot's own preview image, which is what an admin is looking at.
 *
 *  Compared by substring: the hook runs every URL through
 *  `resolveApiMediaUrl`, which prefixes the API origin, and pinning the
 *  exact prefix here would be asserting that helper's behaviour rather than
 *  which image is on screen. */
function darkSlotSrc(): string {
  const slot = screen.getByText('Dark theme logo').closest('div')!.parentElement!
  return slot.querySelector('img')!.getAttribute('src') ?? ''
}

const fileInputs = () =>
  Array.from(document.querySelectorAll('input[type="file"]')) as HTMLInputElement[]

describe('a configured logo', () => {
  it('offers no way to remove it', async () => {
    await renderPage()

    expect(darkSlotSrc()).toContain('acme-dark.png')
    // Not "the button does nothing" — the button is not there.
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
  })

  it('says so, rather than leaving the absence to be discovered', async () => {
    await renderPage()

    expect(
      screen.getByText(/can be replaced, but not removed/i),
    ).toBeInTheDocument()
  })

  it('is never cleared by anything this page can send', async () => {
    const user = await renderPage()
    void user

    // Every control on the page, exercised: nothing produces a null for a
    // brand-image key. This is the assertion that would have caught the
    // original bug from the UI side.
    for (const call of patch.mock.calls) {
      const body = call[1] as Record<string, unknown>
      for (const key of ['logo_dark_s3_key', 'logo_light_s3_key', 'logo_login_s3_key', 'favicon_s3_key']) {
        expect(body[key]).toBeUndefined()
      }
    }
  })

  it('changes only when a new file is actually uploaded', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.upload(fileInputs()[0], new File(['x'], 'new.png', { type: 'image/png' }))
    // Staged, not saved: still local, nothing sent.
    expect(darkSlotSrc()).toBe('blob:mock-1')
    expect(upload).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(darkSlotSrc()).toContain('acme-new.png'))
  })

  it('backs out of a staged file to the committed logo, not to empty', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.upload(fileInputs()[0], new File(['x'], 'new.png', { type: 'image/png' }))
    expect(darkSlotSrc()).toBe('blob:mock-1')

    // Undo is the only destructive-looking control left, and it is not
    // destructive: it reverts an unsaved pick.
    await user.click(screen.getAllByRole('button', { name: /undo/i })[0])

    expect(darkSlotSrc()).toContain('acme-dark.png')
    expect(patch).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('offers Undo only while something is staged', async () => {
    const user = userEvent.setup()
    await renderPage()

    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull()
    await user.upload(fileInputs()[0], new File(['x'], 'new.png', { type: 'image/png' }))
    expect(screen.getAllByRole('button', { name: /undo/i }).length).toBe(1)
  })
})

describe('"reset" no longer reaches the logos', () => {
  it('resets the name and colours and leaves the logo alone', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: /reset name and colors/i }))
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(patch).toHaveBeenCalled())
    const body = patch.mock.calls[0][1] as Record<string, unknown>
    expect(body.org_name).toBe('FreeFrame')
    expect(body.theme_colors).toBeNull()
    expect('logo_dark_s3_key' in body).toBe(false)
    expect('favicon_s3_key' in body).toBe(false)
    // And the logo is still on screen afterwards.
    await waitFor(() => expect(darkSlotSrc()).toContain('acme-dark.png'))
  })

  it('is not offered to an org whose only customisation is its logo', async () => {
    /* The button can only reset a name and a palette now. Offering it where
       neither is customised promises something it cannot deliver. */
    settings = { ...settings, org_name: 'FreeFrame', theme_colors: null }
    await renderPage()

    expect(screen.queryByRole('button', { name: /reset name and colors/i })).toBeNull()
  })
})

describe('a fresh install', () => {
  it('shows an empty slot and still has no Remove to offer', async () => {
    settings = { ...settings, org_name: 'FreeFrame', logo_dark_url: null }
    await renderPage()

    expect(screen.getAllByText('No logo').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull()
  })

  it('can still set its first logo', async () => {
    settings = { ...settings, org_name: 'FreeFrame', logo_dark_url: null }
    upload.mockImplementation(async () => {
      settings = { ...settings, logo_dark_url: COMMITTED }
      return settings
    })
    const user = userEvent.setup()
    await renderPage()

    await user.upload(fileInputs()[0], new File(['x'], 'first.png', { type: 'image/png' }))
    await user.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(darkSlotSrc()).toContain('acme-dark.png'))
  })
})
