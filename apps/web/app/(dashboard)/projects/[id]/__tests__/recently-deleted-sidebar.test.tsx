/**
 * §241 item 5 — where "Recently Deleted" sits.
 *
 * It was the last child of the folder TREE, which put it wherever the tree
 * happened to end: in a project with a deep tree it was pushed down the
 * column, and it read as though it were a folder. The owner's screenshots
 * show it in the empty strip at the bottom of the sidebar, between Share
 * Links and Storage, in the `xl`+ column and in the phone/tablet panel
 * alike.
 *
 * "Below the tree" and "above Storage" are both true of the old position
 * in a short project, so the assertions here are about DOCUMENT ORDER: the
 * entry comes after every folder row, after the Share Links section, and
 * immediately before the storage block — and it is the LAST thing above
 * it. That is what a class-level or presence-level test would miss.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
const USER = 'u1'

const TREE = [
  {
    id: 'f-1',
    name: 'Day 1',
    parent_id: null,
    item_count: 1,
    total_size_bytes: 0,
    children: [],
  },
]

const get = vi.fn(async (path: string) => {
  if (path.includes('/share-links')) return []
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/assets?')) return []
  if (path === `/projects/${PROJECT}`)
    return { id: PROJECT, name: 'Podcast', storage_bytes: 10, storage_limit_bytes: 100 }
  if (path.includes('/members')) return [{ user_id: USER, role: 'owner' }]
  if (path.includes('/trash')) return { items: [], total: 0, folders: [], assets: [] }
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
  useSearchParams: () => new URLSearchParams(''),
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
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: () => null }))

import ProjectPage from '../page'

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

async function ready() {
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/members`))
}

/** Is `a` before `b` in the document? */
function isBefore(a: Element, b: Element) {
  return Boolean(
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
}

beforeEach(() => {
  get.mockClear()
})

describe('the desktop sidebar column', () => {
  it('puts Recently Deleted last, directly above Storage', async () => {
    renderPage()
    await ready()

    const column = document.querySelector('.hidden.xl\\:flex') as HTMLElement
    expect(column).toBeTruthy()

    const entry = within(column).getByTestId('recently-deleted-entry')
    const storage = within(column).getByTestId('project-storage-meter')
    const folderRow = column.querySelector('[data-tree-folder="f-1"]') as HTMLElement
    const shareLinks = within(column).getAllByText(/share links/i)[0]

    // After the tree and after Share Links…
    expect(isBefore(folderRow, entry)).toBe(true)
    expect(isBefore(shareLinks, entry)).toBe(true)
    // …and immediately before the storage block.
    expect(isBefore(entry, storage)).toBe(true)

    // The LAST thing above Storage: nothing else in the column sits
    // between the two.
    const between = Array.from(column.querySelectorAll('*')).filter(
      (el) =>
        isBefore(entry, el) &&
        isBefore(el, storage) &&
        !entry.contains(el) &&
        (el.textContent ?? '').trim().length > 0,
    )
    expect(between).toEqual([])
  })

  it('no longer renders it inside the folder tree', async () => {
    renderPage()
    await ready()

    const entry = screen.getAllByTestId('recently-deleted-entry')[0]
    const tree = document.querySelector('[data-tree-folder="f-1"]')!.parentElement!
      .parentElement!
    expect(tree.contains(entry)).toBe(false)
  })

  it('still opens the view and marks itself current', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const column = document.querySelector('.hidden.xl\\:flex') as HTMLElement
    const entry = within(column).getByTestId('recently-deleted-entry')
    await user.click(entry)

    expect(await screen.findByTestId('recently-deleted')).toBeInTheDocument()
    expect(within(column).getByTestId('recently-deleted-entry')).toHaveAttribute(
      'aria-current',
      'true',
    )
  })
})

describe('the phone/tablet navigator panel', () => {
  it('puts it in the same place: last above Storage', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    // The panel is closed until the folder trigger is used.
    await user.click(screen.getByTestId('folder-navigator-trigger'))
    const extra = await screen.findByTestId('folder-navigator-extra')

    const entry = within(extra).getByTestId('recently-deleted-entry')
    const storage = within(extra).getByTestId('project-storage-meter')
    const shareLinks = within(extra).getAllByText(/share links/i)[0]

    expect(isBefore(shareLinks, entry)).toBe(true)
    expect(isBefore(entry, storage)).toBe(true)

    const between = Array.from(extra.querySelectorAll('*')).filter(
      (el) =>
        isBefore(entry, el) &&
        isBefore(el, storage) &&
        !entry.contains(el) &&
        (el.textContent ?? '').trim().length > 0,
    )
    expect(between).toEqual([])
  })

  it('opens the view and closes the panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    await user.click(screen.getByTestId('folder-navigator-trigger'))
    const extra = await screen.findByTestId('folder-navigator-extra')
    await user.click(within(extra).getByTestId('recently-deleted-entry'))

    expect(await screen.findByTestId('recently-deleted')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-extra')).not.toBeInTheDocument(),
    )
  })
})
