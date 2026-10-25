/**
 * §233b — the login redirect only ever goes somewhere on this origin.
 *
 * `middleware.ts` writes the path you were refused into `?from=` and
 * `app/(auth)/login/page.tsx` followed it with `router.replace(from || …)`.
 * Nothing checked it, so `/login?from=https://evil.com` was an open redirect
 * on a sign-in page — and it fires immediately after that page writes
 * `ff_access_token` into a cookie.
 *
 * The cases below are the ones worth writing down: the plain absolute URL,
 * the two protocol-relative forms a browser treats as one, a scheme, the
 * percent-encodings of those, and — just as important — a real path that
 * must still be followed.
 */
import { describe, it, expect } from 'vitest'

import { DEFAULT_LANDING_PATH, safeNext } from '../safe-next'

describe('safeNext refuses anything that leaves this origin', () => {
  it('refuses a protocol-relative //host', () => {
    // The one most often missed: it has a leading slash and is not a path.
    expect(safeNext('//evil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses a backslash authority /\\host', () => {
    // Browsers normalise the backslash to a slash, so this IS //evil.com.
    expect(safeNext('/\\evil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses a javascript: scheme', () => {
    expect(safeNext('javascript:alert(1)')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses an absolute https URL', () => {
    expect(safeNext('https://evil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses a percent-encoded //host', () => {
    expect(safeNext('%2F%2Fevil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses one that only becomes //host after decoding', () => {
    // A leading slash and nothing obviously wrong until you decode it.
    expect(safeNext('/%2f%2fevil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses a double-encoded //host', () => {
    expect(safeNext('%252F%252Fevil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses an encoded backslash', () => {
    expect(safeNext('/%5Cevil.com')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('%5c%5cevil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses an encoded scheme', () => {
    expect(safeNext('javascript%3Aalert(1)')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('data%3Atext/html,<script>alert(1)</script>')).toBe(
      DEFAULT_LANDING_PATH,
    )
  })

  it('refuses a control character a browser would strip', () => {
    // `/\njavascript:…` and `/\tx` are a different string to a URL parser
    // than they are to a naive startsWith('/') check.
    expect(safeNext('/\njavascript:alert(1)')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('/%09%2F%2Fevil.com')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('/projects\u0000')).toBe(DEFAULT_LANDING_PATH)
  })

  it('refuses a bare host with no scheme at all', () => {
    expect(safeNext('evil.com')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('evil.com/projects')).toBe(DEFAULT_LANDING_PATH)
  })
})

describe('safeNext keeps a real target', () => {
  it('keeps a path with a query string, byte for byte', () => {
    expect(safeNext('/projects/abc?x=1')).toBe('/projects/abc?x=1')
  })

  it('keeps a plain path, a nested one, and a fragment', () => {
    expect(safeNext('/projects')).toBe('/projects')
    expect(safeNext('/projects/abc/assets/def')).toBe('/projects/abc/assets/def')
    expect(safeNext('/settings/admin?tab=branding#top')).toBe(
      '/settings/admin?tab=branding#top',
    )
  })

  it('keeps a path whose query legitimately contains a bare percent', () => {
    // §233 made `%` a literal a search box produces. Its first decoding is
    // `?q=50%` and its second throws, which must not be read as an attack.
    expect(safeNext('/projects?q=50%25')).toBe('/projects?q=50%25')
  })

  it('keeps an encoded space inside a path segment', () => {
    expect(safeNext('/projects/my%20project')).toBe('/projects/my%20project')
  })

  it('keeps the root', () => {
    expect(safeNext('/')).toBe('/')
  })
})

describe('safeNext falls back when there is nothing to use', () => {
  it('falls back for undefined, null and empty', () => {
    expect(safeNext(undefined)).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext(null)).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext('')).toBe(DEFAULT_LANDING_PATH)
  })

  it('uses the caller’s own fallback when one is given', () => {
    // The login page passes its landing path explicitly; other callers
    // may have a different one.
    expect(safeNext('https://evil.com', '/somewhere-else')).toBe('/somewhere-else')
    expect(safeNext(null, '/somewhere-else')).toBe('/somewhere-else')
  })

  it('never returns an empty string, so a caller can redirect to the result', () => {
    for (const input of ['', '  ', null, undefined, '//evil.com', 'javascript:x']) {
      expect(safeNext(input).startsWith('/')).toBe(true)
    }
  })
})

describe('a space is not treated as a control character', () => {
  it('refuses a decoded leading space in front of //host', () => {
    // A browser strips leading whitespace, so ` //evil.com` IS
    // protocol-relative. Refused by the leading-slash rule, not by a
    // blanket ban on spaces — which would have cost the encoded-space
    // target above.
    expect(safeNext('%20%2F%2Fevil.com')).toBe(DEFAULT_LANDING_PATH)
    expect(safeNext(' //evil.com')).toBe(DEFAULT_LANDING_PATH)
  })

  it('keeps a path whose decoding has a space in the middle', () => {
    expect(safeNext('/a%20b/c%20d')).toBe('/a%20b/c%20d')
  })
})
