/**
 * The secure-link sign-in prompt sends the visitor to /login with a way back.
 *
 * It used to link to plain /login, so a viewer who signed in landed on
 * /projects and lost the link. The target is built from the route's token
 * alone and percent-encoded; the login form runs it through `safeNext`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.stubEnv('NEXT_PUBLIC_API_URL', '/api')

import SharePage from '../page'

function answerRequiresAuth() {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ requires_auth: true, title: 'Secret cut', visibility: 'secure', permission: 'view' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('secure link sign-in prompt', () => {
  it('links to /login?from=<encoded /share/{token}>', async () => {
    answerRequiresAuth()
    render(<SharePage params={{ token: 'abc123' }} />)

    const link = await screen.findByRole('link', { name: /sign in to continue/i })
    expect(link.getAttribute('href')).toBe('/login?from=%2Fshare%2Fabc123')
  })

  it('encodes a token that could otherwise change the URL', async () => {
    answerRequiresAuth()
    render(<SharePage params={{ token: 'a?b#c&d' }} />)

    const link = await screen.findByRole('link', { name: /sign in to continue/i })
    const href = link.getAttribute('href')!
    // One `from` parameter, nothing smuggled in beside it, and it decodes
    // back to a path under /share/.
    const params = new URLSearchParams(href.split('?')[1])
    expect(Array.from(params.keys())).toEqual(['from'])
    expect(params.get('from')).toBe('/share/a%3Fb%23c%26d')
    expect(href.startsWith('/login?from=%2Fshare%2F')).toBe(true)
  })
})
