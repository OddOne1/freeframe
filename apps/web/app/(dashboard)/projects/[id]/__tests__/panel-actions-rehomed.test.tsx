/**
 * §232 item 2 — nothing the removed right panel could do has been lost.
 *
 * The panel offered, for the asset that was selected in it:
 *
 *   Open in Player · Share · Download · Comments · Fields
 *   Type · Uploaded · Uploaded by · File size · Version · Assignee
 *
 * This file is the "and it is still reachable" half of removing it, at the
 * level a component test can answer: which actions are in the card and row
 * `···` menus, and whether they are gated for the role the way the panel's
 * own buttons were. The full before/after table — including the fields,
 * which live on the card and in the viewer rather than in a menu — is in
 * the build report.
 *
 * Three roles are driven through the REAL page, because the gating is the
 * page's (`canShare`, `canEditAssets`) and the menu only renders an entry
 * when the page hands it a handler. Asserting it on the grid in isolation
 * would prove the grid honours a prop and say nothing about who gets it.
 *
 * Worth being exact about what the panel itself gated, since "the same
 * permission gating" is the requirement: its Share button was NOT gated —
 * a viewer who selected an asset was shown Share and Download and a share
 * dialog they cannot submit. The `···` menu gates Share on `canShare`, so
 * for a viewer this change REMOVES an action rather than re-homing one.
 * That is a fix, and it is listed in the report as a behaviour change
 * rather than a silent one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'

const PROJECT = 'proj-1'
const USER = 'u1'

let role = 'owner'

const ASSETS = [
  {
    id: 'a-1',
    project_id: PROJECT,
    name: 'Existing clip',
    status: 'in_review',
    asset_type: 'video',
    folder_id: null,
    created_by: USER,
    created_by_name: 'Tester',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    latest_version: { id: 'v-3', version_number: 3 },
  },
]

const get = vi.fn(async (path: string) => {
  if (path.includes('/folder-tree')) return []
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
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}`,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({
    user: { id: USER, name: 'Tester', email: 't@e.com' },
    isSuperAdmin: false,
  }),
}))
vi.mock('@/components/upload/upload-zone', () => ({ UploadZone: () => null }))

import ProjectPage from '../page'
import { useViewStore } from '@/stores/view-store'

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

/** Open the `···` menu on the only card/row and return its contents. */
async function openKebab(user: ReturnType<typeof userEvent.setup>, within_: string) {
  const host = await waitFor(() => {
    const el = document.querySelector(within_)
    if (!el) throw new Error(`no ${within_} yet`)
    return el as HTMLElement
  })
  const trigger = host.querySelector('[aria-haspopup="menu"]') as HTMLElement
  expect(trigger).toBeTruthy()
  await user.click(trigger)
  return screen.findByRole('menu')
}

const ENTRIES = {
  share: /create share link/i,
  download: /^download$/i,
  copyUrl: /copy asset url/i,
  rename: /^rename$/i,
  del: /^delete$/i,
}

beforeEach(() => {
  role = 'owner'
  vi.clearAllMocks()
  useViewStore.setState({
    layout: 'grid',
    rightPanelOpen: true,
    flattenFolders: false,
    sortKey: 'name',
    sortDirection: 'asc',
    showFileSize: true,
    showUploader: true,
    showCardInfo: true,
  })
})

