/**
 * §228d item 3, on the real page: the folder view's Back button points at
 * the PARENT of the folder that is open.
 *
 * The component test next door proves the control; this one proves the
 * wiring, which is the part that can silently go wrong: the parent is read
 * off `folderTrail` — the single walk of the tree the header breadcrumb,
 * the folder navigator and the drop overlay already share (§227) — so a
 * second lookup cannot drift from them. The page is rendered for real with
 * the API stubbed, exactly as cold-load-folder.test.tsx does, because what
 * is being checked is which URL it actually renders from a tree it
 * actually fetched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'

// Three levels, so a one-level-up answer and a "go to the root" answer are
// different strings.
const TREE = [
  {
    id: 'f-parent', name: 'Rope Challenge', parent_id: null, item_count: 3,
    total_size_bytes: 0,
    children: [
      {
        id: 'f-child', name: 'Day 2', parent_id: 'f-parent', item_count: 2,
        total_size_bytes: 0,
        children: [
          { id: 'f-grandchild', name: 'Rushes', parent_id: 'f-child', item_count: 1, total_size_bytes: 0, children: [] },
        ],
      },
    ],
  },
]

let folderParam: string | null = 'f-grandchild'

const get = vi.fn(async (path: string) => {
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/assets?')) return []
  if (path === `/projects/${PROJECT}`) return { id: PROJECT, name: 'Just Ride 2026', role: 'owner' }
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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
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

const back = () => screen.getByTestId('folder-back') as HTMLAnchorElement

beforeEach(() => {
  folderParam = 'f-grandchild'
  get.mockClear()
  useBreadcrumbStore.setState({ labels: {}, extraCrumbs: [] })
})

describe('§228d item 3 — Back on the folder page', () => {
  it('goes up ONE level from a folder two levels down', async () => {
    renderPage()
    await waitFor(() =>
      expect(back().getAttribute('href')).toBe(`/projects/${PROJECT}?folder=f-child`),
    )
    expect(back().getAttribute('aria-label')).toBe('Back to Day 2')
  })

  it('does not drop the user at the project root from a deep folder', async () => {
    renderPage()
    await waitFor(() => expect(back().getAttribute('href')).toContain('?folder='))
    expect(back().getAttribute('href')).not.toBe(`/projects/${PROJECT}`)
  })

  it('goes to the project root from a top-level folder, named after it', async () => {
    folderParam = 'f-parent'
    renderPage()
    await waitFor(() =>
      expect(back().getAttribute('href')).toBe(`/projects/${PROJECT}`),
    )
    expect(back().getAttribute('aria-label')).toBe('Back to Just Ride 2026')
  })

  it('is SHOWN at the project root, and goes to the projects list', async () => {
    folderParam = null
    renderPage()
    await waitFor(() => expect(back()).toBeTruthy())
    expect(back().getAttribute('href')).toBe('/projects')
    expect(back().getAttribute('aria-label')).toBe('Back to Projects')
  })

  it('points exactly where the breadcrumb for that level points', async () => {
    /* The two are built from the same trail; this is what keeps them from
       disagreeing after a future edit to one of them. */
    renderPage()
    await waitFor(() => expect(useBreadcrumbStore.getState().extraCrumbs.length).toBe(3))
    const crumbs = useBreadcrumbStore.getState().extraCrumbs
    expect(back().getAttribute('href')).toBe(crumbs[crumbs.length - 2].href)
  })
})
