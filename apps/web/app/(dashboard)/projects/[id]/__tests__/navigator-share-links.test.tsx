/**
 * Share links and storage, reachable below `xl` (§227 item 5).
 *
 * The owner, from a phone: "no way to get to the share links". Exactly
 * right — the Share Links list lives in the project page's left column,
 * which is `hidden xl:flex`, and §224's folder sheet carried only
 * `FolderTree`. The project's storage figure was in the same column's
 * foot, so below 1280px that number did not exist anywhere either; Claude
 * Code's own §224b report said so.
 *
 * §227 extracts the list into `share-links-section.tsx` and mounts it in
 * BOTH places. These tests therefore have two jobs:
 *
 *   - the navigator panel offers the links, gated exactly as the column is;
 *   - the column still renders what it rendered, which is asserted on
 *     roles and text rather than class strings — the pixel question is
 *     answered by the screenshot diff, not by a string comparison that
 *     would fail on a reformat and pass on a layout change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
const USER = 'u1'

let role = 'owner'

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

/** Realistic: long titles, six links, one expired-looking and one off. */
const SHARE_LINKS = [
  {
    id: 's1', token: 'tok-aaaaaaaa', title: 'Reaction watchparty — rough cut for the client, v3',
    description: null, is_enabled: true, permission: 'view', share_type: 'folder',
    target_name: 'Reaction_watchparty', view_count: 42, last_viewed_at: new Date().toISOString(),
  },
  {
    id: 's2', token: 'tok-bbbbbbbb', title: 'A010C030_250101_R1AB.MXF',
    description: null, is_enabled: false, permission: 'view', share_type: 'asset',
    target_name: 'A010C030_250101_R1AB.MXF', view_count: 0, last_viewed_at: null,
  },
  {
    id: 's3', token: 'tok-cccccccc', title: 'Podcast episode 12 — sponsor review',
    description: null, is_enabled: true, permission: 'comment', share_type: 'folder',
    target_name: 'Podcast', view_count: 7, last_viewed_at: null,
  },
]

const post = vi.fn(async () => ({ id: 'new', token: 'tok-new' }))
const del = vi.fn(async () => ({}))
const patch = vi.fn(async () => ({}))

const get = vi.fn(async (path: string) => {
  if (path.includes('/folder-tree')) return TREE
  if (path.includes('/share-links')) return SHARE_LINKS
  if (path.includes('/assets?')) return []
  if (path === `/projects/${PROJECT}`) {
    return { id: PROJECT, name: 'Just Ride 2026', storage_bytes: 12_000_000_000, storage_limit_bytes: 50_000_000_000 }
  }
  if (path.includes('/members')) return [{ user_id: USER, role }]
  if (path.endsWith('/trash')) return { folders: [], assets: [] }
  return []
})

vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => get(p),
    post: (...a: unknown[]) => post(...(a as [])),
    patch: (...a: unknown[]) => patch(...(a as [])),
    delete: (...a: unknown[]) => del(...(a as [])),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: PROJECT }),
  useRouter: () => ({ push: vi.fn(), replace: (...a: unknown[]) => replace(...a), back: vi.fn() }),
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
import { useBreadcrumbStore } from '@/stores/breadcrumb-store'
import { useMobileViewSettingsStore } from '@/stores/mobile-view-settings-store'

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectPage />
    </SWRConfig>,
  )
}

async function ready() {
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/members`))
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/projects/${PROJECT}/share-links`))
}

/** The `hidden xl:flex` sidebar column. */
const column = () => document.querySelector('.w-72') as HTMLElement
/** The navigator's panel — only in the DOM while it is open. */
const panelEl = () => screen.getByTestId('folder-navigator-panel')

/**
 * The column's per-link "···" triggers.
 *
 * `button`, because Radix also leaves a hidden `<span aria-hidden>` with
 * the same `aria-haspopup`; `:not([aria-label])` excludes the folder
 * tree's own kebab, which names itself ("Folder options for Day 1") and
 * shares the column.
 */
function shareLinkKebabs(): HTMLElement[] {
  return Array.from(
    column().querySelectorAll('button[aria-haspopup="menu"]:not([aria-label])'),
  ) as HTMLElement[]
}

async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('folder-navigator-trigger'))
  return screen.findByTestId('folder-navigator-panel')
}

beforeEach(() => {
  role = 'owner'
  get.mockClear()
  post.mockClear()
  del.mockClear()
  patch.mockClear()
  replace.mockClear()
  useBreadcrumbStore.setState({ pathname: null, labels: {}, extraCrumbs: [] })
  useMobileViewSettingsStore.setState({ open: false })
})

// ─── The panel offers them ──────────────────────────────────────────────

