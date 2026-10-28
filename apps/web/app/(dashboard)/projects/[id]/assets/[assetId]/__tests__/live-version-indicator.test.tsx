/**
 * §242 — the asset page's end of it: the SSE wiring, and the indicator in
 * BOTH places the version switcher lives.
 *
 * `useLiveVersions` has its own tests (hooks/__tests__/use-live-versions.
 * test.tsx) covering the debounce, the poll and the diff. What those cannot
 * see is whether this page connects any of it: the project channel is
 * already open here for the transcript and the LUT exports, and §242 adds
 * three handlers to that same connection rather than a second EventSource.
 * Drop them and the owner's dropdown goes stale again with every test still
 * green — hence this file.
 *
 * The second half is the switcher's two call sites. On a phone the version
 * control is not in the top bar at all: §228 moved it into the Fields tab.
 * It is the same component, so a `newVersionIds` handed to one and not the
 * other is exactly the kind of omission that ships.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import type { UseSSEOptions } from '@/hooks/use-sse'
import type { AssetResponse, AssetVersion } from '@/types'

const PROJECT = 'proj-1'
const ASSET = 'asset-1'
const ME = 'u1'
const THEM = 'u2'

let asset: Partial<AssetResponse> | null
/** What the page's provider currently holds. */
let versions: AssetVersion[]
/** What the server would answer with now — the refetch copies this over. */
let serverVersions: AssetVersion[]

const refetchVersions = vi.fn(async () => {
  versions = serverVersions
})

/** The options the page hands `useSSE` — i.e. the fake SSE source. */
let sse: Record<string, ((data: never) => void) | undefined> = {}

const apiGet = vi.fn(async (path: string) => {
  if (path.includes('/members')) return [{ id: 'pm1', project_id: PROJECT, user_id: ME, role: 'owner' }]
  if (path.startsWith('/users?')) return [{ id: ME, name: 'Tester', email: 't@e.com' }]
  return []
})
const apiPost = vi.fn(async (_p: string, _b?: unknown) => ({}))

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
      refetchVersions,
      pauseVideo: vi.fn(),
      registerPauseHandler: vi.fn(),
    }),
  }
})

