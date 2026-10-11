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
 * `hidden` below `xl`, that it starts closed there, and that the tree is
 * reachable through the navigator with its menu intact. Where an assertion
 * is about a class, it is about a class that encodes a decision (`fixed`
 * vs `static`, `max-md:` vs `md:`), not about spelling.
 *
 * §227 item 3 — the three phone tabs are gone. The owner's decision:
 * Assets / Comments / Settings only make sense INSIDE an asset, so the
 * project view has no bottom tab bar, no Comments pane and no Settings
 * tab; the view settings are a cogwheel in the global header, left of
 * search. The sections at the foot of this file assert the absence as
 * well as the replacement — "no tab bar" is half the fix, and the half a
 * test for the cogwheel alone would not catch.
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
import { Header } from '@/components/layout/header'
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useViewStore } from '@/stores/view-store'
import {
  useMobileViewSettingsStore,
  pathHasMobileViewSettings,
} from '@/stores/mobile-view-settings-store'

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

/**
 * The page WITH the global header above it, as DashboardShell mounts them
 * (§227). The cogwheel that opens the settings pane is in the Header and
 * the pane is in the page, so neither alone can answer "does the button
 * open the pane" — that is the whole reason the flag is in a store.
 */
function renderShell() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Header onSearchOpen={() => {}} onMobileNavOpen={() => {}} />
      <ProjectPage />
    </SWRConfig>,
  )
}

const panel = () => screen.getByTestId('project-right-panel')
const settingsPane = () => screen.getByTestId('project-settings-pane')
const cogwheel = () => screen.getByTestId('header-view-settings')
const searchButton = () => screen.getByRole('button', { name: /^Search/ })

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
  useBreadcrumbStore.setState({ pathname: null, labels: {}, extraCrumbs: [] })
  useViewStore.setState({
    rightPanelOpen: true,
    flattenFolders: false,
    layout: 'grid',
    cardSize: 'M',
    sortKey: 'date',
  })
  useMobileViewSettingsStore.setState({ open: false })
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
    // md–xl: a right drawer. xl+: in flow. §227 removed the third
    // behaviour, the full-screen phone pane — see the §227 section below.
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

