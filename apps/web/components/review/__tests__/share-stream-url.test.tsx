/**
 * A folder-share video's stream URL gets the API prefix exactly once
 * (CLAUDE.md §32).
 *
 * The live failure was `GET /api/api/stream/hls/master.m3u8?token=...` ->
 * 404. Two correct-looking resolutions composed into a wrong one:
 * ReviewProvider's share branch resolved the URL, and VideoPlayer resolves
 * any stream URL starting with "/" itself.
 *
 * Both halves are asserted, plus the composition — the bug is invisible in
 * either file read alone, which is why it survived. The authenticated
 * branch is asserted too, because the fix works by making the two branches
 * agree, and a later edit "restoring symmetry" the other way would
 * reintroduce it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

// Production builds NEXT_PUBLIC_API_URL as "/api" (docker-compose.prod.yml:181).
// With an absolute origin the bug is invisible, because a resolved URL no
// longer starts with "/" and neither layer touches it again.
vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

const HLS_PATH = '/stream/hls/master.m3u8?token=abc'

const apiGet = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    get: (...a: unknown[]) => apiGet(...a),
    post: vi.fn(), patch: vi.fn(), delete: vi.fn(), upload: vi.fn(),
  },
}))

vi.mock('@/stores/review-store', () => ({
  useReviewStore: () => ({
    setCurrentAsset: vi.fn(),
    setCurrentVersion: vi.fn(),
    setPlayheadTime: vi.fn(),
    currentVersion: null,
    isDrawingMode: false,
    focusedCommentId: null,
  }),
}))

import { ReviewProvider, useReview } from '../review-provider'

function StreamUrlProbe() {
  const { asset } = useReview()
  if (!asset) return null
  return <span data-testid="stream-url">{(asset as { stream_url?: string }).stream_url ?? 'none'}</span>
}

// The REAL resolution the player applies, not a copy of it. A copy passed
// happily while the player's own logic was mutated away — which is the
// whole failure mode this test exists to catch.
import { resolveStreamUrl as playerResolve } from '../video-player'

beforeEach(() => {
  apiGet.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ url: HLS_PATH, name: 'Clip', asset_type: 'video', version_id: 'v1' }),
      } as unknown as Response),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('share mode hands the player a RAW stream url', () => {
  it('stores the url unresolved, leaving the one resolve to the player', async () => {
    render(
      <ReviewProvider assetId="a1" shareToken="tok">
        <StreamUrlProbe />
      </ReviewProvider>,
    )
    const el = await screen.findByTestId('stream-url')
    expect(el.textContent).toBe(HLS_PATH)
    expect(el.textContent).not.toContain('/api')
  })

  it('composes with the player into exactly one prefix', async () => {
    render(
      <ReviewProvider assetId="a1" shareToken="tok">
        <StreamUrlProbe />
      </ReviewProvider>,
    )
    const el = await screen.findByTestId('stream-url')
    // The exact URL the live 404 reported, with one prefix instead of two.
    expect(playerResolve(el.textContent!)).toBe('/api/stream/hls/master.m3u8?token=abc')
    expect(playerResolve(el.textContent!)).not.toContain('/api/api')
  })
})

describe('the authenticated branch is not changed by the fix', () => {
  it('also leaves stream_url alone, which is why it never 404d', async () => {
    // `stream_url` is not on AssetResponse — the authenticated /assets/{id}
    // response carries it in practice and the provider spreads it through
    // untouched, which is exactly the behaviour under test.
    apiGet.mockResolvedValue({
      id: 'a1',
      name: 'Clip',
      asset_type: 'video',
      stream_url: HLS_PATH,
      thumbnail_url: '/media/t.jpg',
      latest_version: null,
    } as never)
    render(
      <ReviewProvider assetId="a1">
        <StreamUrlProbe />
      </ReviewProvider>,
    )
    const el = await screen.findByTestId('stream-url')
    expect(el.textContent).toBe(HLS_PATH)
    expect(playerResolve(el.textContent!)).not.toContain('/api/api')
  })
})

describe('the player itself still resolves', () => {
  it('adds the prefix to a relative url', () => {
    expect(playerResolve(HLS_PATH)).toBe(`/api${HLS_PATH}`)
  })

  it('leaves an absolute url alone', () => {
    expect(playerResolve('https://cdn.example/m.m3u8')).toBe('https://cdn.example/m.m3u8')
  })
})

describe('the composition end to end', () => {
  it('a share-mode stream url survives both layers with one prefix', async () => {
    render(
      <ReviewProvider assetId="a1" shareToken="tok">
        <StreamUrlProbe />
      </ReviewProvider>,
    )
    const raw = (await screen.findByTestId('stream-url')).textContent!
    // What the browser would actually request.
    expect(playerResolve(raw)).toBe('/api/stream/hls/master.m3u8?token=abc')
  })
})
