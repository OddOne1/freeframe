/**
 * §139 — an asset's poster thumbnail gets the API prefix exactly once.
 *
 * The live failure was `GET /api/api/stream/hls/thumbnail.jpg?token=...`
 * -> 404 on every normal (authenticated) video asset. Identical in shape to
 * §32's stream_url bug and reachable for the same reason: ReviewProvider
 * resolved thumbnail_url, and VideoPlayer resolves any url starting with
 * "/" itself.
 *
 * The guard both resolvers use is `url.startsWith('/')`, which assumes a
 * resolved url no longer starts with "/". In production
 * NEXT_PUBLIC_API_URL is "/api", so it still does — the guard cannot
 * distinguish resolved from raw, and the only defence is resolving in one
 * place. §32 established that place for stream_url and left thumbnail_url,
 * its sibling in the same function, resolved early in BOTH branches.
 *
 * Both branches are asserted, plus the composition, because the fix works
 * by making the two agree and a later edit "restoring symmetry" the wrong
 * way would bring it back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// With an absolute origin this bug is invisible: a resolved url no longer
// starts with "/" so the second resolve is a no-op. Production is "/api".
vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

const THUMB = '/stream/hls/thumbnail.jpg?token=abc'

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
// The REAL resolution the player applies to the poster, not a copy of it.
import { resolveStreamUrl as playerResolve } from '../video-player'

function ThumbProbe() {
  const { asset } = useReview()
  if (!asset) return null
  return <span data-testid="thumb">{asset.thumbnail_url ?? 'none'}</span>
}

beforeEach(() => {
  apiGet.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            url: '/stream/hls/master.m3u8?token=abc',
            thumbnail_url: THUMB,
            name: 'Clip',
            asset_type: 'video',
            version_id: 'v1',
          }),
      } as unknown as Response),
    ),
  )
})
afterEach(() => vi.unstubAllGlobals())

async function thumbFrom(ui: React.ReactElement) {
  render(ui)
  const el = await screen.findByTestId('thumb')
  return el.textContent!
}

describe('the authenticated branch — the one that 404d all session', () => {
  beforeEach(() => {
    apiGet.mockResolvedValue({
      id: 'a1', name: 'Clip', asset_type: 'video',
      thumbnail_url: THUMB, latest_version: null,
    } as never)
  })

  it('hands the player a RAW thumbnail url', async () => {
    const raw = await thumbFrom(<ReviewProvider assetId="a1"><ThumbProbe /></ReviewProvider>)
    expect(raw).toBe(THUMB)
    expect(raw).not.toContain('/api')
  })

  it('composes with the player into exactly one prefix', async () => {
    const raw = await thumbFrom(<ReviewProvider assetId="a1"><ThumbProbe /></ReviewProvider>)
    // The exact URL the live 404 reported, with one prefix instead of two.
    expect(playerResolve(raw)).toBe('/api/stream/hls/thumbnail.jpg?token=abc')
    expect(playerResolve(raw)).not.toContain('/api/api')
  })
})

describe('the share branch', () => {
  it('hands the player a RAW thumbnail url too', async () => {
    const raw = await thumbFrom(
      <ReviewProvider assetId="a1" shareToken="tok"><ThumbProbe /></ReviewProvider>,
    )
    expect(raw).toBe(THUMB)
    expect(raw).not.toContain('/api')
  })

  it('composes into exactly one prefix', async () => {
    const raw = await thumbFrom(
      <ReviewProvider assetId="a1" shareToken="tok"><ThumbProbe /></ReviewProvider>,
    )
    expect(playerResolve(raw)).toBe('/api/stream/hls/thumbnail.jpg?token=abc')
    expect(playerResolve(raw)).not.toContain('/api/api')
  })

  it('survives the API omitting a thumbnail entirely', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ url: '/stream/hls/m.m3u8', name: 'Clip', asset_type: 'video' }),
    } as unknown as Response)))
    const raw = await thumbFrom(
      <ReviewProvider assetId="a1" shareToken="tok"><ThumbProbe /></ReviewProvider>,
    )
    expect(raw).toBe('none')
  })
})

describe('the resolution rule itself', () => {
  it('is idempotent-hostile — which is why it may only run once', () => {
    // Not a fix, a statement of the constraint the fix exists to respect.
    // If this ever becomes safe to apply twice, the raw-passing above can
    // relax; while it holds, it cannot.
    expect(playerResolve(playerResolve(THUMB))).toBe('/api/api/stream/hls/thumbnail.jpg?token=abc')
  })

  it('leaves an already-absolute url alone', () => {
    expect(playerResolve('https://cdn.example.com/t.jpg')).toBe('https://cdn.example.com/t.jpg')
  })

  it('is the same function the media helper uses', async () => {
    const { resolveApiMediaUrl, resolveStreamUrl } = await import('@/lib/utils')
    expect(resolveStreamUrl(THUMB)).toBe(resolveApiMediaUrl(THUMB))
    // and the player re-exports it rather than keeping a fourth copy
    expect(playerResolve).toBe(resolveStreamUrl)
  })
})
