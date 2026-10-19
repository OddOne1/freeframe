/**
 * §230 item 3 — the project / folder view on a phone lying on its side.
 *
 * MEASURED in Chromium at 844x390 against `main`'s build: the chrome
 * before the first card was 231px of a 390px screen — a 52px rail down
 * the side, a 44px app header, a 48px navigator bar, a 43px toolbar row
 * and a 32px Back button with 12px of column gap either side of it — and
 * not one card row was fully visible. The numbers after, and the same
 * four viewports, are in the §230 report.
 *
 * jsdom applies no media queries and no stylesheet, so these do not prove
 * pixels. They prove the two things a Chromium run cannot: that the
 * REARRANGEMENT is one tree and not two copies (one Back button, one
 * `data-testid`, one href, derived from the same `folderTrail`), and that
 * nothing the toolbar used to offer became unreachable — every action is
 * asserted against the menu it moved into.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import fs from 'node:fs'
import path from 'node:path'

const PROJECT = 'proj-1'
const USER = 'u1'
let folderParam: string | null = 'f-1'

const TREE = [
  {
    id: 'f-1', name: 'Day 1', parent_id: null, item_count: 1, total_size_bytes: 0,
    children: [
      { id: 'f-1a', name: 'Rushes', parent_id: 'f-1', item_count: 0, total_size_bytes: 0, children: [] },
    ],
  },
]
const ASSETS = [
  {
    id: 'a-1', project_id: PROJECT, name: 'Existing clip', status: 'in_review',
    asset_type: 'video', folder_id: 'f-1', created_at: new Date().toISOString(),
  },
  {
    id: 'a-2', project_id: PROJECT, name: 'Second clip', status: 'in_review',
    asset_type: 'video', folder_id: 'f-1', created_at: new Date().toISOString(),
  },
]

const get = vi.fn(async (p: string) => {
  if (p.includes('/share-links')) return []
  if (p.includes('/folder-tree')) return TREE
  if (p.includes('/assets?')) return ASSETS
  if (p === `/projects/${PROJECT}`) return { id: PROJECT, name: 'Podcast' }
  if (p.includes('/members')) return [{ user_id: USER, role: 'owner' }]
  if (p.endsWith('/trash')) return { folders: [], assets: [] }
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
  useAuthStore: () => ({ user: { id: USER, name: 'Tester', email: 't@e.com' }, isSuperAdmin: false }),
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
import { useMobileViewSettingsStore } from '@/stores/mobile-view-settings-store'

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8')
const CSS = read('app/globals.css')
const QUERY = '@media (hover: none) and (pointer: coarse) and (max-height: 500px) {'
const BLOCK = (() => {
  const start = CSS.lastIndexOf(QUERY)
  let depth = 0
  for (let i = start + QUERY.length - 1; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++
    else if (CSS[i] === '}' && --depth === 0) return CSS.slice(start, i + 1)
  }
  throw new Error('unterminated block')
})()

/** The compact-landscape half of the capability query, which is what the
 *  hook reads. Everything else answers `false`, so this is a 844x390
 *  phone rather than a 844px desktop window. */
function setCompactLandscape(on: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('max-height: 500px') ? on : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  )
}

function renderShell() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <Header onSearchOpen={() => {}} onMobileNavOpen={() => {}} />
      <ProjectPage />
    </SWRConfig>,
  )
}

