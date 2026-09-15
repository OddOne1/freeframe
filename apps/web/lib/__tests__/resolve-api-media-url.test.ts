/**
 * Resolving a media URL is idempotent (§187).
 *
 * The rule is still "resolve in exactly one place", and §186 restored that
 * at every caller. This covers the backstop underneath it: applying the
 * rule twice must be a no-op rather than a 404.
 *
 * Why the production shape is the only one that proves anything: in dev
 * NEXT_PUBLIC_API_URL is an absolute origin, so a resolved URL no longer
 * starts with "/" and the original guard already caught a second pass by
 * accident. In production it is "/api", a resolved URL still starts with
 * "/", and the two became indistinguishable. Every test here that matters
 * stubs "/api" — a dev-shaped test would have passed against the old,
 * broken function.
 *
 * Four occurrences: §32 (stream_url), §139 (thumbnail_url), §184 (the
 * single-asset share page), and the FolderAssetViewer instance §186 found
 * while auditing that one.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'

import { resolveApiMediaUrl, resolveStreamUrl } from '../utils'

/** Exactly what the media proxy returns (`proxy_url_for`). */
const RAW = '/stream/hls/master.m3u8?token=abc'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('production shape (NEXT_PUBLIC_API_URL = "/api")', () => {
  it('resolves a raw url once', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl(RAW)).toBe('/api/stream/hls/master.m3u8?token=abc')
  })

  it('is a NO-OP the second time, instead of doubling the prefix', () => {
    /* The §184 failure, at the layer beneath it. This is the assertion the
       whole change exists for. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    const once = resolveApiMediaUrl(RAW)!
    const twice = resolveApiMediaUrl(once)

    expect(twice).toBe(once)
    expect(twice).not.toContain('/api/api')
  })

  it('stays stable however many times it is applied', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    const result = resolveApiMediaUrl(
      resolveApiMediaUrl(resolveApiMediaUrl(RAW)!)!,
    )

    expect(result).toBe('/api/stream/hls/master.m3u8?token=abc')
  })

  it('reproduces the exact url from the live 404, and no longer produces it', () => {
    /* `GET /api/api/stream/hls/master.m3u8?token=... 404`, from Safari's
       console. Pinned as a value so the regression is recognisable. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl('/api/stream/hls/master.m3u8?token=abc')).not.toBe(
      '/api/api/stream/hls/master.m3u8?token=abc',
    )
  })

  it('resolveStreamUrl gets the same treatment', () => {
    /* The player's entry point. Both names reach one implementation, and a
       fix that covered only one of them would leave the actual video path
       broken. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    const once = resolveStreamUrl(RAW)
    expect(resolveStreamUrl(once)).toBe(once)
  })
})

describe('the no-op guard does not over-match', () => {
  it('still resolves a raw path that merely STARTS with the origin text', () => {
    /* With origin "/api", a bare `startsWith` would treat "/apiary/..." as
       already resolved and leave it unresolved — trading a doubled prefix
       for a missing one. The match is at a path boundary. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl('/apiary/photo.jpg')).toBe('/api/apiary/photo.jpg')
  })

  it('still resolves a path whose first segment merely contains the origin', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl('/api-docs/x.png')).toBe('/api/api-docs/x.png')
  })

  it('leaves a url that IS exactly the origin alone', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl('/api')).toBe('/api')
  })
})

describe('dev shape (absolute origin)', () => {
  it('resolves a raw url', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000')

    expect(resolveApiMediaUrl(RAW)).toBe(`http://localhost:8000${RAW}`)
  })

  it('is a no-op the second time here too', () => {
    /* Already true before §187 — a resolved url stops starting with "/" —
       which is exactly why this bug class never showed up locally. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:8000')

    const once = resolveApiMediaUrl(RAW)!
    expect(resolveApiMediaUrl(once)).toBe(once)
  })
})

describe('unchanged behaviour', () => {
  it('leaves a fully absolute third-party url alone', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl('https://cdn.example/clip.m3u8')).toBe(
      'https://cdn.example/clip.m3u8',
    )
  })

  it('passes an empty value straight through, unprefixed', () => {
    /* `'' ` comes back as `''` rather than null — `url ?? null` only
       converts undefined. Pre-existing and asserted as-is: what matters
       here is that no origin gets prepended to nothing, which would
       produce a bare "/api" pointing at the API root. */
    vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

    expect(resolveApiMediaUrl(null)).toBeNull()
    expect(resolveApiMediaUrl(undefined)).toBeNull()
    expect(resolveApiMediaUrl('')).toBe('')
  })
})
