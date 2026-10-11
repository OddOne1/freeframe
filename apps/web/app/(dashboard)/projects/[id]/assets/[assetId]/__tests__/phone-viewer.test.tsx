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
/** Records what the page hands the player, so the LUT wiring and the
 *  compact-controls switch can be asserted without a codec. */
const videoProps: Record<string, unknown> = {}
vi.mock('@/components/review/video-player', () => ({
  VideoPlayer: (props: Record<string, unknown>) => {
    Object.assign(videoProps, props)
    return <div data-testid="video-player" />
  },
}))
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
  for (const k of Object.keys(videoProps)) delete videoProps[k]
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

  /** §228b item 3b — the chip is GONE from the tab row on a phone.
   *
   *  §228 put it there so the file's state stayed readable from the
   *  Comments tab; the owner's answer after using it on an iPhone was that
   *  the tab row is not worth 44px for a second copy of something the
   *  Fields tab already holds. Status is one tap away, where version and
   *  rating already live. */
  it('and the status chip is NOT in the tab row any more (§228b item 3b)', () => {
    renderViewer()
    expect(screen.queryByTestId('viewer-comments-status-chip')).toBeNull()
    expect(screen.getByTestId('viewer-panel-tabs')).not.toHaveTextContent(/needs review/i)
  })

  it('but status is still editable, in the Fields tab (§228b item 3b)', async () => {
    renderViewer()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    const status = screen.getByTestId('viewer-fields-status')
    expect(status).toHaveTextContent(/needs review/i)
    openDropdown(within(status).getByRole('button'))
    expect(await screen.findByText('Approved')).toBeTruthy()
  })

  it('and the tab row holds nothing but the three tabs (§228b item 3b)', () => {
    renderViewer()
    const tabs = screen.getByTestId('viewer-panel-tabs')
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Comments', 'Fields', 'Transcript',
    ])
  })
})

