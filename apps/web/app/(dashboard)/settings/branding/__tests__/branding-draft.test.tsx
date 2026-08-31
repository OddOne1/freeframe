/**
 * Branding settings stage changes instead of applying them (CLAUDE.md §106).
 *
 * The bug this covers is not a rendering one: SiteSettings is instance-wide,
 * and every control on this page used to PATCH on change — so an admin
 * dragging through a colour swatch was repainting the app for every signed-in
 * user while still deciding. What is asserted here is therefore mostly about
 * what does NOT happen: no request until Save, exactly the changed fields on
 * Save, and nothing at all on Discard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
    org_name: 'FreeFrame',
    logo_dark_url: null,
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
  upload.mockImplementation(async () => settings)
  // jsdom has no object-URL implementation.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(), writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true })
  }
  // Distinct per call: with one shared string, "revoked the URL it just
  // replaced" and "revoked the wrong one" are the same assertion.
  let blobSeq = 0
  // mockClear, not just spyOn: vi.spyOn on an already-spied method hands
  // back the SAME mock, so its call log survives into the next test. Every
  // test's first blob is blob:mock-1, so the previous test's unmount
  // cleanup had already "revoked" it — and an assertion about revoking
  // passed without the code under test doing anything at all.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++blobSeq}`).mockClear()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}).mockClear()
})

/** A FRESH SWR cache per render. Without it the hook's cache outlives the
 *  test file: a value saved in one test becomes the committed baseline of
 *  the next, so "type the new name" is not a change any more and the Save
 *  bar never appears. That failed as "cannot find the Discard button",
 *  which points nowhere near the actual cause. */
function renderPage() {
  const r = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <BrandingPage />
    </SWRConfig>,
  )
  return screen.findByText('Workspace name').then(() => r)
}

const nameField = () => screen.getByPlaceholderText('e.g. Acme Studio') as HTMLInputElement

