/**
 * The viewer's back arrow returns to the folder the asset lives in (§179).
 *
 * It was a plain link hardcoded to `/projects/{id}`, so opening an asset
 * from a subfolder and pressing back dropped the user at the project root
 * — however deep they had been.
 *
 * Deliberately NOT `router.back()`: the history stack only holds the right
 * entry when the user clicked their way here, and this page is routinely
 * opened cold (a shared link to one asset, a refresh, a new tab). The href
 * is reconstructed from `asset.folder_id` instead, which is the same field
 * the header breadcrumb in this file already builds its links from.
 *
 * The page's data sources are stubbed; its markup is the real thing, which
 * is where the bug was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { AssetResponse } from '@/types'

const PROJECT = 'proj-1'
const DEEP_FOLDER = 'folder-grandchild'

let asset: Partial<AssetResponse> | null

vi.mock('@/components/review/review-provider', () => ({
  ReviewProvider: ({ children }: { children: React.ReactNode }) => children,
  useReview: () => ({
    assetId: 'asset-1',
    asset,
    versions: [],
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
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    upload: vi.fn(async () => ({})),
  },
  ApiError: class extends Error {},
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/projects/${PROJECT}/assets/asset-1`,
}))

vi.mock('@/stores/auth-store', () => ({
  useAuthStore: () => ({ user: { id: 'u1', name: 'Tester', email: 't@e.com' } }),
}))
vi.mock('@/stores/upload-store', () => ({
  useUploadStore: () => ({ files: [], startUpload: vi.fn() }),
}))
vi.mock('@/hooks/use-sse', () => ({ useSSE: () => {} }))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ comments: [], isLoading: false, mutate: vi.fn() }),
}))

// Media and panels: each fetches or touches APIs jsdom has none of, and
// none of them is what this test is about.
vi.mock('@/components/review/video-player', () => ({ VideoPlayer: () => null }))
vi.mock('@/components/review/audio-player', () => ({ AudioPlayer: () => null }))
vi.mock('@/components/review/image-viewer', () => ({ ImageViewer: () => null }))
vi.mock('@/components/review/compare/compare-overlay', () => ({ CompareOverlay: () => null }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/annotation-overlay', () => ({ AnnotationOverlay: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))
vi.mock('@/components/review/transcript-panel', () => ({ TranscriptPanel: () => null }))
vi.mock('@/components/review/sidecar-metadata', () => ({ SidecarMetadata: () => null }))
vi.mock('@/components/review/version-switcher', () => ({ VersionSwitcher: () => null }))
vi.mock('@/components/review/share-dialog', () => ({ ShareDialog: () => null }))
vi.mock('@/components/review/lut-sidebar', () => ({
  LutSidebar: () => null,
  LutSidebarToggle: () => null,
  useLutSidebarOpen: () => [false, vi.fn()],
}))
vi.mock('@/hooks/use-lut', () => ({
  useLut: () => ({ selectedId: null, select: vi.fn(), luts: [] }),
}))

import ReviewPage from '../page'

function backLink(): HTMLAnchorElement {
  return screen.getByRole('link', { name: /back to folder/i }) as HTMLAnchorElement
}

beforeEach(() => {
  asset = {
    id: 'asset-1',
    project_id: PROJECT,
    name: 'shot_042.mov',
    asset_type: 'video',
    status: 'in_review',
    folder_id: DEEP_FOLDER,
  } as Partial<AssetResponse>
})

describe('the back arrow', () => {
  it('returns to the folder the asset is in, two levels deep', () => {
    render(<ReviewPage params={{ id: PROJECT, assetId: 'asset-1' }} />)

    expect(backLink().getAttribute('href')).toBe(
      `/projects/${PROJECT}?folder=${DEEP_FOLDER}`,
    )
  })

  it('does not drop the user at the project root', () => {
    render(<ReviewPage params={{ id: PROJECT, assetId: 'asset-1' }} />)

    // The exact regression: a bare project URL, whatever folder it was
    // opened from.
    expect(backLink().getAttribute('href')).not.toBe(`/projects/${PROJECT}`)
  })

  it('goes to the project root for an asset that really is at the root', () => {
    asset = { ...asset, folder_id: null }
    render(<ReviewPage params={{ id: PROJECT, assetId: 'asset-1' }} />)

    // No `?folder=` at all — an empty param would be a different page state
    // than "no folder selected".
    expect(backLink().getAttribute('href')).toBe(`/projects/${PROJECT}`)
  })

  it('is a real link, so it works cold — no history entry required', () => {
    /* `router.back()` would pass a click test while failing exactly the
       cases this page is opened in most: a shared asset link, a refresh, a
       new tab. An <a href> cannot depend on the history stack. */
    render(<ReviewPage params={{ id: PROJECT, assetId: 'asset-1' }} />)

    expect(backLink().tagName).toBe('A')
    expect(backLink().getAttribute('href')).toBeTruthy()
  })
})