describe('§227 — the navigator panel lists the share links', () => {
  it('shows the section, the "+" and "All Share Links (n)"', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)

    expect(within(p).getByText('Share Links')).toBeTruthy()
    expect(within(p).getByRole('button', { name: /all share links \(3\)/i })).toBeTruthy()
    expect(within(p).getByTitle('Create share link')).toBeTruthy()
  })

  it('and each individual link, as the column does', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    for (const link of SHARE_LINKS) {
      expect(within(p).getByText(link.title)).toBeTruthy()
    }
  })

  it('below the tree and a divider, not mixed into it', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    const extra = within(p).getByTestId('folder-navigator-extra')
    expect(extra.className).toMatch(/border-t/)
    // The tree comes first in the panel; share links follow it.
    const tree = within(p).getByText('Day 1')
    expect(tree.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('then the project’s storage, the figure the column’s foot shows', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    const extra = within(p).getByTestId('folder-navigator-extra')
    // 12 GB of 50 GB, decimal, which is the app's default byte-unit mode —
    // the same pair the column prints, from the same project record.
    expect(extra.textContent).toMatch(/Storage/)
    expect(extra.textContent).toMatch(/12 GB \/ 50 GB/)
    expect(within(column()).getByText('12 GB / 50 GB')).toBeTruthy()
  })
})

// ─── The gate ───────────────────────────────────────────────────────────

describe('§227 — gated exactly as the column is', () => {
  it('an editor sees them', async () => {
    role = 'editor'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    expect(within(p).getByText('Share Links')).toBeTruthy()
  })

  it('a viewer does not', async () => {
    role = 'viewer'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    expect(within(p).queryByText('Share Links')).toBeNull()
    expect(within(p).queryByRole('button', { name: /all share links/i })).toBeNull()
    // …and neither does the column, which is the point of one gate.
    expect(within(column()).queryByText('Share Links')).toBeNull()
  })

  it('a commenter does not either', async () => {
    role = 'commenter'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    expect(within(p).queryByText('Share Links')).toBeNull()
  })

  it('but a viewer still gets the storage figure, which is not privileged', async () => {
    role = 'viewer'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    expect(within(p).getByTestId('folder-navigator-extra').textContent).toMatch(/Storage/)
  })
})

// ─── Selecting one ──────────────────────────────────────────────────────

describe('§227 — picking a link from the panel', () => {
  it('selects it in the page and closes the panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)

    await user.click(within(p).getByText(SHARE_LINKS[0].title))
    // Closed, so the tree is not left sitting over what it just opened.
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )
    // The page's own state: the link detail is now the main view, and the
    // bar says so.
    await waitFor(() =>
      expect(screen.getByTestId('folder-navigator-trigger')).toHaveTextContent('Share Links'),
    )
  })

  it('"All Share Links" shows the table and closes the panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)

    await user.click(within(p).getByRole('button', { name: /all share links \(3\)/i }))
    await waitFor(() =>
      expect(screen.queryByTestId('folder-navigator-panel')).not.toBeInTheDocument(),
    )
    // ShareLinksTable's own search box is the proof it is mounted.
    expect(await screen.findByPlaceholderText('Search for Shares')).toBeTruthy()
  })

  it('clears the open folder with a REPLACE, not a push (§29)', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    await user.click(within(p).getByText(SHARE_LINKS[0].title))
    // A history entry here would let Back restore the folder while leaving
    // the share view open — a state the URL cannot describe.
    await waitFor(() => expect(replace).toHaveBeenCalled())
  })

  it('the "+" opens the existing create dialog', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const p = await openPanel(user)
    await user.click(within(p).getByTitle('Create share link'))
    // The same dialog the column's "+" opens — not a second one.
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})

// ─── The column is unchanged ────────────────────────────────────────────

describe('§227 — the column renders what it rendered', () => {
  it('offers the same section, button and rows', async () => {
    renderPage()
    await ready()
    const col = within(column())
    expect(col.getByText('Share Links')).toBeTruthy()
    expect(await col.findByRole('button', { name: /all share links \(3\)/i })).toBeTruthy()
    expect(col.getByTitle('Create share link')).toBeTruthy()
    for (const link of SHARE_LINKS) {
      expect(col.getByText(link.title)).toBeTruthy()
    }
    expect(col.getByText('Storage')).toBeTruthy()
  })

  it('keeps the per-link menu, with the same four entries', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const kebabs = shareLinkKebabs()
    expect(kebabs.length).toBe(SHARE_LINKS.length)

    await user.click(kebabs[0])
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
        'Open Share',
        'Copy Link',
        'Disable Access',
        'Delete',
      ]),
    )
  })

  it('still collapses from its own header', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const col = within(column())
    expect(await col.findByRole('button', { name: /all share links/i })).toBeTruthy()
    await user.click(col.getByText('Share Links'))
    await waitFor(() => expect(col.queryByRole('button', { name: /all share links/i })).toBeNull())
  })

  it('and the collapse is ONE state, shared with the panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    await user.click(within(column()).getByText('Share Links'))

    const p = await openPanel(user)
    // Not two independent `expanded` flags: the section is one component
    // reading one piece of page state, which is why it is passed in.
    expect(within(p).queryByRole('button', { name: /all share links/i })).toBeNull()
  })

  it('"Enable Access" for a link that is off, "Disable" for one that is on', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    // SHARE_LINKS[1] is the disabled one.
    await user.click(shareLinkKebabs()[1])
    await waitFor(() =>
      expect(screen.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toContain(
        'Enable Access',
      ),
    )
  })
})
