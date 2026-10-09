/**
 * Project settings hold a draft, and an SWR refetch does not overwrite it.
 *
 * The `project` prop comes straight from `useSWR` in
 * app/(dashboard)/projects/[id]/page.tsx, and SWR revalidates on window
 * focus. Every project response carries a freshly minted `poster_url`
 * (`proxy_url_for` -> `create_hls_token`, whose JWT `exp` is "now + 24h"),
 * so a refetch that changed nothing still delivers a NEW object — SWR's
 * own equality check sees a different string and hands the component a new
 * identity. An effect keyed on `[project]` therefore re-seeded the whole
 * form on nothing more than a tab switch.
 *
 * What that cost, as the owner saw it in Safari: pick a cover image, watch
 * the preview appear, then watch it revert to the old poster — and because
 * `posterFile` was dropped along with the preview, Save then uploaded
 * nothing at all. The same effect wiped unsaved name/description/storage
 * edits.
 *
 * So most of these assertions are about what must NOT happen when the same
 * project arrives again, plus the two moments that legitimately DO reset a
 * draft: opening the dialog, and switching to a different project.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import type { Project } from '@/types'

const get = vi.fn()
const patch = vi.fn()
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: (path: string, body: unknown) => patch(path, body),
    upload: (path: string, body: unknown) => upload(path, body),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { email: 'owner@example.com', storage_limit_bytes: 500 * 1024 ** 3 } }),
}))

import { ProjectSettingsDialog } from '../project-settings-dialog'

const GB = 1024 ** 3

/** A poster URL shaped like the real one: the token is the part that moves. */
const posterUrl = (token: string) => `/stream/hls/poster.jpg?token=${token}`

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'Wibmerland',
    description: 'Bike film',
    created_by: 'user-1',
    project_type: 'personal',
    poster_url: posterUrl('token-A'),
    is_public: false,
    created_at: '2026-10-01T00:00:00Z',
    deleted_at: null,
    storage_limit_bytes: 50 * GB,
    storage_slug: 'wibmerland',
    storage_locked: false,
    ratings_visible_to_all: false,
    transcription_default: true,
    role: 'owner',
    ...overrides,
  }
}

