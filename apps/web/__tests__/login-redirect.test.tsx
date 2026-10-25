/**
 * §233b — the login page itself, not just the helper.
 *
 * `lib/__tests__/safe-next.test.ts` pins what `safeNext` decides. This file
 * pins that the page ASKS it: the open redirect was one line
 * (`router.replace(from || '/projects')`), and a helper nobody calls fixes
 * nothing. Both halves are needed, because either one alone stays green
 * through the mistake the other catches.
 *
 * Only the already-authenticated branch of the page is exercised, because
 * that is the only one that consumes `?from=`. `LoginForm` is stubbed: it
 * pulls in the site-settings hook, the password policy and the whole 2FA
 * flow, none of which has anything to do with where this redirect goes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const replace = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}))

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ needs_setup: false }) },
}))

vi.mock('@/lib/auth', () => ({
  getAccessToken: () => 'an-existing-access-token',
}))

vi.mock('@/components/auth/login-form', () => ({
  LoginForm: () => null,
}))

import LoginPage from '../app/(auth)/login/page'

/** Land on /login with this `from`, render, and report where it sent us. */
async function redirectFor(from: string | null): Promise<string> {
  const search = from === null ? '' : `?from=${encodeURIComponent(from)}`
  window.history.replaceState({}, '', `/login${search}`)
  render(<LoginPage />)
  await waitFor(() => expect(replace).toHaveBeenCalled())
  return replace.mock.calls[0][0] as string
}

beforeEach(() => {
  replace.mockClear()
})

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

describe('the login page redirect', () => {
  it('follows a same-origin path', async () => {
    expect(await redirectFor('/projects/abc?x=1')).toBe('/projects/abc?x=1')
  })

  it('does not follow an absolute URL', async () => {
    expect(await redirectFor('https://evil.com')).toBe('/projects')
  })

  it('does not follow a protocol-relative //host', async () => {
    expect(await redirectFor('//evil.com')).toBe('/projects')
  })

  it('does not follow a backslash authority', async () => {
    expect(await redirectFor('/\\evil.com')).toBe('/projects')
  })

  it('does not follow a javascript: scheme', async () => {
    expect(await redirectFor('javascript:alert(1)')).toBe('/projects')
  })

  it('does not follow an encoded //host', async () => {
    // Passed through unencoded, the way an attacker would put it in the bar.
    window.history.replaceState({}, '', '/login?from=%2F%2Fevil.com')
    render(<LoginPage />)
    await waitFor(() => expect(replace).toHaveBeenCalled())
    expect(replace.mock.calls[0][0]).toBe('/projects')
  })

  it('lands on /projects when there is no from at all', async () => {
    expect(await redirectFor(null)).toBe('/projects')
  })
})
