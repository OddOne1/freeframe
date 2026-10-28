/**
 * §238 — what the viewer says about a version whose upload never finished.
 *
 * The owner opened his interrupted v6 and was told "Processing failed …
 * Restart processing". Both halves were wrong: nothing had processed, and
 * Restart could never work — the server now refuses it with
 * `upload_incomplete`, because there is no object to process.
 *
 * So the panel reads differently for the two stages the server reports:
 *
 *   failure_stage: "upload"      → "Upload didn't finish", a Delete, and
 *                                  NO Restart
 *   failure_stage: "processing"  → unchanged from before §238: "Processing
 *                                  failed" and Restart processing
 *
 * The page's data sources are stubbed; the markup and the handlers are the
 * real thing, which is where the wrong panel was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AssetResponse, AssetVersion } from '@/types'

const PROJECT = 'proj-1'
const ASSET = 'asset-1'
const ME = 'u1'

let asset: Partial<AssetResponse> | null
let versions: AssetVersion[]

const apiPost = vi.fn(async (_p: string, _b?: unknown) => ({}))
const apiDelete = vi.fn(async (_p: string) => ({}))
const refetchVersions = vi.fn()

vi.mock('@/components/review/review-provider', () => ({
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
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async () => []),
    post: (p: string, b?: unknown) => apiPost(p, b),
    patch: vi.fn(async () => ({})),
    delete: (p: string) => apiDelete(p),
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
  useAuthStore: () => ({ user: { id: ME, name: 'Tester', email: 't@e.com' } }),
}))
// Selector-aware, like the real store: §242's useLiveVersions reads
// `s.files` through a selector to notice this tab's own upload finishing.
vi.mock('@/stores/upload-store', () => {
  const state = { files: [], startUpload: vi.fn(), startVersionUpload: vi.fn() }
  return {
    useUploadStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
  }
})
vi.mock('@/hooks/use-sse', () => ({ useSSE: () => {} }))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ comments: [], isLoading: false, mutate: vi.fn() }),
}))

// Media and panels: jsdom has no codecs, and none of them is what this is
// about. The version switcher has its own tests
// (components/review/__tests__/upload-incomplete-version.test.tsx).
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

import { useReviewStore } from '@/stores/review-store'
import ReviewPage from '../page'

const version = (
  n: number,
  status: string,
  failureStage: AssetVersion['failure_stage'] = null,
  createdBy = ME,
): AssetVersion =>
  ({
    id: `v-${n}`,
    asset_id: ASSET,
    version_number: n,
    processing_status: status,
    failure_stage: failureStage,
    created_by: createdBy,
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    deleted_at: null,
    files: [],
  }) as AssetVersion

function show(current: AssetVersion) {
  versions = [version(5, 'ready'), current]
  useReviewStore.getState().setCurrentVersion(current)
  return render(<ReviewPage params={{ id: PROJECT, assetId: ASSET }} />)
}

beforeEach(() => {
  useReviewStore.getState().reset?.()
  asset = {
    id: ASSET,
    project_id: PROJECT,
    name: 'AdobeStock_1393846473.mov',
    asset_type: 'video',
    status: 'in_review',
    folder_id: null,
  } as Partial<AssetResponse>
  apiPost.mockClear()
  apiDelete.mockClear()
  refetchVersions.mockClear()
})

describe('a version whose upload never finished', () => {
  it('says the upload did not finish, in those words', () => {
    show(version(6, 'failed', 'upload'))

    expect(screen.getByText(/Upload didn’t finish|Upload didn't finish/)).toBeInTheDocument()
    expect(
      screen.getByText(/never fully uploaded, so there is nothing to process/i),
    ).toBeInTheDocument()
  })

  it('does not offer "Restart processing"', () => {
    // THE regression. The server answers 409 `upload_incomplete` now, so
    // offering it could only ever produce an error message.
    show(version(6, 'failed', 'upload'))

    expect(screen.queryByRole('button', { name: /restart processing/i })).toBeNull()
  })

  it('does not call it a processing failure', () => {
    show(version(6, 'failed', 'upload'))

    expect(screen.queryByText(/Processing failed/i)).toBeNull()
  })

  it('offers a delete, and deletes through the §239 route', async () => {
    const user = userEvent.setup()
    show(version(6, 'failed', 'upload'))

    await user.click(screen.getByRole('button', { name: /delete this version/i }))
    // The same confirm every destructive action in the app uses, with the
    // copy an empty version deserves: nothing to lose, and the number
    // comes back.
    expect(await screen.findByText(/Delete v6\?/)).toBeInTheDocument()
    expect(screen.getByText(/frees v6/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Delete version$/ }))

    expect(apiDelete).toHaveBeenCalledWith(`/assets/${ASSET}/versions/v-6`)
  })

  it('shows the server’s refusal instead of pretending it worked', async () => {
    const user = userEvent.setup()
    apiDelete.mockRejectedValueOnce(
      new Error('Storage still holds this version’s file'),
    )
    show(version(6, 'failed', 'upload'))

    await user.click(screen.getByRole('button', { name: /delete this version/i }))
    await user.click(screen.getByRole('button', { name: /^Delete version$/ }))

    expect(await screen.findByText(/Storage still holds/i)).toBeInTheDocument()
  })

  it('says so instead of offering a delete that could only fail', () => {
    // An interrupted FIRST upload: the shell is the asset's only version,
    // and §239 refuses to leave an asset with none. The server's 409
    // (`last_version`) is the authority; saying it here saves a round trip
    // that can only fail, exactly as the version menu does.
    const only = version(1, 'failed', 'upload')
    versions = [only]
    useReviewStore.getState().setCurrentVersion(only)
    render(<ReviewPage params={{ id: PROJECT, assetId: ASSET }} />)

    expect(screen.queryByRole('button', { name: /delete this version/i })).toBeNull()
    expect(screen.getByText(/only version, so it cannot be deleted/i)).toBeInTheDocument()
    expect(screen.getByText(/Delete the file instead/i)).toBeInTheDocument()
  })

  it('offers no delete to someone who may not delete it', () => {
    // Same rule as §239 and as the server's `can_manage_version`: the
    // uploader, the project owner, or an admin. The copy still reads
    // correctly — it just has no button.
    show(version(6, 'failed', 'upload', 'someone-else'))

    expect(screen.queryByRole('button', { name: /delete this version/i })).toBeNull()
    expect(
      screen.getByText(/never fully uploaded, so there is nothing to process/i),
    ).toBeInTheDocument()
  })
})

describe('a version whose PROCESSING failed', () => {
  it('is unchanged: "Processing failed" and a working Restart', async () => {
    const user = userEvent.setup()
    show(version(6, 'failed', 'processing'))

    expect(screen.getByText(/Processing failed/i)).toBeInTheDocument()
    expect(screen.queryByText(/Upload didn’t finish|Upload didn't finish/)).toBeNull()

    await user.click(screen.getByRole('button', { name: /restart processing/i }))

    expect(apiPost).toHaveBeenCalledWith(
      `/assets/${ASSET}/versions/v-6/retry-processing`,
      {},
    )
  })

  it('offers no "Delete this version" button of its own', () => {
    // Deleting a real version stays where §239 put it — in the version
    // menu, with the dialog that says its comments go with it.
    show(version(6, 'failed', 'processing'))

    expect(screen.queryByRole('button', { name: /delete this version/i })).toBeNull()
  })
})

describe('an api that does not send failure_stage yet', () => {
  it('behaves exactly as it did before §238', () => {
    // A rolling deploy, web ahead of api. Absent means "not an upload
    // failure", so the old panel is what shows — not a blank one.
    const legacy = { ...version(6, 'failed') } as AssetVersion
    delete (legacy as { failure_stage?: unknown }).failure_stage
    show(legacy)

    expect(screen.getByText(/Processing failed/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restart processing/i })).toBeInTheDocument()
  })
})
