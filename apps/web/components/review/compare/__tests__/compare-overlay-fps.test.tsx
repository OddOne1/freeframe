/**
 * CompareOverlay hands each pane its OWN frame rate (upstream issue #183).
 *
 * Separate file because it mocks the transport wholesale to capture what the
 * overlay passes it. The point is the seam: compare-overlay.test.tsx gives both
 * versions the same fps, so a blended value and a per-side one are identical
 * there and the bug is invisible — which is how it survived upstream.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

const transportArgs: Array<Record<string, unknown>> = []
vi.mock('../use-synced-transport', () => ({
  useSyncedTransport: (args: Record<string, unknown>) => {
    transportArgs.push(args)
    return {
      t: 0, total: 60, isPlaying: false, toggle: vi.fn(), seekTo: vi.fn(),
      playerA: { videoRef: { current: null } },
      playerB: { videoRef: { current: null } },
    }
  },
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => '/projects/p1/assets/a1',
  useSearchParams: () => new URLSearchParams('compare=v-1&compareRight=v-3'),
}))
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({
    comments: [], createComment: vi.fn(), resolveComment: vi.fn(), deleteComment: vi.fn(),
    addReaction: vi.fn(), removeReaction: vi.fn(),
  }),
}))
vi.mock('@/hooks/use-stream-url', () => ({ useStreamUrl: () => ({ url: '/s.m3u8', error: false }) }))
vi.mock('@/components/review/annotation-canvas', () => ({ AnnotationCanvas: () => null }))
vi.mock('@/components/review/comment-panel', () => ({ CommentPanel: () => null }))
vi.mock('@/components/review/comment-input', () => ({ CommentInput: () => null }))

import { CompareOverlay } from '../compare-overlay'

const videoAsset = { id: 'a1', project_id: 'p1', asset_type: 'video', name: 'clip' } as never

/** Two versions that genuinely differ in frame rate — a re-export or conform.
 *  `fps: null` is the pre-backfill shape: the field is absent, not zero. */
function version(n: number, fps: number | null) {
  return {
    id: `v-${n}`, asset_id: 'a1', version_number: n, processing_status: 'ready',
    created_at: new Date().toISOString(),
    files: [fps === null ? { duration_seconds: 60 } : { fps, duration_seconds: 60 }],
  } as never
}

beforeEach(() => {
  transportArgs.length = 0
  // jsdom implements neither; VideoFrameConstraint observes its pane and
  // scrollIntoView is called on focus.
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

describe('per-side fps reaches the transport (#183)', () => {
  it('passes each version its own rate, not one blended value', () => {
    render(
      <CompareOverlay
        asset={videoAsset}
        versions={[version(1, 24), version(3, 60)]}
        rightVersion={version(3, 60)}
        onClose={vi.fn()}
      />,
    )
    const args = transportArgs.at(-1)!
    expect(args.fpsA).toBe(24)
    expect(args.fpsB).toBe(60)
    // The bug, stated: upstream sent `mediaB.fps ?? mediaA.fps` to BOTH sides,
    // so the 24fps pane was slaved with a 60fps tolerance.
    expect(args.fpsA).not.toBe(args.fpsB)
  })

  it('a side with no stored rate passes null rather than borrowing the other', () => {
    // Pre-backfill files have no fps. frameStep(null) is a real ~25fps frame;
    // silently inheriting the other side's rate would be a guess presented as
    // a measurement.
    render(
      <CompareOverlay
        asset={videoAsset}
        versions={[version(1, null), version(3, 60)]}
        rightVersion={version(3, 60)}
        onClose={vi.fn()}
      />,
    )
    const args = transportArgs.at(-1)!
    expect(args.fpsA ?? null).toBeNull()
    expect(args.fpsB).toBe(60)
  })
})