describe('§224/§227 — folders are reachable at every width', () => {
  it('the sidebar column is xl-only now, not lg-only', async () => {
    renderPage()
    await ready()
    const column = document.querySelector('.w-72')
    expect(column).toBeTruthy()
    // `lg` meant the column appeared at 1024px, where it cost the grid too
    // much; below it there was nothing at all.
    expect((column as HTMLElement).className).toMatch(/hidden xl:flex/)
  })

  it('the navigator bar names where you are and opens the tree', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()

    const trigger = await screen.findByTestId('folder-navigator-trigger')
    expect(trigger).toHaveTextContent('Podcast')
    expect(trigger.className).toMatch(/h-11/)
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await user.click(trigger)
    expect(await screen.findByTestId('folder-navigator-panel')).toBeTruthy()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    // The real tree, with its rows.
    expect(await screen.findAllByText('Day 1')).not.toHaveLength(0)
  })

  it('the bar names the OPEN folder, with the project as its prefix', async () => {
    folderParam = 'f-1a'
    renderPage()
    await ready()
    const trigger = await screen.findByTestId('folder-navigator-trigger')
    // "Podcast / Day 1 / Rushes" — the owner's "Just Ride 2026 / Podcast"
    // shape, and the open folder is the part that must always be legible.
    await waitFor(() => expect(trigger).toHaveTextContent('Rushes'))
    expect(trigger).toHaveTextContent('Podcast')
    expect(trigger).toHaveTextContent('Day 1')
    // The accessible name carries the unabbreviated path.
    expect(trigger).toHaveAttribute('aria-label', 'Folders: Podcast / Day 1 / Rushes')
  })

  it('with no folder open the path is the project name', async () => {
    renderPage()
    await ready()
    const trigger = await screen.findByTestId('folder-navigator-trigger')
    await waitFor(() => expect(trigger).toHaveAttribute('aria-label', 'Folders: Podcast'))
  })

  it('the panel carries §223’s per-folder menu, because it reuses FolderTree', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    await screen.findByTestId('folder-navigator-panel')

    const panelEl = screen.getByTestId('folder-navigator-panel')
    await user.click(within(panelEl).getByRole('button', { name: 'Folder options for Day 1' }))
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
        'Rename',
        'New Subfolder',
        'Create share link',
        'Delete',
      ]),
    )
  })

  it('picking a folder navigates and closes the panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    await screen.findByTestId('folder-navigator-panel')

    // Scoped to the panel: jsdom renders the sidebar column's tree too,
    // because it applies no media queries.
    const panelEl = screen.getByTestId('folder-navigator-panel')
    await user.click(within(panelEl).getByText('Day 1'))
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(String(push.mock.calls[0][0])).toContain('folder=f-1')
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )
  })

  it('the bar itself closes it, and so do the scrim and Escape', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const trigger = await screen.findByTestId('folder-navigator-trigger')

    // The bar again.
    await user.click(trigger)
    await screen.findByTestId('folder-navigator-panel')
    await user.click(trigger)
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )

    // The scrim.
    await user.click(trigger)
    await user.click(screen.getByTestId('folder-navigator-scrim'))
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )

    // Escape.
    await user.click(trigger)
    await screen.findByTestId('folder-navigator-panel')
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )
  })

  it('and there is no ✕ and no title bar to close it with', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    const panelEl = await screen.findByTestId('folder-navigator-panel')
    // §224's sheet had a "FOLDERS ✕" header, which is what made it read as
    // a floating dialog rather than part of the bar.
    expect(within(panelEl).queryByRole('button', { name: /close folders/i })).toBeNull()
    expect(within(panelEl).queryByText(/^folders$/i)).toBeNull()
  })

  it('is attached to the bar, not centred or floating', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    const panelEl = await screen.findByTestId('folder-navigator-panel')
    const bar = screen.getByTestId('folder-navigator')

    // A child of the bar, positioned from the bar's bottom edge and the
    // bar's full width — not a portal into document.body (which is what
    // made §224's Radix Dialog float) and not `fixed`.
    expect(bar.contains(panelEl)).toBe(true)
    expect(panelEl.className).toMatch(/\babsolute\b/)
    expect(panelEl.className).toMatch(/\btop-full\b/)
    expect(panelEl.className).toMatch(/\binset-x-0\b/)
    expect(panelEl.className.split(/\s+/)).not.toContain('fixed')
  })

  it('wears the header’s colours, not the content area’s', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const bar = screen.getByTestId('folder-navigator')
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    const panelEl = await screen.findByTestId('folder-navigator-panel')
    // The same three tokens header.tsx uses, so a Branding override moves
    // the bar with the header instead of leaving it behind.
    for (const el of [bar, panelEl]) {
      expect(el.className).toMatch(/bg-nav-bg/)
      expect(el.className).toMatch(/border-nav-border/)
    }
    expect(screen.getByTestId('folder-navigator-trigger').innerHTML).toMatch(/text-nav-text/)
  })

  it('scrolls inside itself rather than running off the screen', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    const panelEl = await screen.findByTestId('folder-navigator-panel')
    expect(panelEl.className).toContain('max-h-[min(60dvh,calc(100dvh-5.5rem))]')
    expect(panelEl.className).toMatch(/overflow-y-auto/)
  })

  it('the scrim starts below the bar, so the bar stays live', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    const scrim = await screen.findByTestId('folder-navigator-scrim')
    // `top-full` of the bar, and painted UNDER the panel — so what reads as
    // dimmed is the content below the panel and nothing else.
    expect(scrim.className).toMatch(/\btop-full\b/)
    const z = (el: HTMLElement) => Number(el.className.match(/\bz-(\d+)\b/)![1])
    expect(z(screen.getByTestId('folder-navigator-panel'))).toBeGreaterThan(z(scrim))
  })

  it('the chevron rotates when open', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const chevron = screen.getByTestId('folder-navigator-chevron')
    expect(chevron.getAttribute('class')).not.toMatch(/rotate-180/)
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    await waitFor(() => expect(chevron.getAttribute('class')).toMatch(/rotate-180/))
  })

  it('the bar is hidden at xl, where the column is back', async () => {
    renderPage()
    await ready()
    expect(screen.getByTestId('folder-navigator').className).toMatch(/xl:hidden/)
  })
})

