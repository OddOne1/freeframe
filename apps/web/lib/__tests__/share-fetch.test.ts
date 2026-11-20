/**
 * lib/share-fetch: the viewer's session goes out on a SECURE link's share
 * requests, and on nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setShareLinkVisibility,
  shareFetch,
  throwIfThrottled,
  TooManyRequestsError,
} from '../share-fetch'

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) => new Response('{}'),
)

function sentAuth(call = 0): string | null {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined
  return init?.headers ? new Headers(init.headers).get('Authorization') : null
}

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  setShareLinkVisibility('pub', 'public')
  setShareLinkVisibility('sec', 'secure')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shareFetch', () => {
  it('sends the bearer token on a secure link when signed in', async () => {
    localStorage.setItem('ff_access_token', 'abc')
    await shareFetch('sec', '/share/sec/assets')
    expect(sentAuth()).toBe('Bearer abc')
  })

  it('sends nothing on a public link, even when signed in', async () => {
    localStorage.setItem('ff_access_token', 'abc')
    await shareFetch('pub', '/share/pub/assets')
    expect(fetchMock).toHaveBeenCalledWith('/share/pub/assets')
  })

  it('sends nothing on a secure link when signed out', async () => {
    await shareFetch('sec', '/share/sec/assets')
    expect(fetchMock).toHaveBeenCalledWith('/share/sec/assets')
  })

  it('treats a link it has not been told about as public', async () => {
    localStorage.setItem('ff_access_token', 'abc')
    await shareFetch('never-validated', '/share/never-validated/assets')
    expect(sentAuth()).toBeNull()
  })

  it("keeps the caller's method, body and headers", async () => {
    localStorage.setItem('ff_access_token', 'abc')
    await shareFetch('sec', '/share/sec/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"body":"hi"}',
    })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"body":"hi"}')
    const headers = new Headers(init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer abc')
  })

  it('stops sending once the link is reported public again', async () => {
    localStorage.setItem('ff_access_token', 'abc')
    setShareLinkVisibility('sec', 'public')
    await shareFetch('sec', '/share/sec/assets')
    expect(sentAuth()).toBeNull()
  })
})

describe('throwIfThrottled', () => {
  it('throws TooManyRequestsError with the short message on a 429', () => {
    expect(() => throwIfThrottled(new Response('', { status: 429 }))).toThrow(TooManyRequestsError)
    expect(() => throwIfThrottled(new Response('', { status: 429 }))).toThrow(
      'Too many requests, try again in a minute',
    )
  })

  it('leaves every other status to the caller', () => {
    for (const status of [200, 400, 403, 404, 500]) {
      expect(() => throwIfThrottled(new Response(status === 200 ? '{}' : '', { status }))).not.toThrow()
    }
  })
})