vi.mock('@/lib/api', () => ({
  api: {
    get: (p: string) => apiGet(p),
    post: (p: string, b?: unknown) => apiPost(p, b),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}/assets/${ASSET}`,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { id: ME, name: 'Tester', email: 't@e.com' }, isSuperAdmin: false }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: (sel: (s: unknown) => unknown) =>
    sel ? sel({ startVersionUpload: vi.fn(), files: [] }) : { startVersionUpload: vi.fn(), files: [] },
}))

// The fake SSE source: whatever the page registers is kept, and a test
// fires it by hand.
vi.mock('@/hooks/use-sse', () => ({
  useSSE: (_projectId: string | null | undefined, options: UseSSEOptions) => {
    sse = options as unknown as typeof sse
    return { isConnected: true, lastEvent: null }
  },
}))
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

// jsdom has no codecs. The version switcher is deliberately NOT mocked —
// it is half of what this file is about.
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => <div data-testid="video-player" /> }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => null }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => <div data-testid="comment-panel" /> }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => <div data-testid="comment-input" /> }))
vi.mock('@/components/review/transcript-panel', () => ({ TranscriptPanel: () => null }))
vi.mock('@/components/review/sidecar-metadata', () => ({ SidecarMetadata: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/lut-sidebar', () => ({
  LutSidebar: () => null,
  LutSidebarToggle: () => null,
  useLutSidebarOpen: () => [false, vi.fn()],
}))
vi.mock('@/hooks/use-lut', () => ({
  useLut: () => ({ supported: false, selectedId: null, select: vi.fn(), luts: [], isLoading: false, isLoadingCube: false }),
}))

import { SWRConfig } from 'swr'
import { useReviewStore } from '@/stores/review-store'
import ReviewPage from '../page'

const version = (n: number, createdBy: string, status: AssetVersion['processing_status'] = 'ready') =>
  ({
    id: `ver-${n}`,
    asset_id: ASSET,
    version_number: n,
    processing_status: status,
    failure_stage: null,
    created_by: createdBy,
    created_at: '2026-10-28T09:00:00Z',
    deleted_at: null,
    files: [],
  }) as AssetVersion

/** jsdom has no media queries — the viewer's two breakpoints read this. */
function setPhone(isPhone: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((q: string) => ({
      matches: q.includes('max-height: 500px') ? false : q.includes('max-width: 767px') ? isPhone : !isPhone,
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
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ReviewPage params={{ id: PROJECT, assetId: ASSET }} />
    </SWRConfig>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sse = {}
  asset = {
    id: ASSET,
    project_id: PROJECT,
    name: 'take07.mov',
    asset_type: 'video',
    status: 'in_review',
    folder_id: null,
  } as Partial<AssetResponse>
  versions = [version(7, THEM)]
  serverVersions = versions
  useReviewStore.getState().reset()
  useReviewStore.getState().setCurrentVersion(versions[0])
  setPhone(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the page’s version-event wiring', () => {
  it('registers the three transcode handlers on the channel it already has', async () => {
    renderViewer()
    await screen.findByTestId('comment-input')

    expect(typeof sse.onTranscodeComplete).toBe('function')
    expect(typeof sse.onTranscodeFailed).toBe('function')
    expect(typeof sse.onTranscodeProgress).toBe('function')
  })

  it('re-reads the version list when THIS asset’s transcode finishes', async () => {
    renderViewer()
    await screen.findByTestId('comment-input')

    sse.onTranscodeComplete?.({ asset_id: ASSET, version_id: 'ver-8' } as never)
    expect(refetchVersions).toHaveBeenCalledTimes(1)
  })

  it('and ignores the rest of the project’s traffic', async () => {
    renderViewer()
    await screen.findByTestId('comment-input')

    sse.onTranscodeComplete?.({ asset_id: 'asset-9', version_id: 'x' } as never)
    sse.onTranscodeProgress?.({ asset_id: 'asset-9', percent: 12 } as never)
    expect(refetchVersions).not.toHaveBeenCalled()
  })
})

describe('the indicator, in both of the switcher’s homes', () => {
  /** A colleague's v9 lands and the list the page is holding catches up. */
  async function colleagueUploads(rerender: () => void) {
    serverVersions = [version(7, THEM), version(9, THEM)]
    sse.onTranscodeComplete?.({ asset_id: ASSET, version_id: 'ver-9' } as never)
    await waitFor(() => expect(versions).toHaveLength(2))
    rerender()
  }

  it('shows nothing for a version that was already there when the page opened', async () => {
    versions = [version(7, THEM), version(9, THEM)]
    serverVersions = versions
    renderViewer()
    await screen.findByTestId('comment-input')

    expect(screen.queryByTestId('new-version-dot')).not.toBeInTheDocument()
  })

  it('puts the dot on the top-bar switcher (desktop)', async () => {
    const { rerender } = renderViewer()
    await screen.findByTestId('comment-input')
    expect(screen.queryByTestId('new-version-dot')).not.toBeInTheDocument()

    await colleagueUploads(() =>
      rerender(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ReviewPage params={{ id: PROJECT, assetId: ASSET }} />
        </SWRConfig>,
      ),
    )

    const dot = await screen.findByTestId('new-version-dot')
    expect(dot).toHaveAttribute('aria-label', 'New version v9 available')
    // Inside the bar's own switcher, not somewhere else on the page.
    expect(within(screen.getByTestId('viewer-top-bar')).getByTestId('new-version-dot')).toBe(dot)
  })

  it('and on the phone switcher, which lives in the Fields tab (§228)', async () => {
    setPhone(true)
    const { rerender } = renderViewer()
    await screen.findByTestId('comment-input')

    await colleagueUploads(() =>
      rerender(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ReviewPage params={{ id: PROJECT, assetId: ASSET }} />
        </SWRConfig>,
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Fields' }))
    const row = screen.getByTestId('viewer-fields-version')
    expect(within(row).getByTestId('new-version-dot')).toHaveAttribute(
      'aria-label',
      'New version v9 available',
    )
  })
})
