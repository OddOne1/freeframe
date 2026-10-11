/**
 * The asset viewer on a phone (§228).
 *
 * Real page, real store, real components — the only things stubbed are the
 * network and the three media players, which jsdom has no codec for. The
 * viewport is decided the way the code decides it: a stubbed `matchMedia`,
 * the same mechanism `responsive-shell.test.tsx` already uses, because
 * jsdom has no media queries of its own.
 *
 * What these assert is BEHAVIOUR, not class names: that Back is a link to
 * the folder, that it is a different element from the previous-asset
 * control, that version/status/rating are reachable in the Fields tab and
 * absent from the top bar, that every action removed from the bar is in
 * the `⋯` menu and still calls its handler, and that at `md`+ the old
 * drawer comes back. The things jsdom cannot see — whether anything
 * overflows, how big a tap target is, whether the sheet is on screen — are
 * measured in Chromium instead (see the §228 report).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import type { AssetResponse, AssetVersion } from '@/types'

const PROJECT = 'proj-1'
const FOLDER = 'folder-grandchild'
const ASSET = 'asset-1'

let asset: Partial<AssetResponse> | null
let versions: AssetVersion[]
/** The current user's project role — the one input every permission gate
 *  on this page reads. Set per test, never via `mockImplementationOnce`:
 *  these keys are fetched in an order SWR decides, so a one-shot mock
 *  lands on whichever request happens to go first. */
let role = 'owner'

const apiGet = vi.fn(async (path: string) => {
  if (path.includes('/members')) {
    return [{ id: 'pm1', project_id: PROJECT, user_id: 'u1', role }]
  }
  if (path.startsWith('/users?')) return [{ id: 'u1', name: 'Tester', email: 't@e.com' }]
  if (path.endsWith('/folder-tree')) {
    return [{ id: FOLDER, name: 'Reaction_watchparty', parent_id: null, item_count: 2, total_size_bytes: 0, children: [] }]
  }
  if (path.endsWith('/votes')) return []
  if (path.endsWith(`/projects/${PROJECT}/assets`)) return [{ id: ASSET }, { id: 'asset-2' }]
  return []
})
const apiPost = vi.fn(async (_p: string, _b?: unknown) => ({}))
const apiPatch = vi.fn(async (_p: string, _b?: unknown) => ({}))