// ─── The phone layout (§227) ────────────────────────────────────────────

describe('§227 — the project view has no bottom tab bar', () => {
  it('mounts none at all', async () => {
    renderPage()
    await ready()
    // Not "hidden below md": absent. §224's bar offered Comments and
    // Settings tabs on a screen where neither belongs, and the 56px it
    // cost the grid is the space §227 reclaims.
    expect(screen.queryByTestId('mobile-tab-bar')).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Project views' })).toBeNull()
  })

  it('and no Comments pane for it to switch to', async () => {
    renderPage()
    await ready()
    // The panel still exists as the md+ drawer/column — that is §224's fix
    // and it stays — but below `md` it is gone, and there is no control on
    // this screen that could open it.
    expect(displayClasses(panel())).toContain('max-md:hidden')
    expect(displayClasses(panel())).not.toContain('max-md:flex')
    expect(screen.queryByRole('button', { name: /go to assets/i })).toBeNull()
  })

  it('leaves the md-and-up bands exactly as §224 built them', async () => {
    renderPage()
    await ready()
    const cls = panel().className
    expect(cls).toMatch(/md:max-xl:fixed/)
    expect(cls).toMatch(/md:max-xl:right-0/)
    expect(cls).toMatch(/xl:static/)
    // Still never a bare `hidden`, which is what made the toggle dead.
    expect(cls.split(/\s+/)).not.toContain('hidden')
  })

  it('the grid is the content area at every width, not one of three panes', async () => {
    renderPage()
    await ready()
    const grid = document.querySelector('.asset-grid-container') as HTMLElement
    // No `max-md:hidden` to switch it off, and nothing conditional left.
    expect(displayClasses(grid)).toEqual(['flex'])
  })

  it('reclaims the bar’s 56px from the grid’s bottom padding', async () => {
    renderPage()
    await ready()
    const scroller = document.querySelector('.asset-grid-container .overflow-y-auto') as HTMLElement
    // 3.5rem was the bar. The home-indicator inset stays: this scroll area
    // now reaches the bottom edge of the screen itself.
    expect(scroller.className).not.toMatch(/3\.5rem/)
    expect(scroller.className).toContain('max-md:pb-[calc(1.5rem+env(safe-area-inset-bottom))]')
  })

  it('and from the settings pane, which pads only for the home indicator', async () => {
    renderPage()
    await ready()
    expect(settingsPane().className).not.toMatch(/3\.5rem/)
    expect(settingsPane().className).toContain('max-md:pb-[env(safe-area-inset-bottom)]')
  })
})

