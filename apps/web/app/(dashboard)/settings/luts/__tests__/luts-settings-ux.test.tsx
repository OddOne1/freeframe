/**
 * Settings → LUTs UX (CLAUDE.md §34 and its revision).
 *
 * Five changes, none of which needed backend work: PATCH /me/luts already
 * took name/group_id/is_platform_wide and PATCH /me/lut-groups/{id} already
 * renamed a group. So what is asserted throughout is the request that leaves
 * the page — a control that looks right but sends nothing is the failure
 * shape here, not a rendering one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const patch = vi.fn()
const post = vi.fn()
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (path: string) => get(path),
    patch: (path: string, body: unknown) => patch(path, body),
    post: (path: string, body: unknown) => post(path, body),
    delete: vi.fn(() => Promise.resolve()),
    upload: (path: string, form: FormData) => upload(path, form),
  },
}))

let superAdmin = true
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ isSuperAdmin: superAdmin }),
}))

import LutsSettingsPage from '../page'

const GROUP = { id: 'g1', name: 'Show LUTs' }

const base = {
  file_url: '/luts/one.cube',
  lut_size: 33,
  is_platform_wide: false,
  is_owner: true,
  created_at: '2026-08-18T00:00:00Z',
}
const UNGROUPED = { ...base, id: 'lut-1', name: 'Kodak 2383', group_id: null }
const IN_GROUP = { ...base, id: 'lut-2', name: 'Rec709 Show', group_id: 'g1' }

beforeEach(() => {
  superAdmin = true
  get.mockReset()
  patch.mockReset()
  post.mockReset()
  upload.mockReset()
  patch.mockResolvedValue({})
  upload.mockResolvedValue({})
  get.mockImplementation((path: string) => {
    if (path === '/me/luts') return Promise.resolve([UNGROUPED, IN_GROUP])
    if (path === '/luts/platform') return Promise.resolve([])
    if (path === '/me/lut-groups') return Promise.resolve([GROUP])
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

/** The row's own container — the element that carries draggable/onDragStart.
 *  Async because the list arrives from SWR. */
async function rowFor(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name, level: 3 })
  return heading.closest('div[draggable]') as HTMLElement
}

async function sectionFor(heading: string): Promise<HTMLElement> {
  const el = await screen.findByRole('heading', { name: heading, level: 2 })
  return el.closest('section') as HTMLElement
}

/** The ⋯ menu's own Rename, told apart from the group header's Rename button. */
async function openRowMenu(lutName: string) {
  await userEvent.click(await screen.findByLabelText(`More actions for ${lutName}`))
  const menu = await screen.findByRole('menu')
  await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
}

/** A DataTransfer stand-in: jsdom has no real one, and the type list is what
 *  the drop zones gate on. */
function dataTransfer() {
  const store = new Map<string, string>()
  return {
    setData: (type: string, value: string) => void store.set(type, value),
    getData: (type: string) => store.get(type) ?? '',
    get types() {
      return Array.from(store.keys())
    },
    dropEffect: '',
    effectAllowed: '',
  }
}

function file(name: string) {
  return new File(['LUT_3D_SIZE 2\n'], name, { type: 'text/plain' })
}

describe('multi-file upload', () => {
  it('uploads every picked file and refreshes once', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })
    get.mockClear()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toHaveAttribute('multiple')

    await userEvent.upload(input, [file('a.cube'), file('b.cube'), file('c.cube')])

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
    expect(upload.mock.calls.map((c) => c[0])).toEqual(['/me/luts', '/me/luts', '/me/luts'])
    // One refresh for the batch, not one per file: three endpoints, once each.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3))
  })

  it('keeps going after a failure and names the file that failed', async () => {
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })

    upload.mockImplementation((_path: string, form: FormData) => {
      const name = (form.get('file') as File).name
      return name === 'bad.cube'
        ? Promise.reject({ detail: 'LUT file must be UTF-8 text' })
        : Promise.resolve({})
    })

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('good.cube'), file('bad.cube'), file('third.cube')])

    // The other two are not blocked or dropped by the one that failed.
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
    const message = await screen.findByText(/LUT file must be UTF-8 text/)
    expect(message).toHaveTextContent('bad.cube')
    expect(screen.queryByText(/good\.cube/)).not.toBeInTheDocument()
  })
})