beforeEach(() => {
  ;[get, patch, upload].forEach((m) => m.mockReset())
  // The dialog's own `/projects` SWR, used only for the other-projects
  // storage allocation. This project is the only one, so nothing is
  // allocated elsewhere and the limit field validates freely.
  get.mockImplementation(async () => [makeProject()])
  patch.mockImplementation(async () => makeProject())
  upload.mockImplementation(async () => ({}))
  // jsdom has no object-URL implementation.
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(), writable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true })
  }
  // Distinct per call, so "revoked the one it replaced" and "revoked the
  // wrong one" are not the same assertion. mockClear matters because
  // vi.spyOn on an already-spied method returns the SAME mock, carrying the
  // previous test's call log into this one.
  let blobSeq = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:mock-${++blobSeq}`).mockClear()
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}).mockClear()
})

/** A fresh SWR cache per render, so one test's `/projects` response is not
 *  the next test's committed baseline. */
function renderDialog(project: Project, open = true) {
  const onUpdated = vi.fn()
  const onOpenChange = vi.fn()
  const ui = (p: Project, isOpen: boolean) => (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectSettingsDialog
        project={p}
        open={isOpen}
        onOpenChange={onOpenChange}
        onUpdated={onUpdated}
      />
    </SWRConfig>
  )
  const r = render(ui(project, open))
  return {
    ...r,
    onUpdated,
    onOpenChange,
    /** Re-render with a different project object and/or open state, the way
     *  the parent does when SWR hands it new data. */
    update: (p: Project, isOpen = true) => r.rerender(ui(p, isOpen)),
  }
}

const nameField = () => screen.getByPlaceholderText('Project name') as HTMLInputElement
const descField = () => screen.getByPlaceholderText(/optional project description/i) as HTMLTextAreaElement
const slugField = () => screen.getByPlaceholderText(/auto-generated/i) as HTMLInputElement
const limitField = () => screen.getByPlaceholderText('Unlimited') as HTMLInputElement
const posterImg = () => document.querySelector('img[alt="Poster"]') as HTMLImageElement | null
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement
const saveButton = () => screen.getByRole('button', { name: /^save$/i })

const cover = () => new File(['jpeg-bytes'], 'cover.jpg', { type: 'image/jpeg' })

describe('project settings draft survives a refetch', () => {
  it('keeps a picked cover image and typed edits when the same project is refetched', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())

    await user.upload(fileInput(), cover())
    await user.clear(nameField())
    await user.type(nameField(), 'Wibmerland 2026')
    expect(posterImg()!.getAttribute('src')).toBe('blob:mock-1')

    // A focus revalidation: same project, same everything, one re-signed
    // poster token. This is the whole bug.
    update(makeProject({ poster_url: posterUrl('token-B') }))

    expect(posterImg()!.getAttribute('src')).toBe('blob:mock-1')
    expect(nameField().value).toBe('Wibmerland 2026')

    // The preview reverting was the visible half; the pending file being
    // dropped was the damaging half, because Save then uploaded nothing.
    await user.click(saveButton())
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(upload.mock.calls[0][0]).toBe('/projects/project-1/poster')
  })

  it('keeps unsaved description and storage-limit edits across a refetch', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())

    await user.clear(descField())
    await user.type(descField(), 'Second edit, not saved yet')
    await user.clear(limitField())
    await user.type(limitField(), '80')

    update(makeProject({ poster_url: posterUrl('token-B') }))

    expect(descField().value).toBe('Second edit, not saved yet')
    expect(limitField().value).toBe('80')
  })

  it('shows a poster changed elsewhere while nothing is being edited', async () => {
    // The deliberate exception: with no pending pick, the poster is read
    // live from the project, so a cover someone else changed still appears.
    const { update } = renderDialog(makeProject())
    expect(posterImg()!.getAttribute('src')).toContain('token-A')

    update(makeProject({ poster_url: posterUrl('token-NEW') }))
    expect(posterImg()!.getAttribute('src')).toContain('token-NEW')
  })

  it('a pending pick outranks a poster changed elsewhere', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())
    await user.upload(fileInput(), cover())

    update(makeProject({ poster_url: posterUrl('token-NEW') }))

    // Not the server's new poster: what the person is looking at is the
    // file they just chose.
    expect(posterImg()!.getAttribute('src')).toBe('blob:mock-1')
  })
})

describe('the two resets that are still meant to happen', () => {
  it('reopening the dialog starts a fresh draft', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())

    await user.clear(nameField())
    await user.type(nameField(), 'Abandoned')
    await user.upload(fileInput(), cover())

    // In projects/[id]/page.tsx this dialog stays mounted across opens, so
    // closing it is not an unmount and the draft would otherwise persist.
    update(makeProject(), false)
    update(makeProject(), true)

    expect(nameField().value).toBe('Wibmerland')
    expect(posterImg()!.getAttribute('src')).toContain('token-A')
  })

  it('closing the dialog revokes a pending pick its blob URL', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())
    await user.upload(fileInput(), cover())

    update(makeProject(), false)

    // An unrevoked blob URL pins its File for the life of the document.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('replacing a pick revokes the URL it replaced, and not the new one', async () => {
    const user = userEvent.setup()
    renderDialog(makeProject())
    await user.upload(fileInput(), cover())
    await user.upload(fileInput(), new File(['other'], 'other.jpg', { type: 'image/jpeg' }))

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock-2')
    expect(posterImg()!.getAttribute('src')).toBe('blob:mock-2')
  })

  it('unmounting with a pick pending revokes its blob URL', async () => {
    const user = userEvent.setup()
    const { unmount } = renderDialog(makeProject())
    await user.upload(fileInput(), cover())
    unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it('a different project resets the draft even without closing', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())

    await user.clear(nameField())
    await user.type(nameField(), 'Belongs to project 1')
    await user.upload(fileInput(), cover())

    update(makeProject({ id: 'project-2', name: 'Other Project', storage_slug: 'other', poster_url: null }))

    // Carrying project 1's draft onto project 2 would save one project's
    // name over another's.
    expect(nameField().value).toBe('Other Project')
    expect(slugField().value).toBe('other')
    expect(posterImg()).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })
})

describe('saving', () => {
  it('uploads the pending file once, patches, and closes', async () => {
    const user = userEvent.setup()
    const { onUpdated, onOpenChange } = renderDialog(makeProject())

    await user.upload(fileInput(), cover())
    await user.clear(nameField())
    await user.type(nameField(), 'Renamed')
    await user.click(saveButton())

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(patch.mock.calls[0][0]).toBe('/projects/project-1')
    expect(patch.mock.calls[0][1]).toMatchObject({ name: 'Renamed', storage_slug: 'wibmerland' })
    expect(onUpdated).toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('a refetch landing mid-edit does not cost the upload', async () => {
    const user = userEvent.setup()
    const { update } = renderDialog(makeProject())

    await user.upload(fileInput(), cover())
    // Focus revalidation between picking and saving — the exact sequence
    // the owner hit.
    update(makeProject({ poster_url: posterUrl('token-B') }))
    await user.click(saveButton())

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
  })

  it('saves nothing to upload when no cover was picked', async () => {
    const user = userEvent.setup()
    renderDialog(makeProject())
    await user.clear(nameField())
    await user.type(nameField(), 'Just a rename')
    await user.click(saveButton())

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    expect(upload).not.toHaveBeenCalled()
  })
})