describe('§227 — the cogwheel in the header opens the settings pane', () => {
  it('exists, is 44px, and names itself', async () => {
    renderShell()
    await ready()
    expect(cogwheel()).toHaveAttribute('aria-label', 'View settings')
    expect(cogwheel().className).toMatch(/\bh-11\b/)
    expect(cogwheel().className).toMatch(/\bw-11\b/)
    // Phones only: at md+ every control in the pane is back in the
    // toolbar's own popovers.
    expect(cogwheel().className).toMatch(/md:hidden/)
  })

  it('sits immediately LEFT of the search button', async () => {
    renderShell()
    await ready()
    const cog = cogwheel()
    const search = searchButton()
    // Same flex row, cogwheel first — and the row has no `order-*`
    // utilities, so DOM order is paint order.
    expect(cog.parentElement).toBe(search.parentElement)
    expect(cog.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    const between = Array.from(cog.parentElement!.children)
    expect(between.indexOf(search) - between.indexOf(cog)).toBe(1)
    expect(cog.parentElement!.className).not.toMatch(/\border-/)
  })

  it('opens the pane, and says so', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    expect(cogwheel()).toHaveAttribute('aria-expanded', 'false')
    expect(displayClasses(settingsPane())).toContain('max-md:hidden')

    await user.click(cogwheel())
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:flex'))
    expect(cogwheel()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('View settings')).toBeTruthy()
  })

  it('closes it again, from the pane’s own back control', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:flex'))

    // The pane covers the header, cogwheel included, so it has to offer
    // its own way out — §224 had the tab bar for that.
    const close = screen.getByTestId('close-view-settings')
    expect(close).toHaveAttribute('aria-label', 'Close view settings')
    expect(close.className).toMatch(/\bh-11\b/)
    await user.click(close)
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:hidden'))
  })

  it('and from Escape', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:flex'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(displayClasses(settingsPane())).toContain('max-md:hidden'))
  })

  it('starts closed, however the store was left', async () => {
    useMobileViewSettingsStore.setState({ open: true })
    renderShell()
    await ready()
    // Arriving at a project with the grid covered by a pane nobody opened
    // is what a persisted or carried-over flag would give.
    await waitFor(() => expect(useMobileViewSettingsStore.getState().open).toBe(false))
  })

  it('is offered on the project and folder pages only', () => {
    // The predicate the Header reads, asserted directly: a cogwheel on the
    // projects list would open a pane that is not mounted there.
    expect(pathHasMobileViewSettings(`/projects/${PROJECT}`)).toBe(true)
    expect(pathHasMobileViewSettings('/projects')).toBe(false)
    expect(pathHasMobileViewSettings(`/projects/${PROJECT}/assets/a-1`)).toBe(false)
    expect(pathHasMobileViewSettings(`/projects/${PROJECT}/collections`)).toBe(false)
    expect(pathHasMobileViewSettings('/settings/admin')).toBe(false)
  })
})

describe('§227 — the pane drives the same store as the toolbar', () => {
  it('the card-size control writes the key the Appearance popover writes', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    await screen.findByText('View settings')

    expect(useViewStore.getState().cardSize).toBe('M')
    await user.click(within(settingsPane()).getByRole('button', { name: 'XS' }))
    // The same store, the same key — not a parallel mobile preference.
    await waitFor(() => expect(useViewStore.getState().cardSize).toBe('XS'))
  })

  it('asset size is the FIRST control in the pane', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    const pane = settingsPane()
    const labels = Array.from(pane.querySelectorAll('span.text-sm')).map((e) => e.textContent)
    expect(labels[0]).toBe('Card Size')
    expect(labels.indexOf('Card Size')).toBeLessThan(labels.indexOf('Layout'))
  })

  it('also offers sort, which the toolbar popover owns on desktop', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    await screen.findByText('Sort by')
    await user.click(within(settingsPane()).getByRole('button', { name: /^Name$/ }))
    await waitFor(() => expect(useViewStore.getState().sortKey).toBe('name'))
  })

  it('and the whole §224 list of controls, in one pane', async () => {
    const user = userEvent.setup()
    renderShell()
    await ready()
    await user.click(cogwheel())
    const pane = settingsPane()
    for (const label of [
      'Card Size', 'Thumbnail Scale', 'Layout', 'Aspect Ratio',
      'Show Card Info', 'Titles', 'Flatten Folders',
    ]) {
      expect(within(pane).getByText(label)).toBeTruthy()
    }
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
    await user.click(await screen.findByTestId('folder-navigator-trigger'))
    await screen.findByTestId('folder-navigator-panel')

    const kebab = within(screen.getByTestId('folder-navigator-panel')).getByRole('button', {
      name: 'Folder options for Day 1',
    })
    // `opacity-0 group-hover:opacity-100` alone means permanently invisible
    // on a touch screen, and the rename / share actions unreachable.
    expect(kebab.className).toMatch(/hover-none:opacity-100/)
  })
})