vi.mock('@/components/review/review-provider', async () => {
  const React = await import('react')
  return {
    ReviewProvider: ({ children }: { children: React.ReactNode }) => children,
    useReview: () => ({
      assetId: ASSET,
      asset,
      versions,
      comments: [],
      isLoading: false,
      error: null,
      addComment: vi.fn(),
      resolveComment: vi.fn(),
      seekTo: vi.fn(),
      refetchComments: vi.fn(),
      refetchVersions: vi.fn(),
      pauseVideo: vi.fn(),
      registerPauseHandler: vi.fn(),
    }),
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => apiGet(p),
    post: (p: string, b?: unknown) => apiPost(p, b),
    patch: (p: string, b?: unknown) => apiPatch(p, b),
    delete: vi.fn(async () => ({})),
    put: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

const routerPush = vi.fn()
const routerBack = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: routerBack }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}/assets/${ASSET}`,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { id: 'u1', name: 'Tester', email: 't@e.com' }, isSuperAdmin: false }),
}))
const startVersionUpload = vi.fn()
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: (sel: (s: unknown) => unknown) =>
    sel ? sel({ startVersionUpload }) : { startVersionUpload },
}))
vi.mock('@/hooks/use-sse', () => ({ useSSE: () => {} }))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [],
    createComment: vi.fn(),
    resolveComment: vi.fn(),
    deleteComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
  }),
}))

// jsdom has no codecs, no WebGL and no Fabric canvas.
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div data-testid="video-player" /> }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => <div data-testid="audio-player" /> }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => <div data-testid="image-viewer" /> }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => <div data-testid="comment-panel" /> }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => <div data-testid="comment-input" /> }))
vi.mock('@/components/review/transcript-panel', () => ({ TranscriptPanel: () => <div data-testid="transcript-panel" /> }))
vi.mock('@/components/review/sidecar-metadata', () => ({ SidecarMetadata: () => null }))
vi.mock('@/components/review/share-dialog', () => ({
  ShareDialog: ({ open }: { open?: boolean }) => (
    <div data-testid="share-dialog" data-open={open ? 'yes' : 'no'} />
  ),
}))
vi.mock('@/components/review/lut-sidebar', () => ({
  LutSidebar: () => <div data-testid="lut-sidebar" />,
  LutSidebarToggle: () => <button>LUT</button>,
  useLutSidebarOpen: () => [false, vi.fn()],
}))
const lutState = { supported: true, selectedId: null as string | null, luts: [] as unknown[] }
vi.mock('@/hooks/use-lut', () => ({
  useLut: () => ({ ...lutState, select: vi.fn(), cube: null, isLoading: false, isLoadingCube: false }),
}))

import { SWRConfig } from 'swr'
import { useReviewStore } from '@/stores/review-store'
import ReviewPage from '../page'

/** Radix's DropdownMenu.Trigger opens on pointerdown, not click. */
function openDropdown(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
}

/** jsdom has no media queries; this is what `useIsPhone` actually reads. */
function setPhone(isPhone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      // `useIsPhone` asks for `(max-width: 767px)`; `viewportIsXlUp` asks
      // for `(min-width: 1280px)`. A phone is neither wide nor xl.
      matches: q.includes('max-width: 767px') ? isPhone : !isPhone,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })),
  )
}

function renderViewer() {
  // A fresh SWR cache per render: the cache is module-global, so without
  // this a role fetched in one test is still the role in the next.
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ReviewPage params={{ id: PROJECT, assetId: ASSET }} />
    </SWRConfig>,
  )
}

const topBar = () => screen.getByTestId('viewer-top-bar')

/** The project role arrives over the network and every permission gate on
 *  this page waits for it, so anything asserting an editable control has
 *  to wait too. The composer is rendered on exactly that condition. */
const ready = () => screen.findByTestId('comment-input')

beforeEach(() => {
  asset = {
    id: ASSET,
    project_id: PROJECT,
    name: 'A010C030_250101_R1AB_reaction_watchparty_camB_take07_graded.mxf',
    asset_type: 'video',
    status: 'in_review',
    folder_id: FOLDER,
    avg_rating: 3.4,
    rating_count: 5,
    my_rating: 4,
  } as Partial<AssetResponse>
  versions = [
    { id: 'v1', asset_id: ASSET, version_number: 1, processing_status: 'ready', created_by: 'u1', created_at: '2025-01-01T00:00:00Z', deleted_at: null, files: [] },
    { id: 'v2', asset_id: ASSET, version_number: 2, processing_status: 'ready', created_by: 'u1', created_at: '2025-01-02T00:00:00Z', deleted_at: null, files: [] },
  ] as AssetVersion[]
  lutState.selectedId = null
  role = 'owner'
  // The REAL review store, not a mock of it: which version is current is
  // what decides whether a player mounts at all.
  useReviewStore.getState().setCurrentVersion(versions[1])
  routerPush.mockClear()
  apiPatch.mockClear()
  startVersionUpload.mockClear()
  setPhone(true)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── 1. A way out that is not the browser's Back ─────────────────────────

describe('§228 — leaving the asset', () => {
  it('Back is a real link to the folder the asset lives in', () => {
    renderViewer()
    const back = screen.getByTestId('viewer-back')
    expect(back.tagName).toBe('A')
    expect(back.getAttribute('href')).toBe(`/projects/${PROJECT}?folder=${FOLDER}`)
  })

  it('and it says so, not just an arrow', () => {
    renderViewer()
    expect(screen.getByTestId('viewer-back')).toHaveTextContent(/back/i)
  })

  it('it is NOT router.back(): clicking it never touches the history stack', () => {
    // The page is routinely opened cold — a shared link, a refresh, a new
    // tab — where the history stack holds nothing useful.
    renderViewer()
    fireEvent.click(screen.getByTestId('viewer-back'))
    expect(routerBack).not.toHaveBeenCalled()
  })

  it('and the project root for an asset that really is at the root', () => {
    asset = { ...asset, folder_id: null }
    renderViewer()
    expect(screen.getByTestId('viewer-back').getAttribute('href')).toBe(`/projects/${PROJECT}`)
  })
})

describe('§228 — Back and the asset navigation are different controls', () => {
  it('prev/next are separate elements from Back', async () => {
    renderViewer()
    await screen.findByTestId('viewer-asset-nav')
    const back = screen.getByTestId('viewer-back')
    const prev = screen.getByTestId('viewer-prev-asset')
    const next = screen.getByTestId('viewer-next-asset')
    expect(prev).not.toBe(back)
    expect(next).not.toBe(back)
    expect(back.contains(prev)).toBe(false)
    expect(prev.contains(back)).toBe(false)
  })

  it('and they live in a group of their own, not in the Back button’s', async () => {
    renderViewer()
    const nav = await screen.findByTestId('viewer-asset-nav')
    expect(nav.contains(screen.getByTestId('viewer-prev-asset'))).toBe(true)
    expect(nav.contains(screen.getByTestId('viewer-back'))).toBe(false)
  })

  it('and next still navigates', async () => {
    renderViewer()
    await screen.findByTestId('viewer-asset-nav')
    fireEvent.click(screen.getByTestId('viewer-next-asset'))
    expect(routerPush).toHaveBeenCalledWith(`/projects/${PROJECT}/assets/asset-2`)
  })
})

// ─── 2. Version, status and rating move to the Fields tab ───────────────

describe('§228 — version, status and rating on a phone', () => {
  it('are not in the top bar', () => {
    renderViewer()
    const bar = topBar()
    expect(within(bar).queryByText('Version:')).toBeNull()
    expect(within(bar).queryByText(/needs review/i)).toBeNull()
    // The rating is five <button>s with no text; the bar's remaining
    // buttons are back/prev/next/more, so a star would show up here.
    expect(within(bar).queryByTestId('viewer-fields-rating')).toBeNull()
  })

  it('and are at the TOP of the Fields tab, in that order', () => {
    renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    const block = screen.getByTestId('viewer-fields-phone-controls')
    expect(
      Array.from(block.children).map((c) => (c as HTMLElement).dataset.testid),
    ).toEqual(['viewer-fields-version', 'viewer-fields-status', 'viewer-fields-rating'])
  })

  it('the status control there is the real one and still saves', async () => {
    renderViewer()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    const status = screen.getByTestId('viewer-fields-status')
    openDropdown(within(status).getByRole('button'))
    const approved = await screen.findByText('Approved')
    fireEvent.click(approved)
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(`/assets/${ASSET}`, { status: 'approved' }),
    )
  })

  it('the rating there is the real one and still votes', async () => {
    renderViewer()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    const rating = screen.getByTestId('viewer-fields-rating')
    const stars = within(rating).getAllByRole('button')
    expect(stars).toHaveLength(5)
    fireEvent.click(stars[4])
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
  })

  it('and the Comments tab still shows the state, without switching tabs', () => {
    renderViewer()
    expect(screen.getByTestId('viewer-comments-status-chip')).toHaveTextContent(/needs review/i)
  })
})

describe('§228 — the permission gating is the gating the top bar had', () => {
  it('a viewer gets a read-only status and no rating control', async () => {
    role = 'viewer'
    asset = { ...asset, rating_count: 0, my_rating: null }
    renderViewer()
    await waitFor(() => {
      const chip = screen.getByTestId('viewer-comments-status-chip')
      // readOnly renders a plain <Badge>, not a dropdown trigger.
      expect(within(chip).queryByRole('button')).toBeNull()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    // canVote is false and nobody has voted, so the row is absent entirely
    // — exactly what the top bar did with `(canVote || ratingCount > 0)`.
    expect(screen.queryByTestId('viewer-fields-rating')).toBeNull()
  })
})

// ─── 3. The `⋯` menu holds everything taken out of the bar ──────────────

describe('§228 — the ⋯ menu', () => {
  /** Radix's DropdownMenu opens on pointerdown, not click. */
  async function openMenu() {
    fireEvent.pointerDown(
      screen.getByTestId('viewer-overflow-trigger'),
      { button: 0, ctrlKey: false, pointerType: 'mouse' },
    )
    return screen.findByTestId('viewer-overflow-menu')
  }

  it('holds Share, Download, Compare and New Version', async () => {
    renderViewer()
    const menu = await openMenu()
    for (const label of ['Share', 'Download', 'Compare', 'New Version']) {
      expect(within(menu).getByText(label)).toBeTruthy()
    }
  })

  it('New Version opens the file picker that starts the upload', async () => {
    renderViewer()
    const menu = await openMenu()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    fireEvent.click(within(menu).getByText('New Version'))
    await waitFor(() => expect(click).toHaveBeenCalled())
  })

  it('Download asks the API for a download URL', async () => {
    renderViewer()
    const menu = await openMenu()
    apiGet.mockClear()
    fireEvent.click(within(menu).getByText('Download'))
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(`/assets/${ASSET}/stream?download=true`),
    )
  })

  it('Share opens the one ShareDialog instance rather than a second copy', async () => {
    renderViewer()
    // One instance, whatever the width: the inline trigger and the menu
    // item drive the same `shareOpen`.
    expect(screen.getAllByTestId('share-dialog')).toHaveLength(1)
    const menu = await openMenu()
    expect(screen.getAllByTestId('share-dialog')).toHaveLength(1)
    expect(screen.getByTestId('share-dialog').dataset.open).toBe('no')
    fireEvent.click(within(menu).getByText('Share'))
    await waitFor(() => expect(screen.getByTestId('share-dialog').dataset.open).toBe('yes'))
  })

  it('and it carries the graded download only when a LUT is actually selected', async () => {
    const { unmount } = renderViewer()
    let menu = await openMenu()
    expect(within(menu).queryByText(/with currently displayed LUT/i)).toBeNull()
    unmount()

    lutState.selectedId = 'lut-1'
    renderViewer()
    menu = await openMenu()
    expect(within(menu).getByText(/with currently displayed LUT/i)).toBeTruthy()
  })
})

// ─── 4. One screen, not a drawer ────────────────────────────────────────

describe('§228 — the phone layout', () => {
  it('is one screen: no drawer, no scrim, no toggle', () => {
    renderViewer()
    expect(screen.getByTestId('viewer-phone-layout')).toBeTruthy()
    expect(screen.queryByTestId('viewer-right-panel')).toBeNull()
    expect(screen.queryByTestId('viewer-panel-scrim')).toBeNull()
    expect(screen.queryByTestId('viewer-panel-toggle')).toBeNull()
  })

  it('puts the tab switch and the comment list under the player, and the composer last', async () => {
    renderViewer()
    await ready()
    const layout = screen.getByTestId('viewer-phone-layout')
    const order = ['viewer-phone-media', 'viewer-panel-tabs', 'comment-panel', 'comment-input']
    const positions = order.map((id) =>
      Array.prototype.indexOf.call(
        layout.querySelectorAll('[data-testid]'),
        layout.querySelector(`[data-testid="${id}"]`),
      ),
    )
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it('sizes the player per media type so there is always a list below it', () => {
    renderViewer()
    const media = screen.getByTestId('viewer-phone-media')
    expect(media.dataset.media).toBe('video')
    expect(media.className).toContain('viewer-phone-media')
  })

  it('and does the same for an audio and an image asset', async () => {
    asset = { ...asset, asset_type: 'audio' }
    const { unmount } = renderViewer()
    await ready()
    expect(screen.getByTestId('viewer-phone-media').dataset.media).toBe('audio')
    expect(screen.getByTestId('audio-player')).toBeTruthy()
    unmount()

    asset = { ...asset, asset_type: 'image' }
    renderViewer()
    await ready()
    expect(screen.getByTestId('viewer-phone-media').dataset.media).toBe('image')
    expect(screen.getByTestId('image-viewer')).toBeTruthy()
  })
})

// ─── 5. At `md`+ nothing moved ──────────────────────────────────────────

describe('§228 — at md+ the existing layout is untouched', () => {
  beforeEach(() => setPhone(false))

  it('renders the drawer, not the phone layout', () => {
    renderViewer()
    expect(screen.queryByTestId('viewer-phone-layout')).toBeNull()
    expect(screen.getByTestId('viewer-panel-toggle')).toBeTruthy()
  })

  it('version, status and rating are back in the top bar', () => {
    renderViewer()
    const bar = topBar()
    expect(within(bar).getByText('Version:')).toBeTruthy()
    expect(within(bar).getByText(/needs review/i)).toBeTruthy()
    expect(screen.queryByTestId('viewer-fields-phone-controls')).toBeNull()
  })

  it('the panel toggle still closes and reopens the drawer, and is NOT in the ⋯ menu', async () => {
    renderViewer()
    // At `xl` the drawer starts open (§224), so the first press closes it.
    expect(screen.getByTestId('viewer-right-panel')).toBeTruthy()
    fireEvent.click(screen.getByTestId('viewer-panel-toggle'))
    await waitFor(() => expect(screen.queryByTestId('viewer-right-panel')).toBeNull())
    fireEvent.click(screen.getByTestId('viewer-panel-toggle'))
    expect(await screen.findByTestId('viewer-right-panel')).toBeTruthy()

    fireEvent.pointerDown(screen.getByTestId('viewer-overflow-trigger'), {
      button: 0, ctrlKey: false, pointerType: 'mouse',
    })
    const menu = await screen.findByTestId('viewer-overflow-menu')
    expect(within(menu).queryByText(/sidebar/i)).toBeNull()
  })

  it('and the Fields tab shows its status row rather than the phone block', async () => {
    renderViewer()
    await screen.findByTestId('viewer-right-panel')
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    expect(screen.queryByTestId('viewer-fields-phone-controls')).toBeNull()
    expect(screen.getByText('Status')).toBeTruthy()
  })
})

// ─── 6. The one JS breakpoint is server-safe ────────────────────────────

describe('§228 — the breakpoint hook', () => {
  it('renders the desktop tree when matchMedia cannot answer (SSR, old browsers)', () => {
    vi.stubGlobal('matchMedia', undefined)
    renderViewer()
    // `false` means "not known to be a phone", so the EXISTING layout is
    // what the server emits and what the first client render agrees with.
    expect(screen.queryByTestId('viewer-phone-layout')).toBeNull()
  })
})
