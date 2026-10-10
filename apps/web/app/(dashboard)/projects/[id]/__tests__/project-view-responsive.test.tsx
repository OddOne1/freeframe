/**
 * The project view at every width (§224).
 *
 * The reported bug, in the owner's words: "on all pages, below a certain
 * width the right sidebar cannot be expanded anymore." Two separate causes,
 * both in this page:
 *
 *   - the right panel was `hidden xl:flex`, so below 1280px the toolbar's
 *     toggle flipped a flag that changed nothing — a dead button;
 *   - the folder tree was `hidden lg:flex` with NO replacement, so below
 *     1024px subfolders could not be reached at all.
 *
 * jsdom applies no media queries, so these cannot prove what a browser
 * paints. What they CAN prove is the part a CSS-only reading would miss and
 * the part that regressed: that the panel is one element which is never
 * `hidden` below `xl`, that it starts closed there, that the tree is
 * reachable through the top sheet with its menu intact, and that the three
 * phone panes switch. Where an assertion is about a class, it is about a
 * class that encodes a decision (`fixed` vs `static`, `max-md:` vs `md:`),
 * not about spelling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
const USER = 'u1'

let role = 'owner'
let folderParam: string | null = null

const TREE = [
  {
    id: 'f-1',
    name: 'Day 1',
    parent_id: null,
    item_count: 1,
    total_size_bytes: 0,
    children: [
      {
        id: 'f-1a',
        name: 'Rushes',
        parent_id: 'f-1',
        item_count: 0,
        total_size_bytes: 0,
        children: [],
      },
    ],
  },
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

const get = vi.fn(async (path: string) => {
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/assets?')) return ASSETS
  if (path === `/projects/${PROJECT}`) return { id: PROJECT, name: 'Podcast' }
  if (path.includes('/members')) return [{ user_id: USER, role }]
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

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PROJECT }),
  useRouter: () => ({ push: (...a: unknown[]) => push(...a), replace: vi.fn(), back: vi.fn() }),
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
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: () => null }))

import ProjectPage from '../page'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useViewStore } from '@/stores/view-store'

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

const panel = () => screen.getByTestId('project-right-panel')
const settingsPane = () => screen.getByTestId('project-settings-pane')
const tabBar = () => screen.getByTestId('mobile-tab-bar')
/** Scoped, because "Assets" is also the sidebar's section heading and
 *  "settings" also matches the actions menu's "Project settings". */
const tab = (name: RegExp) => within(tabBar()).getByRole('button', { name })

/** Does this element's class list ever resolve to `display: none` in the
 *  band Tailwind's `max-md:`/`md:` prefixes name? */
function displayClasses(el: HTMLElement) {
  return el.className.split(/\s+/).filter((c) => /(^|:)(hidden|flex)$/.test(c))
}

