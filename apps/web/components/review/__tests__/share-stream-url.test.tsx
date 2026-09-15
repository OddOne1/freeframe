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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveApiMediaUrl } from '@/lib/utils'

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

// ─── §186: the SECOND caller, added by §184 ─────────────────────────────────
//
// Everything above covers ReviewProvider's share branch, which is how a
// FOLDER share reaches the player. §184 added a second route — a SINGLE-ASSET
// share link, where app/share/[token]/page.tsx does its own stream fetch and
// hands the result to VideoPlayer as `initialStreamUrl` — and that one
// resolved on the way in, producing the same `/api/api/...` 404 this file was
// written for, in a path it did not know existed.
//
// Read from the source because the component is module-local to a page and
// unexported. Comments are STRIPPED first: the fix explains itself in prose
// that names `resolveApiMediaUrl`, so matching the raw text matches the
// explanation rather than the code — the trap §184's and §185's own tests
// both fell into first.

describe('§186 — the single-asset share page stores the url RAW', () => {
  const RAW = readFileSync(
    join(__dirname, '..', '..', '..', 'app', 'share', '[token]', 'page.tsx'),
    'utf8',
  )
  const PAGE = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

  it('never resolves at the point it stores the stream url', () => {
    /* The §184 regression, exactly: `setStreamUrl(resolveApiMediaUrl(...))`
       put an already-prefixed url into state, and VideoPlayer then prefixed
       it again. */
    const stores = PAGE.match(/setStreamUrl\([^)]*\)/g) ?? []
    expect(stores.length).toBeGreaterThan(0)
    for (const call of stores) {
      expect(call).not.toContain('resolveApiMediaUrl')
    }
  })

  it('does not resolve in the useState initializer either', () => {
    // The initial value is the same hazard by another route.
    const init = PAGE.match(/useState<string \| null>\([^)]*\)/g) ?? []
    for (const call of init) {
      expect(call).not.toContain('resolveApiMediaUrl')
    }
  })

  it('hands SharePlayer the raw state value, unwrapped', () => {
    expect(PAGE).toMatch(/<SharePlayer[^>]*streamUrl=\{streamUrl\}/)
  })

  it('STILL resolves for the bare <audio> tag, which nothing else resolves for', () => {
    /* The other half of the fix: making the video path raw must not strip
       resolution from the paths that genuinely need it. */
    expect(PAGE).toMatch(/<audio\s+src=\{resolveApiMediaUrl\(streamUrl\)/)
  })
})

describe('§186 — what the browser ends up requesting', () => {
  const FROM_API = '/stream/hls/master.m3u8?token=abc'

  it('one prefix when the page stores raw (the fix)', () => {
    expect(playerResolve(FROM_API)).toBe('/api/stream/hls/master.m3u8?token=abc')
  })

  it('two prefixes when the page resolves first (the live 404)', () => {
    /* Pinning the broken composition, so the failure is documented as a
       value rather than as prose. This is the exact string from Mathias's
       Safari console. */
    const preResolved = resolveApiMediaUrl(FROM_API)!
    expect(playerResolve(preResolved)).toBe('/api/api/stream/hls/master.m3u8?token=abc')
  })
})