describe('drag and drop grouping', () => {
  it('moves a LUT into a group with the same PATCH the menu sends', async () => {
    renderPage()
    const row = await rowFor('Kodak 2383')
    expect(row).toHaveAttribute('draggable', 'true')

    const dt = dataTransfer()
    fireEvent.dragStart(row, { dataTransfer: dt })
    expect(dt.getData('application/x-freeframe-lut')).toBe('lut-1')

    const target = await sectionFor('Show LUTs')
    fireEvent.dragOver(target, { dataTransfer: dt })
    expect(target).toHaveAttribute('data-drop-active', 'true')

    fireEvent.drop(target, { dataTransfer: dt })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-1', { group_id: 'g1' }),
    )
  })

  it('takes a LUT back out of a group, via an Ungrouped zone that survives being empty', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/me/luts') return Promise.resolve([IN_GROUP]) // nothing ungrouped
      if (path === '/luts/platform') return Promise.resolve([])
      if (path === '/me/lut-groups') return Promise.resolve([GROUP])
      return Promise.resolve([])
    })
    renderPage()

    // Without this the last LUT dragged into a group could never come back.
    const target = await sectionFor('Ungrouped')
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Rec709 Show'), { dataTransfer: dt })
    fireEvent.drop(target, { dataTransfer: dt })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-2', { group_id: null }),
    )
  })

  it('does not PATCH when a LUT is dropped where it already is', async () => {
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Rec709 Show'), { dataTransfer: dt })
    fireEvent.drop(await sectionFor('Show LUTs'), { dataTransfer: dt })
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()
  })

  it('ignores a drag that is not a LUT', async () => {
    renderPage()
    const target = await sectionFor('Show LUTs')
    const foreign = dataTransfer()
    foreign.setData('Files', 'whatever')

    fireEvent.dragOver(target, { dataTransfer: foreign })
    // A file dragged in from the desktop must not look like a valid drop.
    expect(target).not.toHaveAttribute('data-drop-active')
  })

  it('does not make a promoted LUT a drag source', async () => {
    get.mockImplementation((path: string) => {
      if (path === '/me/luts') return Promise.resolve([UNGROUPED])
      if (path === '/luts/platform')
        return Promise.resolve([{ ...UNGROUPED, is_platform_wide: true }])
      if (path === '/me/lut-groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    renderPage()
    const heading = await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })
    const row = heading.closest('div[draggable]') as HTMLElement

    // Dragging back OUT of Platform was deliberately not built: a promoted
    // LUT is still someone's own row underneath, so "out" has no one target.
    expect(row).toHaveAttribute('draggable', 'false')
  })

  it('promotes a LUT dropped on the Platform section, for a superadmin only', async () => {
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Kodak 2383'), { dataTransfer: dt })
    const platform = await sectionFor('Platform LUTs')
    fireEvent.drop(platform, { dataTransfer: dt })
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-1', { is_platform_wide: true }),
    )
  })

  it('offers no platform drop zone to a non-superadmin', async () => {
    superAdmin = false
    renderPage()
    const dt = dataTransfer()
    fireEvent.dragStart(await rowFor('Kodak 2383'), { dataTransfer: dt })
    const platform = await sectionFor('Platform LUTs')
    fireEvent.dragOver(platform, { dataTransfer: dt })
    expect(platform).not.toHaveAttribute('data-drop-active')

    fireEvent.drop(platform, { dataTransfer: dt })
    await Promise.resolve()
    expect(patch).not.toHaveBeenCalled()
  })
})

describe('rename', () => {
  it('renames a LUT through the ⋯ menu and PATCHes the new name', async () => {
    renderPage()
    await openRowMenu('Kodak 2383')

    const input = screen.getByLabelText('Rename Kodak 2383')
    await userEvent.clear(input)
    await userEvent.type(input, 'Kodak 2383 D65{Enter}')

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-1', { name: 'Kodak 2383 D65' }),
    )
  })

  it('abandons a LUT rename on Escape without sending anything', async () => {
    renderPage()
    await openRowMenu('Kodak 2383')
    await userEvent.type(screen.getByLabelText('Rename Kodak 2383'), 'nope{Escape}')

    expect(patch).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Kodak 2383', level: 3 })).toBeInTheDocument()
  })

  it('renames a group through its own PATCH endpoint', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('Rename group Show LUTs'))

    const input = screen.getByLabelText('Rename Show LUTs')
    await userEvent.clear(input)
    await userEvent.type(input, 'Delivery{Enter}')

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/lut-groups/g1', { name: 'Delivery' }),
    )
  })

  it('does not PATCH an unchanged name', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('Rename group Show LUTs'))
    await userEvent.type(screen.getByLabelText('Rename Show LUTs'), '{Enter}')
    expect(patch).not.toHaveBeenCalled()
  })

  it('stops the row being draggable while its name is being edited', async () => {
    renderPage()
    await openRowMenu('Kodak 2383')

    const input = screen.getByLabelText('Rename Kodak 2383')
    // Dragging is how you select text in an input; a row that flies away
    // mid-edit is unusable.
    expect(input.closest('div[draggable="true"]')).toBeNull()
  })
})

describe('platform toggle', () => {
  it('is a visible button on a superadmin own row, and toggles', async () => {
    renderPage()
    const button = await screen.findByLabelText('Make Kodak 2383 platform-wide')
    expect(button).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(button)
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith('/me/luts/lut-1', { is_platform_wide: true }),
    )
  })

  it('no longer duplicates itself inside the ⋯ menu', async () => {
    renderPage()
    await userEvent.click(await screen.findByLabelText('More actions for Kodak 2383'))
    const menu = await screen.findByRole('menu')
    // Two paths to one action is what made it undiscoverable in the first place.
    expect(within(menu).queryByText(/platform/i)).not.toBeInTheDocument()
  })

  it('is absent entirely for a non-superadmin', async () => {
    superAdmin = false
    renderPage()
    await screen.findByRole('heading', { name: 'Kodak 2383', level: 3 })

    expect(screen.queryByLabelText(/platform-wide/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('More actions for Kodak 2383'))
    const menu = await screen.findByRole('menu')
    expect(within(menu).queryByText(/platform/i)).not.toBeInTheDocument()
  })

  it('is not offered on a Platform row a superadmin does not own', async () => {
    const OTHERS = {
      ...base,
      id: 'lut-9',
      name: 'House Look',
      group_id: null,
      is_platform_wide: true,
      is_owner: false,
      owner_name: 'Someone else',
    }
    get.mockImplementation((path: string) => {
      if (path === '/me/luts') return Promise.resolve([UNGROUPED])
      if (path === '/luts/platform') return Promise.resolve([OTHERS])
      if (path === '/me/lut-groups') return Promise.resolve([])
      return Promise.resolve([])
    })
    renderPage()
    await screen.findByRole('heading', { name: 'House Look', level: 3 })

    // PATCH /me/luts is owner-scoped server-side, so this would 404 anyway.
    expect(screen.queryByLabelText(/House Look from Platform LUTs/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('More actions for House Look')).not.toBeInTheDocument()
  })
})