async function ready() {
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/members`))
}

beforeEach(() => {
  role = 'owner'
  folderParam = null
  get.mockClear()
  push.mockClear()
  useBreadcrumbStore.setState({ labels: {}, extraCrumbs: [] })
  useViewStore.setState({ rightPanelOpen: true, flattenFolders: false, layout: 'grid' })
})

// ─── The reported bug: the panel below xl ────────────────────────────────

describe('§224 — the right panel is ONE element, never hidden below xl', () => {
  it('renders exactly one panel, not a desktop and a mobile copy', async () => {
    renderPage()
    await ready()
    expect(screen.getAllByTestId('project-right-panel')).toHaveLength(1)
  })

  it('is an overlay below xl and a column at xl — the same element', async () => {
    renderPage()
    await ready()
    const cls = panel().className
    // Below md: a full-screen pane. md–xl: a right drawer. xl+: in flow.
    expect(cls).toMatch(/max-md:fixed/)
    expect(cls).toMatch(/md:max-xl:fixed/)
    expect(cls).toMatch(/md:max-xl:right-0/)
    expect(cls).toMatch(/xl:static/)
  })

  it('never carries a bare `hidden`, which is what made the toggle dead', async () => {
    renderPage()
    await ready()
    // The old markup was `hidden xl:flex`: hidden at every width under
    // 1280px, so `rightPanelOpen` had nothing to show.
    expect(panel().className.split(/\s+/)).not.toContain('hidden')
  })

  it('decides visibility in two disjoint media bands', async () => {
    renderPage()
    await ready()
    // Why this matters: `flex` and `hidden` in the SAME band would leave
    // the outcome to Tailwind's class ordering instead of to this code.
    const classes = displayClasses(panel())
    const bands = classes.map((c) => c.split(':').slice(0, -1).join(':') || 'base')
    expect(new Set(bands).size).toBe(bands.length)
    expect(bands.sort()).toEqual(['max-md', 'md'])
  })

  it('the panel is gone from the layout when closed, at md and up', async () => {
    useViewStore.setState({ rightPanelOpen: false })
    renderPage()
    await ready()
    expect(displayClasses(panel())).toContain('md:hidden')
  })

  it('the toggle in the store is what opens it', async () => {
    useViewStore.setState({ rightPanelOpen: false })
    renderPage()
    await ready()
    expect(displayClasses(panel())).toContain('md:hidden')

    useViewStore.setState({ rightPanelOpen: true })
    await waitFor(() => expect(displayClasses(panel())).toContain('md:flex'))
  })

  it('gets a scrim, in the drawer band only', async () => {
    renderPage()
    await ready()
    const scrim = screen.getByTestId('right-panel-scrim')
    // Not below md (the pane is full-screen with the tab bar still visible)
    // and not at xl (it is a column, nothing is overlaid).
    expect(scrim.className).toMatch(/md:max-xl:block/)
    expect(scrim.className).toMatch(/\bhidden\b/)
  })

  it('the scrim closes the drawer', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(screen.getByTestId('right-panel-scrim'))
    await waitFor(() => expect(useViewStore.getState().rightPanelOpen).toBe(false))
  })

  it('offers a close button below xl, since the toggle is behind the scrim', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const close = screen.getByRole('button', { name: 'Close panel' })
    expect(close.className).toMatch(/xl:hidden/)
    await user.click(close)
    await waitFor(() => expect(useViewStore.getState().rightPanelOpen).toBe(false))
  })
})

// ─── The other half: the folder tree ────────────────────────────────────

describe('§224 — folders are reachable at every width', () => {
  it('the sidebar column is xl-only now, not lg-only', async () => {
    renderPage()
    await ready()
    const column = document.querySelector('.w-72')
    expect(column).toBeTruthy()
    // `lg` meant the column appeared at 1024px, where it cost the grid too
    // much; below it there was nothing at all.
    expect((column as HTMLElement).className).toMatch(/hidden xl:flex/)
  })

  it('the project name is a trigger that opens the tree', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const trigger = await screen.findByTestId('folder-tree-sheet-trigger')
    expect(trigger).toHaveTextContent('Podcast')
    expect(trigger.className).toMatch(/h-11/)

    await user.click(trigger)
    const sheet = await screen.findByTestId('folder-tree-sheet')
    expect(sheet).toBeTruthy()
    // The real tree, with its rows.
    expect(await screen.findAllByText('Day 1')).not.toHaveLength(0)
  })

  it('the trigger names the OPEN folder, not just the project', async () => {
    folderParam = 'f-1a'
    renderPage()
    await ready()
    const trigger = await screen.findByTestId('folder-tree-sheet-trigger')
    await waitFor(() => expect(trigger).toHaveTextContent('Rushes'))
  })

  it('the sheet carries §223’s per-folder menu, because it reuses FolderTree', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-tree-sheet-trigger'))
    await screen.findByTestId('folder-tree-sheet')

    const sheet = screen.getByTestId('folder-tree-sheet')
    await user.click(within(sheet).getByRole('button', { name: 'Folder options for Day 1' }))
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
        'Rename',
        'New Subfolder',
        'Create share link',
        'Delete',
      ]),
    )
  })

  it('picking a folder navigates and closes the sheet', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-tree-sheet-trigger'))
    await screen.findByTestId('folder-tree-sheet')

    // Scoped to the sheet: jsdom renders the sidebar column's tree too,
    // because it applies no media queries.
    const sheet = screen.getByTestId('folder-tree-sheet')
    await user.click(within(sheet).getByText('Day 1'))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(String(push.mock.calls[0][0])).toContain('folder=f-1')
    await waitFor(() =>
      expect(screen.queryByTestId('folder-tree-sheet')).not.toBeInTheDocument(),
    )
  })

  it('the header row it lives in is hidden at xl, where the column is back', async () => {
    renderPage()
    await ready()
    const row = (await screen.findByTestId('folder-tree-sheet-trigger')).parentElement
    expect((row as HTMLElement).className).toMatch(/xl:hidden/)
  })
})

// ─── The phone layout ───────────────────────────────────────────────────

describe('§224 — the three phone tabs', () => {
  it('renders a tab bar, phones only', async () => {
    renderPage()
    await ready()
    expect(tabBar().className).toMatch(/md:hidden/)
    expect(
      screen.getAllByRole('button').filter((b) => tabBar().contains(b)).length,
    ).toBe(3)
  })

  it('starts on Assets', async () => {
    renderPage()
    await ready()
    const assets = tab(/^assets$/i)
    expect(assets).toHaveAttribute('aria-current', 'page')
    expect(displayClasses(settingsPane())).toContain('max-md:hidden')
    expect(displayClasses(panel())).toContain('max-md:hidden')
  })

  it('Comments shows the panel pane and hides the grid', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const grid = document.querySelector('.asset-grid-container') as HTMLElement

    await user.click(tab(/^comments$/i))
    await waitFor(() => expect(displayClasses(panel())).toContain('max-md:flex'))
    expect(displayClasses(grid)).toContain('max-md:hidden')
    // …and the desktop band is untouched by the tab.
    expect(displayClasses(grid)).toContain('md:flex')
  })

  it('Settings shows the settings pane', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(tab(/^settings$/i))
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:flex'))
    expect(screen.getByText('View settings')).toBeTruthy()
  })

  it('switching back to Assets restores the grid', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const grid = document.querySelector('.asset-grid-container') as HTMLElement
    await user.click(tab(/^settings$/i))
    await waitFor(() => expect(displayClasses(grid)).toContain('max-md:hidden'))
    await user.click(tab(/^assets$/i))
    await waitFor(() => expect(displayClasses(grid)).toContain('max-md:flex'))
  })

  it('every tab is at least 44px tall', async () => {
    renderPage()
    await ready()
    for (const b of screen.getAllByRole('button').filter((b) => tabBar().contains(b))) {
      // h-14 = 56px.
      expect(b.className).toMatch(/\bh-14\b/)
    }
  })

  it('pads itself past the home indicator', async () => {
    renderPage()
    await ready()
    // viewport-fit=cover (root layout) is what makes this inset non-zero;
    // without the padding the labels sit under the iPhone home indicator.
    expect(tabBar().className).toContain('pb-[env(safe-area-inset-bottom)]')
  })
})

describe('§224 — the Settings tab drives the same store as the toolbar', () => {
  it('the card-size control writes the key the Appearance popover writes', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(tab(/^settings$/i))
    await screen.findByText('View settings')

    expect(useViewStore.getState().cardSize).toBe('M')
    await user.click(screen.getByRole('button', { name: 'XS' }))
    // The same store, the same key — not a parallel mobile preference.
    await waitFor(() => expect(useViewStore.getState().cardSize).toBe('XS'))
  })

  it('asset size is the FIRST control in the pane', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(tab(/^settings$/i))
    const pane = settingsPane()
    const labels = Array.from(pane.querySelectorAll('span.text-sm')).map((e) => e.textContent)
    expect(labels[0]).toBe('Card Size')
    expect(labels.indexOf('Card Size')).toBeLessThan(labels.indexOf('Layout'))
  })

  it('also offers sort, which the toolbar popover owns on desktop', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(tab(/^settings$/i))
    await screen.findByText('Sort by')
    await user.click(screen.getByRole('button', { name: /^Name$/ }))
    await waitFor(() => expect(useViewStore.getState().sortKey).toBe('name'))
  })
})

// ─── Toolbar actions on a phone ────────────────────────────────────────

describe('§224 — the toolbar actions reach a phone', () => {
  it('the "···" menu is phones-only — at md+ the toolbar buttons fit', async () => {
    renderPage()
    await ready()
    // Offering both on a 768px tablet would be two routes to one set of
    // five actions on the same screen.
    expect((await screen.findByTestId('project-actions-menu')).className).toMatch(/md:hidden/)
  })

  it('a "···" menu offers Upload, New Folder and Share', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('project-actions-menu'))
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
        'Upload',
        'New Folder',
        'Share',
        'Members',
        'Project settings',
      ]),
    )
  })

  it('offers a viewer nothing, so no empty menu is rendered', async () => {
    role = 'viewer'
    renderPage()
    await ready()
    await waitFor(() => expect(screen.queryByTestId('project-actions-menu')).toBeNull())
  })

  it('the desktop toolbar group is md-and-up only', async () => {
    renderPage()
    await ready()
    const upload = await screen.findByRole('button', { name: /^upload$/i })
    const group = upload.closest('div')
    // `md:contents`, not `md:flex`: the wrapper has to DISSOLVE at md+ so
    // the buttons are the bar's own flex children and the desktop row is
    // laid out exactly as it was. A real flex wrapper shifted it 4px.
    expect((group as HTMLElement).className).toMatch(/hidden md:contents/)
  })
})

// ─── Touch ─────────────────────────────────────────────────────────────

describe('§224 — hover-only controls are reachable without hover', () => {
  it('the folder row kebab is visible under `hover: none`', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-tree-sheet-trigger'))
    await screen.findByTestId('folder-tree-sheet')

    const kebab = within(screen.getByTestId('folder-tree-sheet')).getByRole('button', {
      name: 'Folder options for Day 1',
    })
    // `opacity-0 group-hover:opacity-100` alone means permanently invisible
    // on a touch screen, and the rename / share actions unreachable.
    expect(kebab.className).toMatch(/hover-none:opacity-100/)
  })
})
