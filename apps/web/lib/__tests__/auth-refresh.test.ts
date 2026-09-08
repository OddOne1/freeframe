/**
 * §129 — a failed refresh only destroys the session when the server actually
 * rejected the token.
 *
 * The old code cleared tokens in a bare `catch`, which cannot distinguish
 * "this refresh token is dead" from "I could not reach the server".
 * Confirmed live against production: making the refresh endpoint unreachable
 * at the network level — not a 4xx, genuinely unreachable — wiped a valid
 * access+refresh pair with seven days left and redirected to /login.
 *
 * Both branches are covered here, because the fix is only correct if it
 * keeps the old behaviour for a real rejection while dropping it for
 * everything else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const ACCESS = 'ff_access_token'
const REFRESH = 'ff_refresh_token'

let redirectedTo: string | null = null

beforeEach(async () => {
  vi.resetModules()
  vi.useRealTimers()
  redirectedTo = null
  localStorage.clear()
  localStorage.setItem(ACCESS, 'access-old')
  localStorage.setItem(REFRESH, 'refresh-valid')
  // jsdom will not navigate; capture the assignment instead.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { get href() { return '' }, set href(v: string) { redirectedTo = v } },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const tokens = () => ({
  access: localStorage.getItem(ACCESS),
  refresh: localStorage.getItem(REFRESH),
})

async function refresh() {
  const { refreshAccessToken } = await import('../auth')
  return refreshAccessToken()
}

describe('the refresh token was rejected', () => {
  it('clears the session on 401 — the token really is dead', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const result = await refresh()
    expect(result).toBeNull()
    expect(tokens()).toEqual({ access: null, refresh: null })
  })

  it('clears the session on 403 too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    await refresh()
    expect(tokens()).toEqual({ access: null, refresh: null })
  })

  it('sends the user to login, as before', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    await refresh()
    expect(redirectedTo).toBe('/login')
  })

  it('clears when there is no refresh token at all', async () => {
    localStorage.removeItem(REFRESH)
    vi.stubGlobal('fetch', vi.fn())
    await refresh()
    expect(tokens().access).toBeNull()
    expect(redirectedTo).toBe('/login')
  })
})

describe('the server could not be reached', () => {
  it('KEEPS the tokens when fetch rejects — the confirmed bug', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetchMock)

    const result = await refresh()

    expect(result).toBeNull()
    expect(tokens()).toEqual({ access: 'access-old', refresh: 'refresh-valid' })
  })

  it('does not redirect to login on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await refresh()
    expect(redirectedTo).toBeNull()
  })

  it('retries before giving up, rather than failing on the first attempt', async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    vi.stubGlobal('fetch', fetchMock)
    await refresh()
    // One initial attempt plus the backoff steps.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
  })

  it('succeeds if a retry gets through, without the caller knowing', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ access_token: 'access-new', refresh_token: 'refresh-new' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }))

    const result = await refresh()

    expect(result).toBe('access-new')
    expect(tokens()).toEqual({ access: 'access-new', refresh: 'refresh-new' })
  })
})

describe('the server errored', () => {
  it('keeps the tokens on a 500 — that is the server’s problem, not the token’s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    await refresh()
    expect(tokens()).toEqual({ access: 'access-old', refresh: 'refresh-valid' })
    expect(redirectedTo).toBeNull()
  })

  it('keeps the tokens on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))
    await refresh()
    expect(tokens().refresh).toBe('refresh-valid')
  })

  it('keeps the tokens when a 200 body will not parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    const result = await refresh()
    expect(result).toBeNull()
    expect(tokens().refresh).toBe('refresh-valid')
  })
})

describe('a successful refresh', () => {
  it('stores the new pair', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'a2', refresh_token: 'r2' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    expect(await refresh()).toBe('a2')
    expect(tokens()).toEqual({ access: 'a2', refresh: 'r2' })
  })

  it('keeps the existing refresh token when the server does not send a new one', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'a2' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )))
    await refresh()
    expect(tokens()).toEqual({ access: 'a2', refresh: 'refresh-valid' })
  })
})
