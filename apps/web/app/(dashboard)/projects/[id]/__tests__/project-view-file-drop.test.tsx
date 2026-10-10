/**
 * Dropping files and folders onto the project view itself (§223 C).
 *
 * The page is rendered for real, with the API stubbed, because what matters
 * is where the drop target actually is on the page, which role gets one,
 * and that a drop ends up in the same Upload dialog the picker opens —
 * none of which is visible from the hook in isolation (that is tested
 * separately in `hooks/__tests__/use-file-drop-zone.test.tsx`).
 *
 * jsdom has no real drag source, so these synthesise the events a browser
 * would send and supply the `DataTransfer` fields it would populate. That
 * is the limit of what this can prove: the wiring and the gating, not that
 * a Finder drag actually produces this sequence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
const USER = 'u1'

let role = 'owner'

const TREE = [
  { id: 'f-1', name: 'Day 1', parent_id: null, item_count: 0, total_size_bytes: 0, children: [] },
]

const ASSETS = [
  {
    id: 'a-1',
    project_id: PROJECT,
    name: 'Existing clip',
    status: 'in_review',
    asset_type: 'video',
    folder_id: null,
    created_at: new Date().toISOString(),
  },
]

let folderParam: string | null = null

const get = vi.fn(async (path: string) => {
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/assets?')) return ASSETS
  if (path === `/projects/${PROJECT}`) return { id: PROJECT, name: 'Rope Challenge' }
  if (path.includes('/members')) return [{ user_id: USER, role }]
  // Shape matters: useTrash falls back to {folders, assets} only when the
  // response is undefined, so a bare [] crashes the trash view.
  if (path.endsWith('/trash')) return { folders: [], assets: [] }
  return []
})

vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(async () => ({ id: 'new' })),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PROJECT }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(folderParam ? `folder=${folderParam}` : ''),
  usePathname: () => `/projects/${PROJECT}`,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { id: USER, name: 'Tester', email: 't@e.com' },
    isSuperAdmin: false,
  }),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ comments: [], isLoading: false, mutate: vi.fn() }),
}))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))

import ProjectPage from '../page'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'

// ─── Fakes the browser would supply ──────────────────────────────────────

function mp4(name: string) {
  return new File(['x'], name, { type: 'video/mp4' })
}

function fileEntry(name: string): FileSystemEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file: (ok: (f: File) => void) => ok(mp4(name)),
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
        readEntries: (cb: (e: FileSystemEntry[]) => void) => {
          cb(done ? [] : children)
          done = true
        },
      }
    },
  } as unknown as FileSystemEntry
}

function fileDrag(entries: FileSystemEntry[] = []) {
  return {
    types: ['Files'],
    items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
    files: [],
    dropEffect: '',
    getData: () => '',
  } as unknown as DataTransfer
}

/**
 * A drag whose entries can only be read once, like a real one.
 *
 * The browser invalidates `webkitGetAsEntry` as soon as the first handler
 * returns, so a SECOND handler for the same drop sees nothing and falls
 * back to `dataTransfer.files`. Giving the two sources different filenames
 * is what makes "only one handler ran" observable: if the page also handled
 * a drop meant for the dialog, the dialog ends up listing the fallback
 * name, not the entry's.
 */
function oneShotFileDrag(entryName: string, fallbackName: string) {
  const entry = fileEntry(entryName)
  let spent = false
  return {
    types: ['Files'],
    items: [
      {
        kind: 'file',
        webkitGetAsEntry: () => {
          if (spent) return null
          spent = true
          return entry
        },
      },
    ],
    files: [mp4(fallbackName)],
    dropEffect: '',
    getData: () => '',
  } as unknown as DataTransfer
}

function internalDrag() {
  return {
    types: ['application/json'],
    items: [],
    files: [],
    dropEffect: '',
    getData: () => JSON.stringify({ assetIds: ['a-1'], folderIds: [] }),
  } as unknown as DataTransfer
}

// ─── Harness ─────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

/** The main section — the flex child the container query is established on,
 *  which is the element §223 C makes a drop target. */
function mainArea() {
  const el = document.querySelector('.asset-grid-container')
  if (!el) throw new Error('main content area not found')
  return el as HTMLElement
}

