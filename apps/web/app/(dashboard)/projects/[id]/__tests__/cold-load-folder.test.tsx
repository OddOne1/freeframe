/**
 * Landing straight on ?folder={id} opens that folder, with its full crumb
 * trail (§179).
 *
 * This is the other half of the back-arrow fix: the arrow now points at
 * `/projects/{id}?folder={deep}`, which is only useful if arriving there
 * cold — no clicking down through the tree, no history — renders the same
 * thing as having walked there. §29 made `currentFolderId` a derivation of
 * the URL, which should give this for free, and the share viewer builds its
 * breadcrumbs from a single folder id the same way. "Should" is why this
 * test exists.
 *
 * The page is rendered for real, with the API stubbed, so what is asserted
 * is which folder it actually asks for and which crumbs it actually
 * publishes — not the shape of its source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
// Two levels deep, which is the case the bug report named: back landed at
// the root, and a one-level-up fix would still be wrong here.
const TREE = [
  {
    id: 'f-parent',
    name: 'Rope Challenge',
    parent_id: null,
    children: [
      {
        id: 'f-child',
        name: 'Day 2',
        parent_id: 'f-parent',
        children: [{ id: 'f-grandchild', name: 'Rushes', parent_id: 'f-child', children: [] }],
      },
    ],
  },
]

const DEEP = 'f-grandchild'

let folderParam: string | null = DEEP
const requested: string[] = []

const get = vi.fn(async (path: string) => {
  requested.push(path)
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/assets?')) return []
  if (path === `/projects/${PROJECT}`) return { id: PROJECT, name: 'Rope Challenge', role: 'owner' }
  if (path.includes('/members')) return []
  return []
})

vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: vi.fn(async () => ({})),
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
  useAuthStore: () => ({ user: { id: 'u1', name: 'Tester', email: 't@e.com' }, isSuperAdmin: false }),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ comments: [], isLoading: false, mutate: vi.fn() }),
}))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: () => null }))

import ProjectPage from '../page'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

beforeEach(() => {
  folderParam = DEEP
  requested.length = 0
  get.mockClear()
  useBreadcrumbStore.setState({ labels: {}, extraCrumbs: [] })
})

describe('arriving cold on a deep ?folder=', () => {
  it('asks the API for that folder, not the root', async () => {
    renderPage()

    await waitFor(() =>
      expect(requested.some((p) => p.includes(`folder_id=${DEEP}`))).toBe(true),
    )
    expect(requested.some((p) => p.includes('folder_id=root'))).toBe(false)
  })

  it('publishes the whole ancestor trail, not just the folder itself', async () => {
    renderPage()

    await waitFor(() =>
      expect(useBreadcrumbStore.getState().extraCrumbs.length).toBe(3),
    )
    expect(useBreadcrumbStore.getState().extraCrumbs.map((c) => c.label)).toEqual([
      'Rope Challenge',
      'Day 2',
      'Rushes',
    ])
  })

  it('gives every crumb a link back to its own level', async () => {
    renderPage()

    await waitFor(() => expect(useBreadcrumbStore.getState().extraCrumbs.length).toBe(3))
    expect(useBreadcrumbStore.getState().extraCrumbs.map((c) => c.href)).toEqual([
      `/projects/${PROJECT}?folder=f-parent`,
      `/projects/${PROJECT}?folder=f-child`,
      `/projects/${PROJECT}?folder=${DEEP}`,
    ])
  })

  it('the deepest crumb is exactly where the back arrow points', async () => {
    /* Ties the two halves together: the href the viewer renders and the
       crumb this page ends up showing have to be the same string. */
    renderPage()

    await waitFor(() => expect(useBreadcrumbStore.getState().extraCrumbs.length).toBe(3))
    const crumbs = useBreadcrumbStore.getState().extraCrumbs
    expect(crumbs[crumbs.length - 1].href).toBe(`/projects/${PROJECT}?folder=${DEEP}`)
  })
})

describe('arriving with no ?folder=', () => {
  it('shows the project root and no folder crumbs', async () => {
    folderParam = null
    renderPage()

    await waitFor(() =>
      expect(requested.some((p) => p.includes('folder_id=root'))).toBe(true),
    )
    expect(useBreadcrumbStore.getState().extraCrumbs).toEqual([])
  })
})