describe('§228 — the permission gating is the gating the top bar had', () => {
  it('a viewer gets a read-only status and no rating control', async () => {
    role = 'viewer'
    asset = { ...asset, rating_count: 0, my_rating: null }
    renderViewer()
    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    // §228b — read off the Fields tab's row rather than the tab-row chip,
    // which item 3b removed. Same control, same gating; `readOnly` renders
    // a plain <Badge>, not a dropdown trigger.
    await waitFor(() => {
      const status = screen.getByTestId('viewer-fields-status')
      expect(within(status).queryByRole('button')).toBeNull()
    })
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

// ─── 7. Where the LUT picker lives ──────────────────────────────────────

describe('§228 — the LUT on a phone', () => {
  it('is handed to the player as a sheet sub-page, not as a transport-row toggle', () => {
    renderViewer()
    // The desktop toggle opens a 260px column beside the frame, which on a
    // 390px screen would leave the frame 130px wide.
    expect(videoProps.lutPicker).toBeNull()
    expect(videoProps.lutSheetContent).toBeTruthy()
    expect(videoProps.compactControls).toBe(true)
  })

  it('and the sub-page is the real LutSidebar, driven by the same useLut state', () => {
    renderViewer()
    render(<>{videoProps.lutSheetContent as React.ReactNode}</>)
    expect(screen.getByTestId('lut-sidebar')).toBeTruthy()
  })

  it('while at md+ it is the transport-row toggle and there is no sheet', () => {
    setPhone(false)
    renderViewer()
    expect(videoProps.lutPicker).toBeTruthy()
    expect(videoProps.lutSheetContent).toBeNull()
    expect(videoProps.compactControls).toBe(false)
  })

  it('and the desktop LUT column is not mounted on a phone', () => {
    renderViewer()
    // `lutSidebarOpen` is false in this mock either way; what matters is
    // that the phone branch has no column slot at all.
    expect(screen.getByTestId('viewer-phone-layout').querySelector('[data-testid="lut-sidebar"]')).toBeNull()
  })
})

// ─── 8. §228b item 3 — the phone viewer is compacted ────────────────────
//
// The owner's §228b note: "the viewer is still too tall on a phone".
// What these pin is the SHAPE; the heights are measured in Chromium at
// 390/360/320 (harness/measure.mjs) and are in the §228b report:
//
//                   §228   §228b
//   top bar(s)        93      45   (two rows → one)
//   transport row     56      44
//   tab switch        65      37   (117 at 360/320, where the chip wrapped)
//   "All comments"    64      40
//   composer         123      99
//   comment list     188     324   at 390x844, video

describe('§228b item 3a — the top bar is one row on a phone', () => {
  it('the navigation is in the same row as Back, not under it', async () => {
    renderViewer()
    const nav = await screen.findByTestId('viewer-asset-nav')
    const bar = topBar()
    const back = screen.getByTestId('viewer-back')
    expect(bar.contains(nav)).toBe(true)
    expect(bar.contains(back)).toBe(true)
    // Still two separate controls in two separate groups — the §228 rule
    // the owner's original complaint set, which one row must not undo.
    expect(nav.contains(back)).toBe(false)
  })

  it('and the asset name stands between them', async () => {
    renderViewer()
    const nav = await screen.findByTestId('viewer-asset-nav')
    const kids = Array.from(topBar().children)
    const left = kids.find((k) => k.classList.contains('vbar-left'))!
    expect(left.contains(screen.getByTestId('viewer-back'))).toBe(true)
    expect(left.textContent).toContain('A010C030')
    // Document order: Back + name, then the navigation.
    expect(left.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('the counter is written `n/N`, which is what buys the name its width', async () => {
    renderViewer()
    expect(await screen.findByTestId('viewer-asset-counter')).toHaveTextContent('1/2')
  })

  it('and `n of N` again at md+', async () => {
    setPhone(false)
    renderViewer()
    expect(await screen.findByTestId('viewer-asset-counter')).toHaveTextContent('1 of 2')
  })

  it('the bar itself is shorter below md', () => {
    renderViewer()
    expect(topBar().className).toContain('max-md:min-h-11')
    expect(topBar().className).toContain('min-h-[48px]')
  })

  it('and the action group stops competing with the name for the free space', () => {
    // `flex-1` on a group holding one 36px button took an equal share of
    // the slack: the name had 49px at 360px with it and 124px without.
    renderViewer()
    const right = topBar().querySelector('.vbar-right') as HTMLElement
    expect(right.className).toContain('max-md:flex-none')
    expect(right.className).toContain('flex-1')
  })
})

describe('§228b item 3g — which controls keep 44 and which drop to 36', () => {
  it('Back keeps the full 44 (`viewer-tap`)', () => {
    renderViewer()
    const cls = screen.getByTestId('viewer-back').className
    expect(cls).toMatch(/\bviewer-tap\b/)
    expect(cls).not.toContain('viewer-tap-36')
  })

  it('prev, next and the ⋯ trigger drop to 36 (`viewer-tap-36`)', async () => {
    renderViewer()
    await screen.findByTestId('viewer-asset-nav')
    for (const id of ['viewer-prev-asset', 'viewer-next-asset', 'viewer-overflow-trigger']) {
      expect(screen.getByTestId(id).className, id).toContain('viewer-tap-36')
    }
  })
})

describe('§228b item 3b — the tab switch', () => {
  it('is three tabs and nothing else', () => {
    renderViewer()
    const tabs = screen.getByTestId('viewer-panel-tabs')
    expect(within(tabs).getAllByRole('button')).toHaveLength(3)
    expect(screen.queryByTestId('viewer-comments-status-chip')).toBeNull()
  })

  it('each tab is a 36px button around a 28px pill', () => {
    renderViewer()
    for (const id of ['viewer-tab-comments', 'viewer-tab-fields', 'viewer-tab-transcript']) {
      const b = screen.getByTestId(id)
      expect(b.className, id).toContain('h-9')
      const pill = b.firstElementChild as HTMLElement
      expect(pill.className, id).toContain('h-7')
    }
  })

  it('and they take the full width, with no `flex-wrap` left to make a second row', () => {
    renderViewer()
    const row = screen.getByTestId('viewer-panel-tabs')
    expect(row.className).not.toContain('flex-wrap')
    const pillRow = row.firstElementChild as HTMLElement
    expect(pillRow.className).toContain('w-full')
    // `basis-[200px]` was what let the status chip share the line; with the
    // chip gone the tabs simply take the row.
    expect(pillRow.className).not.toContain('basis-[200px]')
  })

  it('switching tabs still works', () => {
    renderViewer()
    expect(screen.getByTestId('viewer-tab-comments').dataset.active).toBe('true')
    fireEvent.click(screen.getByTestId('viewer-tab-fields'))
    expect(screen.getByTestId('viewer-tab-fields').dataset.active).toBe('true')
    expect(screen.getByTestId('viewer-tab-comments').dataset.active).toBe('false')
  })

  it('and at md+ the switch is the §228 one, padding and all', () => {
    setPhone(false)
    renderViewer()
    const row = screen.getByTestId('viewer-panel-tabs')
    expect(row.className).toContain('px-4 pt-3 pb-2')
    const tab = screen.getByTestId('viewer-tab-fields')
    expect(tab.className).toContain('py-1.5')
    expect(tab.className).not.toContain('h-9')
    // The pill is painted by the button itself, as before — no inner span.
    expect(tab.firstElementChild).toBeNull()
  })
})