function overlay() {
  return screen.queryByTestId('project-file-drop-overlay')
}

/** Waits until the page has its role, so permission gates are settled. */
async function ready() {
  await waitFor(() => expect(mainArea()).toBeTruthy())
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/members`))
}

beforeEach(() => {
  role = 'owner'
  folderParam = null
  get.mockClear()
  useBreadcrumbStore.setState({ labels: {}, extraCrumbs: [] })
})

// ─── C.1 / C.2 — the target and the highlight ───────────────────────────

describe('§223 C.1 — the whole main view accepts an OS drop', () => {
  it('highlights the main area, naming the project it will upload into', async () => {
    renderPage()
    await ready()

    expect(overlay()).toBeNull()
    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })

    await waitFor(() => expect(overlay()).toBeTruthy())
    expect(overlay()).toHaveTextContent('Drop to upload to Rope Challenge')
  })

  it('names the OPEN FOLDER when one is open', async () => {
    folderParam = 'f-1'
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    await waitFor(() => expect(overlay()).toBeTruthy())
    expect(overlay()).toHaveTextContent('Drop to upload to Day 1')
  })

  it('removes the highlight on leave', async () => {
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    await waitFor(() => expect(overlay()).toBeTruthy())
    fireEvent.dragLeave(mainArea(), { dataTransfer: fileDrag() })
    await waitFor(() => expect(overlay()).toBeNull())
  })

  it('keeps the overlay out of the pointer’s way', async () => {
    renderPage()
    await ready()
    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    await waitFor(() => expect(overlay()).toBeTruthy())
    // Taking the pointer would fire dragleave the instant it appeared.
    expect(overlay()?.className).toContain('pointer-events-none')
  })
})

describe('§223 C.2 — internal drags are untouched', () => {
  it('shows no highlight for an asset/folder move', async () => {
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: internalDrag() })
    fireEvent.dragOver(mainArea(), { dataTransfer: internalDrag() })
    await waitFor(() => expect(mainArea()).toBeTruthy())
    expect(overlay()).toBeNull()
  })

  it('does not claim an internal dragover', async () => {
    renderPage()
    await ready()

    const over = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(over, 'dataTransfer', { value: internalDrag() })
    fireEvent(mainArea(), over)
    expect(over.defaultPrevented).toBe(false)
  })
})

// ─── C.3 — the drop reaches the existing upload flow ───────────────────

describe('§223 C.3 — a drop opens the Upload dialog, pre-filled', () => {
  it('lists every file from a dropped folder tree', async () => {
    renderPage()
    await ready()

    const card = dirEntry('Card A', [
      fileEntry('clip1.mp4'),
      dirEntry('Sony', [fileEntry('clip2.mp4')]),
    ])
    fireEvent.drop(mainArea(), { dataTransfer: fileDrag([card]) })

    // The same dialog the Upload button opens, already holding the files.
    await waitFor(() => expect(screen.getByText('Upload asset')).toBeTruthy())
    expect(await screen.findByText('2 files selected')).toBeTruthy()
    expect(screen.getByText('clip1.mp4')).toBeTruthy()
    expect(screen.getByText('clip2.mp4')).toBeTruthy()
  })

  it('offers the keep-structure choice, because a folder was involved', async () => {
    renderPage()
    await ready()

    fireEvent.drop(mainArea(), {
      dataTransfer: fileDrag([dirEntry('Card A', [fileEntry('clip1.mp4')])]),
    })
    await waitFor(() => expect(screen.getByText('Upload asset')).toBeTruthy())
    // The existing control, unchanged — a dropped tree gets the same
    // Keep folders / Flatten choice the folder picker gets.
    expect(await screen.findByRole('button', { name: 'Keep folders' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Flatten' })).toBeTruthy()
    expect(screen.getByText(/came from a folder/i)).toBeTruthy()
  })

  it('applies the camera-junk filter, same as the picker', async () => {
    renderPage()
    await ready()

    fireEvent.drop(mainArea(), {
      dataTransfer: fileDrag([
        dirEntry('Card A', [fileEntry('clip1.mp4'), fileEntry('.DS_Store')]),
      ]),
    })
    await waitFor(() => expect(screen.getByText('Upload asset')).toBeTruthy())
    expect(await screen.findByText('1 file selected')).toBeTruthy()
    expect(screen.queryByText('.DS_Store')).toBeNull()
  })

  it('does not start uploading on its own — the confirm step stays', async () => {
    renderPage()
    await ready()

    fireEvent.drop(mainArea(), { dataTransfer: fileDrag([fileEntry('loose.mp4')]) })
    await waitFor(() => expect(screen.getByText('Upload asset')).toBeTruthy())
    // Nothing moves until this is pressed.
    expect(screen.getByRole('button', { name: /start upload/i })).toBeTruthy()
  })
})

// ─── C.5 — the dialog's own dropzone stays separate ────────────────────

describe('§223 C.5 — a drop inside the Upload dialog does not reach the page', () => {
  it('fills the dialog once, not twice', async () => {
    renderPage()
    await ready()

    // Open the dialog empty, via its own button, so its zone is showing.
    fireEvent.click(await screen.findByRole('button', { name: /^upload$/i }))
    const zone = await screen.findByText(/drag files and folders to upload/i)
    const dropTarget = zone.closest('[role="button"]') as HTMLElement
    expect(dropTarget).toBeTruthy()
    // It really is inside the page's drop target's subtree, which is why
    // stopPropagation is load-bearing rather than incidental.
    expect(document.body.contains(dropTarget)).toBe(true)

    fireEvent.drop(dropTarget, {
      dataTransfer: oneShotFileDrag('inner.mp4', 'page-also-handled-it.mp4'),
    })

    await waitFor(() => expect(screen.getByText('1 file selected')).toBeTruthy())
    expect(screen.getAllByText('inner.mp4')).toHaveLength(1)
    // The discriminating assertion: the page's handler, had it run on this
    // drop too, would have found the entries already spent and fallen back
    // to `files` — overwriting the selection with this name.
    expect(screen.queryByText('page-also-handled-it.mp4')).toBeNull()
    // And the page's own overlay never appeared.
    expect(overlay()).toBeNull()
  })

  it('shows no page highlight while dragging over the dialog’s zone', async () => {
    renderPage()
    await ready()

    fireEvent.click(await screen.findByRole('button', { name: /^upload$/i }))
    const zone = await screen.findByText(/drag files and folders to upload/i)
    const dropTarget = zone.closest('[role="button"]') as HTMLElement

    fireEvent.dragEnter(dropTarget, { dataTransfer: fileDrag() })
    fireEvent.dragOver(dropTarget, { dataTransfer: fileDrag() })
    expect(overlay()).toBeNull()
  })
})

// ─── C.4 — where there must be no drop target ──────────────────────────

describe('§223 C.4 — withheld where uploading is not allowed', () => {
  it('a viewer gets no drop target', async () => {
    role = 'viewer'
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    fireEvent.dragOver(mainArea(), { dataTransfer: fileDrag() })
    expect(overlay()).toBeNull()

    fireEvent.drop(mainArea(), { dataTransfer: fileDrag([fileEntry('a.mp4')]) })
    // No dialog, because there is nothing a viewer could do with it.
    await waitFor(() => expect(mainArea()).toBeTruthy())
    expect(screen.queryByText('Upload asset')).toBeNull()
  })

  it('a reviewer gets no drop target either', async () => {
    role = 'reviewer'
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    expect(overlay()).toBeNull()
  })

  it('an editor does', async () => {
    role = 'editor'
    renderPage()
    await ready()

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    await waitFor(() => expect(overlay()).toBeTruthy())
  })

  it('the Recently Deleted view does not', async () => {
    renderPage()
    await ready()

    fireEvent.click(await screen.findByText('Recently Deleted'))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Recently Deleted' })).toBeTruthy(),
    )

    fireEvent.dragEnter(mainArea(), { dataTransfer: fileDrag() })
    expect(overlay()).toBeNull()
    fireEvent.drop(mainArea(), { dataTransfer: fileDrag([fileEntry('a.mp4')]) })
    expect(screen.queryByText('Upload asset')).toBeNull()
  })
})