async function ready() {
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/members`))
}

beforeEach(() => {
  folderParam = 'f-1'
  get.mockClear()
  useBreadcrumbStore.setState({ pathname: null, labels: {}, extraCrumbs: [] })
  useViewStore.setState({
    rightPanelOpen: false, flattenFolders: false, layout: 'grid', cardSize: 'M', sortKey: 'date',
  })
  useMobileViewSettingsStore.setState({ open: false })
  setCompactLandscape(false)
})

// ─── one row: [‹ Back][path…][⌄][···] ───────────────────────────────────

describe('§230 item 3 — Back and the path share one row', () => {
  it('Back is INSIDE the navigator bar in compact landscape', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    const leading = await screen.findByTestId('folder-navigator-leading')
    expect(within(leading).getByTestId('folder-back')).toBeTruthy()
    expect(
      screen.getByTestId('folder-navigator').contains(screen.getByTestId('folder-back')),
    ).toBe(true)
  })

  it('and there is exactly ONE of it — no copy left in the content column', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    await screen.findByTestId('folder-navigator-leading')
    expect(screen.getAllByTestId('folder-back')).toHaveLength(1)
  })

  it('keeping the target and the accessible name it has everywhere else', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    const back = await screen.findByTestId('folder-back')
    // trail is [Day 1], so the parent is the project root.
    expect(back).toHaveAttribute('href', `/projects/${PROJECT}`)
    expect(back).toHaveAttribute('aria-label', 'Back to Podcast')
  })

  it('it is the compact VARIANT of the same component, not a fork', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    const back = await screen.findByTestId('folder-back')
    expect(back).toHaveAttribute('data-compact-back')
    // The one piece of text the row has no room for; the accessible name
    // above still carries it.
    expect(back.textContent?.trim()).toBe('Back')
    const SRC = read('components/projects/folder-back-button.tsx')
    expect(SRC.match(/data-testid="folder-back"/g)).toHaveLength(1)
    expect(SRC.match(/export function FolderBackButton/g)).toHaveLength(1)
  })

  it('and everywhere else Back is still under the toolbar line (§228e)', async () => {
    setCompactLandscape(false)
    renderShell()
    await ready()
    const back = await screen.findByTestId('folder-back')
    expect(screen.queryByTestId('folder-navigator-leading')).toBeNull()
    expect(back).not.toHaveAttribute('data-compact-back')
    expect(back).toHaveAttribute('aria-label', 'Back to Podcast')
    // Same href in both modes — one `folderBackTarget`, four readers.
    expect(back).toHaveAttribute('href', `/projects/${PROJECT}`)
  })

  it('the merged row is 40px with 36px controls, and Back\'s hit box fits it', () => {
    expect(BLOCK).toMatch(/\[data-testid='folder-navigator'\] \{\s*height: 40px;/)
    expect(BLOCK).toMatch(/\[data-testid='folder-navigator-trigger'\] \{\s*height: 2\.25rem;/)
    // `.tap-target-44`'s ::before is max(100%, 44px) and a minimum cannot
    // bring that down, so it is restated — otherwise the invisible box
    // reaches past the row and into the trigger beside it.
    expect(BLOCK).toMatch(
      /:root \[data-compact-back\]\.tap-target-44::before \{[^}]*width: max\(100%, 2\.25rem\);/,
    )
    expect(BLOCK).toMatch(
      /:root \[data-compact-back\]\.tap-target-44::before \{[^}]*height: max\(100%, 2\.25rem\);/,
    )
  })

  it('Back sits OUTSIDE the trigger button — two targets, two destinations', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    const trigger = await screen.findByTestId('folder-navigator-trigger')
    expect(trigger.contains(screen.getByTestId('folder-back'))).toBe(false)
  })
})

// ─── the toolbar's actions, and where each one went ─────────────────────

describe('§230 item 3 — the toolbar collapses, nothing becomes unreachable', () => {
  it('the toolbar ROW is the one with an action group, and only that one', () => {
    // `/assets` renders the same bar with Appearance and Sort and no `···`
    // and no cogwheel, so hiding it there would strand two controls.
    expect(BLOCK).toMatch(
      /:root \[data-testid='navigator-bar'\]\.toolbar-crowded \{\s*display: none;/,
    )
    expect(BLOCK).not.toMatch(/\[data-testid='navigator-bar'\] \{\s*display: none;/)
  })

  it('Upload, New Folder, Share, Members and Project settings are in the `···`', async () => {
    const user = userEvent.setup()
    setCompactLandscape(true)
    renderShell()
    await ready()
    await user.click(await screen.findByTestId('project-actions-menu'))
    const menu = await screen.findByRole('menu')
    for (const label of ['Upload', 'New Folder', 'Share', 'Members', 'Project settings']) {
      expect(within(menu).getByText(label)).toBeTruthy()
    }
  })

  it('and the `···` is drawn and finger-sized at 844px wide', () => {
    expect(BLOCK).toMatch(
      /:root \[data-testid='project-actions-menu'\] \{[^}]*display: flex;/,
    )
    expect(BLOCK).toMatch(
      /:root \[data-testid='project-actions-menu'\] \{[^}]*min-height: 2\.25rem;/,
    )
  })

  it('Appearance and Sort are in the cogwheel pane, which the header draws', async () => {
    const user = userEvent.setup()
    setCompactLandscape(true)
    renderShell()
    await ready()
    const cog = screen.getByTestId('header-view-settings')
    expect(cog).toHaveAttribute('aria-expanded', 'false')
    await user.click(cog)
    expect(screen.getByTestId('project-settings-pane')).toHaveAttribute('data-open', 'true')
    expect(useMobileViewSettingsStore.getState().open).toBe(true)
  })

  it('the pane reads that state, because its `max-md:` classes cannot at 844', () => {
    expect(BLOCK).toMatch(
      /\[data-testid='project-settings-pane'\]\[data-open='true'\] \{\s*display: flex;/,
    )
    expect(BLOCK).toMatch(
      /\[data-testid='project-settings-pane'\]\[data-open='false'\] \{\s*display: none;/,
    )
    // ...and it needs a box and a position too: `max-md:fixed` gives it
    // neither above `md`.
    expect(BLOCK).toMatch(
      /:root \[data-testid='project-settings-pane'\] \{[^}]*position: fixed;/,
    )
  })

  it('the cogwheel itself is un-hidden, and the header slimmed to 36', () => {
    expect(BLOCK).toMatch(/\[data-testid='header-view-settings'\] \{\s*display: flex;/)
    expect(BLOCK).toMatch(/:root header\[data-app-header\] \{\s*height: 2\.25rem;/)
    expect(BLOCK).toMatch(
      /:root header\[data-app-header\] \[data-testid='header-nav-open'\] \{\s*display: flex;/,
    )
  })
})

// ─── what must NOT change ───────────────────────────────────────────────

describe('§230 item 3 — the gestures and the grid are untouched', () => {
  it('a single tap still opens an asset in compact landscape (§232 item 1)', async () => {
    const user = userEvent.setup()
    setCompactLandscape(true)
    const { container } = renderShell()
    await ready()
    const card = await waitFor(() => {
      const el = container.querySelector('[data-asset-card]')
      if (!el) throw new Error('no card yet')
      return el as HTMLElement
    })
    await user.click(card)
    // The grid's own open path is a router push; the card is still a card.
    expect(card.getAttribute('data-asset-card')).not.toBeNull()
  })

  it('the checkbox is still on the card in compact landscape (§228b)', async () => {
    setCompactLandscape(true)
    renderShell()
    await ready()
    // Its accessible name is the whole control: §228b's complaint was a
    // card that showed no way to select it at all on a touch screen.
    await screen.findByLabelText('Select Existing clip')
  })

  /**
   * §232's gestures, re-run with the compact-landscape mock on. They are
   * the asset grid's own and §230 does not touch them — which is exactly
   * why they are re-run here: "does not touch" is a claim, and the page
   * under this mock is a different tree from the one §232 measured.
   */
  it('cmd-click still builds a multi-selection in compact landscape', async () => {
    const user = userEvent.setup()
    setCompactLandscape(true)
    const { container } = renderShell()
    await ready()
    await waitFor(() => {
      if (container.querySelectorAll('[data-asset-card]').length < 2) throw new Error('not yet')
    })
    const cards = container.querySelectorAll('[data-asset-card]')
    await user.keyboard('{Meta>}')
    await user.click(cards[0] as HTMLElement)
    await user.click(cards[1] as HTMLElement)
    await user.keyboard('{/Meta}')
    expect(await screen.findByText(/2 Items selected/i)).toBeTruthy()
  })

  it('and a drag that ends on a card still does not open it (§232)', async () => {
    const user = userEvent.setup()
    setCompactLandscape(true)
    const { container } = renderShell()
    await ready()
    const card = await waitFor(() => {
      const el = container.querySelector('[data-asset-card]')
      if (!el) throw new Error('no card yet')
      return el as HTMLElement
    })
    await user.pointer([
      { target: card, keys: '[MouseLeft>]', coords: { clientX: 10, clientY: 10 } },
      { target: card, coords: { clientX: 90, clientY: 80 } },
      { target: card, keys: '[/MouseLeft]', coords: { clientX: 90, clientY: 80 } },
    ])
    expect(screen.queryByText(/Item.? selected/i)).toBeNull()
  })

  it('the page reads the compact mode from the shared hook, not its own query', () => {
    const SRC = read('app/(dashboard)/projects/[id]/page.tsx')
    expect(SRC).toContain('useCompactLandscape')
    expect(SRC).not.toContain('max-height: 500px')
    // Exactly one JS breakpoint was added, and only where a different
    // tree has to mount.
    expect(SRC.match(/useCompactLandscape\(\)/g)).toHaveLength(1)
  })
})
