/**
 * The route gate must not let a request through because the SETUP cookie is
 * missing (§199).
 *
 * The setup check and the auth check are two different questions, and the
 * setup branch used to answer the second one on the first one's behalf: when
 * `ff_setup_done` was absent it fetched /setup/status and, in the
 * not-needed branch, `return`ed a fresh NextResponse.next() — which skipped
 * the token check below entirely. That is every first request from a new
 * browser, after a cookie clear, and after the cookie's own 24h expiry.
 *
 * The API still refused the underlying data, so nothing leaked; but the
 * protected page rendered its shell instead of redirecting to /login, and a
 * gate that lets people through on their first knock is not a gate.
 *
 * Found by FilmBill while checking the route list after porting this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

import { middleware } from '../middleware'

const SETUP_NOT_NEEDED = {
  ok: true,
  json: async () => ({ needs_setup: false }),
} as Response

const SETUP_NEEDED = {
  ok: true,
  json: async () => ({ needs_setup: true }),
} as Response

function request(path: string, cookie?: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(SETUP_NOT_NEEDED)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the setup branch does not answer the auth question', () => {
  it('redirects an unauthenticated request that has no setup cookie', async () => {
    // THE regression. A brand-new browser on a configured instance.
    const res = await middleware(request('/projects'))

    expect(res.status).toBe(307)
    const location = new URL(res.headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('from')).toBe('/projects')
  })

  it('redirects an unauthenticated request that DOES have the setup cookie', async () => {
    // The path that always worked — pinned so a future rewrite cannot fix
    // one branch by breaking the other.
    const res = await middleware(request('/projects', 'ff_setup_done=1'))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })

  it('still asks the API when the cookie is missing', async () => {
    await middleware(request('/projects'))

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/setup/status'),
      expect.anything(),
    )
  })

  it('does not ask the API when the cookie is present', async () => {
    await middleware(request('/projects', 'ff_setup_done=1'))

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('what the setup branch is actually for, unchanged', () => {
  it('redirects to /setup when the instance needs setting up', async () => {
    fetchMock.mockResolvedValue(SETUP_NEEDED)

    const res = await middleware(request('/projects'))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/setup')
  })

  it('redirects to /setup even for an authenticated caller', async () => {
    // Setup outranks auth: a token on an uninitialised instance is not a
    // reason to skip the thing that initialises it.
    fetchMock.mockResolvedValue(SETUP_NEEDED)

    const res = await middleware(request('/projects', 'ff_access_token=abc'))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/setup')
  })

  it('still caches "setup is done" on the response an allowed request gets', async () => {
    // The cookie is the reason the early return existed. It has to survive
    // the fix, or every request would re-hit /setup/status forever.
    const res = await middleware(request('/projects', 'ff_access_token=abc'))

    expect(res.cookies.get('ff_setup_done')?.value).toBe('1')
  })

  it('does not re-set the cookie when it was already present', async () => {
    const res = await middleware(
      request('/projects', 'ff_setup_done=1; ff_access_token=abc'),
    )

    expect(res.cookies.get('ff_setup_done')).toBeUndefined()
  })

  it('lets an authenticated request through', async () => {
    const res = await middleware(request('/projects', 'ff_access_token=abc'))

    expect(res.headers.get('location')).toBeNull()
  })

  it('accepts a refresh token alone, as it always has', async () => {
    const res = await middleware(request('/projects', 'ff_refresh_token=xyz'))

    expect(res.headers.get('location')).toBeNull()
  })
})

describe('an unreachable API still leaves the auth check in charge', () => {
  it('redirects an unauthenticated request when /setup/status throws', async () => {
    // The `catch` used to fall through to the auth check correctly — it is
    // the SUCCESS branch that skipped it. Pinned so the fix did not quietly
    // invert that.
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await middleware(request('/projects'))

    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })

  it('lets an authenticated request through when /setup/status throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))

    const res = await middleware(request('/projects', 'ff_access_token=abc'))

    expect(res.headers.get('location')).toBeNull()
    // Nothing was learned about setup, so nothing is cached.
    expect(res.cookies.get('ff_setup_done')).toBeUndefined()
  })
})

describe('public routes are untouched', () => {
  it.each(['/login', '/setup', '/invite/abc123', '/share/xyz'])(
    'lets %s through with no cookies and no API call',
    async (path) => {
      const res = await middleware(request(path))

      expect(res.headers.get('location')).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
