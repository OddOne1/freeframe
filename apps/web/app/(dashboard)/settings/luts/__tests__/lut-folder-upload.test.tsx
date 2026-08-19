/**
 * Folder upload and the raised size limit (CLAUDE.md §42).
 *
 * jsdom has no FileSystemEntry, so the dropped-folder tests build the entry
 * objects the browser would hand over and assert the walk — which is the
 * part with real logic in it (recursion, batched readEntries, filtering).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const upload = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (p: string, b: unknown) => post(p, b),
    patch: (p: string, b: unknown) => patch(p, b),
    delete: vi.fn(),
    upload: (p: string, f: FormData) => upload(p, f),
  },
}))
vi.mock('@/stores/auth-store', () => ({ useAuthStore: () => ({ isSuperAdmin: false }) }))

import LutsSettingsPage from '../page'

let created = 0
beforeEach(() => {
  created = 0
  window.localStorage.clear()
  ;[get, post, patch, upload].forEach((m) => m.mockReset())
  patch.mockResolvedValue({})
  post.mockResolvedValue({ id: 'new-group' })
  upload.mockImplementation(() => Promise.resolve({ id: `lut-${++created}` }))
  get.mockImplementation(() => Promise.resolve([]))
})

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <LutsSettingsPage />
    </SWRConfig>,
  )
}

/** The uploader lives in a dialog now (§48-REVISED), so the drop zone and
 *  both browse buttons only exist once it is open. */
async function openUploader() {
  await userEvent.click(await screen.findByRole('button', { name: /^Upload/ }))
  return screen.findByTestId('lut-drop-zone')
}

function file(name: string, size = 10) {
  const f = new File(['LUT_3D_SIZE 2\n'], name, { type: 'text/plain' })
  Object.defineProperty(f, 'size', { value: size })
  return f
}

/** The shape webkitGetAsEntry hands back. jsdom has none of this. */
function fileEntry(name: string, size = 10): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (cb: (f: File) => void) => cb(file(name, size)),
  } as unknown as FileSystemEntry
}

function dirEntry(name: string, children: FileSystemEntry[]): FileSystemEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let done = false
      return {
        // Real readers return in batches and signal the end with an empty
        // one; a single call would silently truncate a large folder.
        readEntries: (cb: (entries: FileSystemEntry[]) => void) => {
          if (done) return cb([])
          done = true
          cb(children)
        },
      }
    },
  } as unknown as FileSystemEntry
}

function drop(entries: FileSystemEntry[]) {
  const zone = screen.getByTestId('lut-drop-zone')
  fireEvent.drop(zone, {
    dataTransfer: {
      types: ['Files'],
      files: [],
      items: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry })),
    },
  })
}

function uploadedNames() {
  return upload.mock.calls.map((c) => (c[1].get('file') as File).name)
}

describe('dropping a folder', () => {
  it('uploads only the .cube files and ignores the rest', async () => {
    renderPage()
    await openUploader()

    drop([
      dirEntry('Show LUTs', [
        fileEntry('one.cube'),
        fileEntry('readme.txt'),
        fileEntry('TWO.CUBE'), // case-insensitive on purpose
        fileEntry('poster.jpg'),
      ]),
    ])

    // Two of the four, and the .txt/.jpg raise nothing — a folder full of
    // other things is normal, not an error.
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(uploadedNames().sort()).toEqual(['TWO.CUBE', 'one.cube'])
    expect(screen.queryByText(/readme/)).not.toBeInTheDocument()
  })

  it('walks nested folders rather than only the top level', async () => {
    renderPage()
    await openUploader()

    drop([
      dirEntry('Show', [
        fileEntry('top.cube'),
        dirEntry('Sony', [fileEntry('nested.cube')]),
      ]),
    ])

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    expect(uploadedNames().sort()).toEqual(['nested.cube', 'top.cube'])
  })

  it('asks once for the batch whether to make a group of the folder', async () => {
    renderPage()
    await openUploader()

    drop([dirEntry('Show LUTs', [fileEntry('a.cube'), fileEntry('b.cube')])])
    const prompt = await screen.findByText(/into a group of that name/)
    expect(prompt).toHaveTextContent('Show LUTs')
    expect(prompt).toHaveTextContent('2 LUTs')
    // One prompt, not one per file.
    expect(screen.getAllByText(/into a group of that name/)).toHaveLength(1)
  })

  it('creates the group and files the uploads into it when accepted', async () => {
    renderPage()
    await openUploader()
    drop([dirEntry('Show LUTs', [fileEntry('a.cube'), fileEntry('b.cube')])])
    await screen.findByText(/into a group of that name/)

    await userEvent.click(screen.getByRole('button', { name: 'Create group' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/me/lut-groups', {
        name: 'Show LUTs',
        parent_group_id: null,
      }),
    )
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(patch.mock.calls.map((c) => c[0])).toEqual(['/me/luts/lut-1', '/me/luts/lut-2'])
    expect(patch.mock.calls[0][1]).toEqual({ group_id: 'new-group' })
  })

  it('leaves everything ungrouped when declined', async () => {
    renderPage()
    await openUploader()
    drop([dirEntry('Show LUTs', [fileEntry('a.cube')])])
    await screen.findByText(/into a group of that name/)

    await userEvent.click(screen.getByRole('button', { name: 'No thanks' }))
    await waitFor(() =>
      expect(screen.queryByText(/into a group of that name/)).not.toBeInTheDocument(),
    )
    expect(post).not.toHaveBeenCalled()
    expect(patch).not.toHaveBeenCalled()
  })

  it('offers no group name when several folders are dropped at once', async () => {
    renderPage()
    await openUploader()
    drop([
      dirEntry('One', [fileEntry('a.cube')]),
      dirEntry('Two', [fileEntry('b.cube')]),
    ])

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2))
    // No single folder to name it after, so it does not guess.
    expect(screen.queryByText(/into a group of that name/)).not.toBeInTheDocument()
  })

  it('does not treat this page’s own LUT drag as an upload', async () => {
    renderPage()
    const zone = await openUploader()
    fireEvent.dragOver(zone, {
      dataTransfer: { types: ['application/x-freeframe-lut'], items: [], files: [] },
    })
    expect(zone).not.toHaveAttribute('data-drop-active')

    // Carrying files as well, which some browsers do report alongside a
    // custom type — without the guard in handleDrop this would upload them.
    fireEvent.drop(zone, {
      dataTransfer: {
        types: ['application/x-freeframe-lut', 'Files'],
        items: [],
        files: [file('sneaky.cube')],
      },
    })
    await Promise.resolve()
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('the size limit', () => {
  it('refuses an oversized file before uploading it', async () => {
    renderPage()
    await openUploader()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('huge.cube', 2 * 1024 * 1024 * 1024)])

    expect(await screen.findByText(/Larger than the 1GB limit/)).toBeInTheDocument()
    // The point of a client-side check: nothing was sent.
    expect(upload).not.toHaveBeenCalled()
  })

  it('still uploads the rest of a batch around an oversized one', async () => {
    renderPage()
    await openUploader()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [
      file('fine.cube', 9 * 1024 * 1024),
      file('huge.cube', 2 * 1024 * 1024 * 1024),
    ])

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(uploadedNames()).toEqual(['fine.cube'])
    expect(await screen.findByText(/Larger than the 1GB limit/)).toBeInTheDocument()
  })

  it('accepts a file that the old 8MB limit would have rejected', async () => {
    renderPage()
    await openUploader()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    await userEvent.upload(input, [file('big.cube', 50 * 1024 * 1024)])

    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
    expect(screen.queryByText(/limit/)).not.toBeInTheDocument()
  })
})