describe('branding draft state', () => {
  it('types a new name without sending anything', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.clear(nameField())
    await user.type(nameField(), 'Acme Studio')
    // The whole point. Not "one request" — none.
    expect(patch).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('shows the draft in the Preview, not the committed value', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.clear(nameField())
    await user.type(nameField(), 'Acme Studio')
    // The preview used to mirror what had already saved, which made it a
    // report rather than a preview.
    const preview = screen.getByText('Preview').closest('section')!
    expect(preview.textContent).toContain('Acme Studio')
    expect(preview.textContent).toContain('unsaved changes')
  })

  it('sends only the changed field on Save', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.clear(nameField())
    await user.type(nameField(), 'Acme Studio')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(patch.mock.calls[0][1]).toEqual({ org_name: 'Acme Studio' })
  })

  it('Discard reverts the form and sends nothing', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.clear(nameField())
    await user.type(nameField(), 'Acme Studio')
    await user.click(screen.getByRole('button', { name: /discard/i }))
    expect(nameField().value).toBe('FreeFrame')
    expect(patch).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('offers no Save bar until something actually differs', async () => {
    const user = userEvent.setup()
    await renderPage()
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
    await user.clear(nameField())
    await user.type(nameField(), 'X')
    expect(screen.getByRole('button', { name: /save changes/i })).toBeTruthy()
  })

  it('a colour change stages, and Save sends that theme only', async () => {
    const user = userEvent.setup()
    await renderPage()
    const swatches = document.querySelectorAll('input[type="color"]')
    // Light theme editor renders first.
    const first = swatches[0] as HTMLInputElement
    await user.clear(nameField())
    await user.type(nameField(), 'FreeFrame')
    // Dragging a swatch used to PATCH per event, live, for everyone. Driven
    // with fireEvent because React tracks an input's value and swallows a
    // change event raised after assigning .value directly — the handler
    // simply never runs, and the test reads as "the feature is broken".
    for (const v of ['#111111', '#222222', '#333333']) {
      fireEvent.change(first, { target: { value: v } })
    }
    expect(patch).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    const body = patch.mock.calls[0][1] as { theme_colors: Record<string, Record<string, string>> }
    expect(Object.keys(body.theme_colors)).toEqual(['light'])
    // Only the final value, not one request per drag event.
    expect(Object.values(body.theme_colors.light)).toContain('#333333')
  })

  it('holds a picked logo file locally and only uploads on Save', async () => {
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['x'], 'logo.png', { type: 'image/png' })
    const inputs = document.querySelectorAll('input[type="file"]')
    await user.upload(inputs[0] as HTMLInputElement, file)
    expect(upload).not.toHaveBeenCalled()
    // Rendered from the blob URL, so the preview reflects a file the server
    // has never seen.
    expect(URL.createObjectURL).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(upload.mock.calls[0][0]).toContain('side=dark')
  })

  it('discarding a picked file revokes its object URL', async () => {
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['x'], 'logo.png', { type: 'image/png' })
    await user.upload(document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement, file)
    await user.click(screen.getByRole('button', { name: /discard/i }))
    // An unrevoked blob URL pins its File for the life of the document.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(upload).not.toHaveBeenCalled()
  })

  it('Reset to defaults stages, and can be backed out of', async () => {
    settings = { ...settings, org_name: 'Acme', logo_dark_url: '/stream/logo.png' }
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
    // It used to fire resetAll() on click — irreversible, instantly, for
    // everyone.
    expect(patch).not.toHaveBeenCalled()
    expect(nameField().value).toBe('FreeFrame')
    await user.click(screen.getByRole('button', { name: /discard/i }))
    expect(nameField().value).toBe('Acme')
    expect(patch).not.toHaveBeenCalled()
  })

  it('a staged full reset saves as one call, not five', async () => {
    settings = { ...settings, org_name: 'Acme', logo_dark_url: '/stream/logo.png' }
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    const body = patch.mock.calls[0][1] as Record<string, unknown>
    expect(body.org_name).toBe('FreeFrame')
    expect(body.logo_dark_s3_key).toBeNull()
    expect(body.theme_colors).toBeNull()
  })

  it('the upload slot itself shows the staged file, not the saved one', async () => {
    settings = { ...settings, logo_dark_url: '/stream/committed.png' }
    const user = userEvent.setup()
    await renderPage()
    const slot = screen.getByText('Dark theme logo').closest('div')!.parentElement!
    expect(slot.querySelector('img')!.getAttribute('src')).toContain('committed.png')
    await user.upload(
      document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement,
      new File(['x'], 'new.png', { type: 'image/png' }),
    )
    // Not just the Preview section — the slot a person is looking at while
    // they pick has to show what they picked.
    expect(slot.querySelector('img')!.getAttribute('src')).toBe('blob:mock-1')
  })

  it('replacing a picked file revokes the one it replaced', async () => {
    const user = userEvent.setup()
    await renderPage()
    const input = document.querySelectorAll('input[type="file"]')[0] as HTMLInputElement
    await user.upload(input, new File(['a'], 'a.png', { type: 'image/png' }))
    await user.upload(input, new File(['b'], 'b.png', { type: 'image/png' }))
    // Blob URLs are not garbage-collected; an unrevoked one pins its File
    // for the life of the document.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-2')
  })

  it('a reset that is then edited removes only the slots that had something', async () => {
    // Committed: one logo, custom name. Staging a reset and then typing a
    // name means it is no longer "everything cleared", so Save takes the
    // per-field path — where clearing the two slots that were ALREADY empty
    // would be two pointless requests.
    settings = { ...settings, org_name: 'Acme', logo_dark_url: '/stream/logo.png' }
    const user = userEvent.setup()
    await renderPage()
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
    await user.clear(nameField())
    await user.type(nameField(), 'Still Custom')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(patch).toHaveBeenCalled())
    const keys = patch.mock.calls.map((c) => Object.keys(c[1] as object)[0])
    expect(keys).toContain('logo_dark_s3_key')
    expect(keys).not.toContain('logo_light_s3_key')
    expect(keys).not.toContain('logo_login_s3_key')
  })

  it('an abandoned draft does not survive a remount', async () => {
    const user = userEvent.setup()
    const { unmount } = await renderPage()
    await user.clear(nameField())
    await user.type(nameField(), 'Ghost')
    unmount()
    await renderPage()
    // Nothing was saved, so nothing should come back.
    expect(nameField().value).toBe('FreeFrame')
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull()
  })
})