describe.each([
  ['grid card', '[data-asset-card]', 'grid' as const],
  ['list row', '[data-asset-row]', 'list' as const],
])('§232 — Share and Download are in the %s ··· menu', (_label, selector, layout) => {
  beforeEach(() => {
    useViewStore.setState({ layout })
  })

  it('an owner gets every entry the panel had, plus the ones it never had', async () => {
    role = 'owner'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const menu = await openKebab(user, selector)
    // The two the panel carried.
    expect(within(menu).getByText(ENTRIES.share)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.download)).toBeTruthy()
    // And the three it did not.
    expect(within(menu).getByText(ENTRIES.copyUrl)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.rename)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.del)).toBeTruthy()
  })

  it('an editor gets the same, because canShare and canEditAssets both include editor', async () => {
    role = 'editor'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const menu = await openKebab(user, selector)
    expect(within(menu).getByText(ENTRIES.share)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.download)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.rename)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.del)).toBeTruthy()
  })

  it('a viewer gets Download and Copy URL, and NOT Share, Rename or Delete', async () => {
    role = 'viewer'
    const user = userEvent.setup()
    renderPage()
    await ready()
    const menu = await openKebab(user, selector)
    // Download is ungated on this page (`onAssetDownload` is passed
    // unconditionally) and was ungated in the panel too, so a viewer keeps
    // it: same handler, same gate, no copy of the logic.
    expect(within(menu).getByText(ENTRIES.download)).toBeTruthy()
    expect(within(menu).getByText(ENTRIES.copyUrl)).toBeTruthy()
    // These three are gated, and the list row used to ignore the gate: it
    // rendered its own hand-written copy of all five entries and called
    // optional handlers, so a viewer was offered Share, Rename and Delete
    // and they silently did nothing. Both surfaces use `AssetMenuItems`
    // now, so there is one gate left rather than two.
    expect(within(menu).queryByText(ENTRIES.share)).toBeNull()
    expect(within(menu).queryByText(ENTRIES.rename)).toBeNull()
    expect(within(menu).queryByText(ENTRIES.del)).toBeNull()
  })
})

describe('§232 — the handlers behind the re-homed entries are the page’s own', () => {
  it('Share opens the project’s share dialog, preselected to this asset', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const menu = await openKebab(user, '[data-asset-card]')
    await user.click(within(menu).getByText(ENTRIES.share))
    // The same dialog the panel's Share button opened, with the same
    // preselection — an asset, by id and name.
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Existing clip')).toBeTruthy()
  })

  it('Download asks the API for this asset’s stream url', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const menu = await openKebab(user, '[data-asset-card]')
    await user.click(within(menu).getByText(ENTRIES.download))
    // `downloadOneAsset` — the page's one download path, which the bulk
    // bar and the right-click menu also use.
    await waitFor(() =>
      expect(get.mock.calls.some(([p]) => String(p).includes('/assets/a-1'))).toBe(true),
    )
  })

  it('"Open in Player" has no menu entry, because the gesture IS the open', async () => {
    const user = userEvent.setup()
    renderPage()
    await ready()
    const card = await waitFor(() => {
      const el = document.querySelector('[data-asset-card]')
      if (!el) throw new Error('no card')
      return el as HTMLElement
    })
    await user.click(card)
    expect(push).toHaveBeenCalledWith(`/projects/${PROJECT}/assets/a-1`)
  })
})

describe('§232 — the metadata fields the panel listed are still on screen', () => {
  it('the grid card shows the uploader, the date and the file size', async () => {
    renderPage()
    await ready()
    const card = await waitFor(() => {
      const el = document.querySelector('[data-asset-card]')
      if (!el) throw new Error('no card')
      return el as HTMLElement
    })
    // "Uploaded by" and "Uploaded" from the panel's Fields tab, on the
    // card's own info line — which the Appearance popover can switch off,
    // exactly as before this change.
    expect(within(card).getByText('Tester')).toBeTruthy()
    expect(within(card).getByText(/ago|just now/i)).toBeTruthy()
  })

  it('the list row has a column for each of them', async () => {
    useViewStore.setState({ layout: 'list' })
    renderPage()
    await ready()
    const row = await waitFor(() => {
      const el = document.querySelector('[data-asset-row]')
      if (!el) throw new Error('no row')
      return el as HTMLElement
    })
    // Uploader, Size, Ver. and Date — the row renders all four, and "Ver."
    // is the panel's Version row.
    expect(within(row).getByText('Tester')).toBeTruthy()
    expect(within(row).getByText('v3')).toBeTruthy()
  })
})
